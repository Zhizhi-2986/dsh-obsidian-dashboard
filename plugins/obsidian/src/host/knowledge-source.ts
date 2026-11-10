/** Knowledge source runtime: index sync + change watching.
 *
 * One runtime per configured source. `sync()` walks the directory tree and
 * upserts changed docs into the shared `KnowledgeIndex` (mtime-diffed);
 * the watcher (node:fs.watch, recursive on darwin, else fallback polling)
 * triggers debounced incremental syncs. The index database survives plugin
 * hot reloads (settings edits reload the plugin fiber); the runtime state
 * is rebuilt from disk on each apply.
 */

import { watch as watchFs, promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { KnowledgeSourceConfig } from '../shared/settings-contract.ts'
import { sourceRootIdentityMatches } from './source-path.ts'
import { readSourceFileText } from './read-file.ts'
import { resolveContainedPath } from './source-path.ts'
import { digestNote } from './markdown.ts'
import { KnowledgeIndex } from './indexer.ts'
import { fileStemOf, scanSource, toSourceRel, type ScanOptions } from './scanner.ts'

export interface SourceSyncState {
  readonly indexedAt: number | null
  readonly fileCount: number
  readonly lastError: string | null
}

const SYNC_DEBOUNCE_MS = 500
const FALLBACK_POLL_MS = 30_000

export class KnowledgeSourceRuntime {
  readonly source: KnowledgeSourceConfig
  readonly #index: KnowledgeIndex
  readonly #watchFactory: (root: string) => ReturnType<typeof watchFs> | null
  #state: SourceSyncState = { indexedAt: null, fileCount: 0, lastError: null }
  #watcher: ReturnType<typeof watchFs> | null = null
  #debounce: ReturnType<typeof setTimeout> | null = null
  #fallbackPoll: ReturnType<typeof setInterval> | null = null
  #pending = new Set<string>()
  #syncChain: Promise<void> = Promise.resolve()
  #stopped = false

  constructor(source: KnowledgeSourceConfig, index: KnowledgeIndex, watchFactory = fsWatchRecursive) {
    this.source = source
    this.#index = index
    this.#watchFactory = watchFactory
  }

  get state(): SourceSyncState {
    return this.#state
  }

  startWatch(): void {
    if (this.#stopped) return
    // Recursive watch is supported on darwin/win32; try it, else poll.
    try {
      const watcher = this.#watchFactory(this.source.path)
      if (watcher !== null) {
        this.#watcher = watcher
        watcher.on('change', (_event, filename) => {
          if (typeof filename !== 'string' || filename === '') return
          const rel = normalizeEventPath(filename)
          this.#schedule(rel)
        })
        watcher.on('error', () => {
          // watcher died (e.g. root removed); poll until it can be restarted.
          if (this.#watcher !== watcher) return
          watcher.close()
          this.#watcher = null
          this.#startFallbackPoll()
        })
        return
      }
    } catch {
      // fall through to polling
    }
    this.#startFallbackPoll()
  }

  #startFallbackPoll(): void {
    if (this.#stopped || this.#fallbackPoll !== null) return
    this.#fallbackPoll = setInterval(() => { void this.#queueSync(null).catch(() => undefined) }, FALLBACK_POLL_MS)
    this.#fallbackPoll.unref?.()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#watcher?.close()
    this.#watcher = null
    if (this.#fallbackPoll !== null) clearInterval(this.#fallbackPoll)
    this.#fallbackPoll = null
    if (this.#debounce !== null) clearTimeout(this.#debounce)
    this.#debounce = null
    await this.#syncChain
  }

  #schedule(relPath: string): void {
    this.#pending.add(relPath)
    if (this.#debounce !== null) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => {
      this.#debounce = null
      const batch = [...this.#pending]
      this.#pending.clear()
      void this.#queueSync(batch).catch(() => undefined)
    }, SYNC_DEBOUNCE_MS)
    this.#debounce.unref?.()
  }

  /** Walk the source; only changed docs are reindexed. Resolves the current
   *  state; errors are recorded in `lastError` and rethrown to callers. */
  async sync(): Promise<SourceSyncState> {
    await this.#queueSync(null)
    return this.#state
  }

  #queueSync(relPaths: readonly string[] | null): Promise<void> {
    const run = () => this.#syncPath(relPaths)
    const task = this.#syncChain.then(run, run)
    this.#syncChain = task.then(() => undefined, () => undefined)
    return task
  }

  async #syncPath(relPaths: readonly string[] | null): Promise<void> {
    if (this.#stopped) return
    const started = Date.now()
    try {
      await this.#assertRootIdentity()
      const scanOptions: ScanOptions = {
        include: this.source.include,
        exclude: this.source.exclude,
      }
      if (relPaths !== null) {
        // Incremental: reindex only the reported paths (mtime-diffed).
        let changed = 0
        for (const rel of dedupe(relPaths)) {
          let pathInfo
          try {
            pathInfo = await fs.lstat(path.join(this.source.path, rel))
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error
            const hasIndexedDescendants = [...this.#index.knownPaths(this.source.id)].some((known) => known.startsWith(`${rel}/`))
            if (hasIndexedDescendants) return await this.#syncPath(null)
            this.#index.deleteDoc(this.source.id, rel)
            changed++
            continue
          }
          if (pathInfo.isSymbolicLink()) throw Object.assign(new Error('indexed path became a symbolic link'), { code: 'OUTSIDE_SOURCE' })
          if (pathInfo.isDirectory()) return await this.#syncPath(null)
          if (!pathInfo.isFile()) {
            this.#index.deleteDoc(this.source.id, rel)
            changed++
            continue
          }
          const safePath = await resolveContainedPath(this.source.path, rel)
          if (safePath === null) throw Object.assign(new Error('indexed path left the configured source'), { code: 'OUTSIDE_SOURCE' })
          const stat = await fs.stat(safePath)
          const existing = this.#index.getDoc(this.source.id, rel)
          if (existing !== null && existing.mtimeMs === stat.mtimeMs) continue
          await this.#indexFile(rel, stat.mtimeMs)
          changed++
        }
        if (changed === 0) return
        // Refresh the link graph against the new known-path set. This also
        // removes backlinks to deleted files and resolves links to new files.
        await this.#rebuildLinks([...this.#index.knownPaths(this.source.id)])
      } else {
        const files = await scanSource(this.source.path, scanOptions)
        await this.#assertRootIdentity()
        const seen = new Set<string>()
        const known = this.#index.knownPaths(this.source.id)
        let added = 0
        for (const file of files) {
          seen.add(file.relPath)
          const existing = this.#index.getDoc(this.source.id, file.relPath)
          if (existing !== null && existing.mtimeMs === file.mtimeMs) continue
          await this.#indexFile(file.relPath, file.mtimeMs)
          added++
        }
        // Remove docs that vanished from disk.
        for (const rel of known) {
          if (!seen.has(rel)) this.#index.deleteDoc(this.source.id, rel)
        }
        // Rebuild links for every doc (link graph needs the full path set).
        await this.#rebuildLinks(files.map((file) => file.relPath))
        if (added === 0) {
          this.#state = {
            indexedAt: started,
            fileCount: this.#index.countDocs(this.source.id),
            lastError: null,
          }
          return
        }
      }
      this.#state = {
        indexedAt: Date.now(),
        fileCount: this.#index.countDocs(this.source.id),
        lastError: null,
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.#state = { ...this.#state, lastError: errorMessage(error) }
      }
      throw error
    }
  }

  async #assertRootIdentity(): Promise<void> {
    if (this.source.rootIdentity !== undefined && !await sourceRootIdentityMatches(this.source.path, this.source.rootIdentity)) {
      throw Object.assign(new Error('configured source root identity changed'), { code: 'OUTSIDE_SOURCE' })
    }
  }

  async #indexFile(relPath: string, mtimeMs: number): Promise<void> {
    await this.#assertRootIdentity()
    const markdown = await readSourceFileText(this.source.path, relPath)
    await this.#assertRootIdentity()
    if (markdown === null) {
      this.#index.deleteDoc(this.source.id, relPath)
      return
    }
    const digest = digestNote(markdown, fileStemOf(relPath))
    this.#index.upsertDoc(this.source.id, relPath, digest.title, digest.tags, digest.text, mtimeMs)
  }

  async #rebuildLinks(relPaths: readonly string[]): Promise<void> {
    const known = this.#index.knownPaths(this.source.id)
    for (const relPath of relPaths) {
      await this.#assertRootIdentity()
      const markdown = await readSourceFileText(this.source.path, relPath)
      await this.#assertRootIdentity()
      if (markdown === null) continue
      const digest = digestNote(markdown, fileStemOf(relPath))
      this.#index.setLinks(this.source.id, relPath, digest.links, known)
    }
  }
}

function fsWatchRecursive(root: string): ReturnType<typeof watchFs> | null {
  try {
    return watchFs(root, { recursive: true, persistent: false })
  } catch {
    // Recursive watch support is platform/runtime-dependent.
    return null
  }
}

function normalizeEventPath(filename: string): string {
  return filename.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

export { toSourceRel }
