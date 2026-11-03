/** Host Knowledge RPC — TypertRemoteService for the dsh-obsidian client half.
 *
 * Knowledge data is profile-scoped rather than bound to one conversation.
 * Remote reads therefore do not require a `workspaceFileScope`; all source
 * writes still go through `ctx.fs` version-guarded intents so the sandbox and
 * stale-version checks apply to every proposal application.
 * The scope-free internals (`searchSources`, `readSource`, ...) are shared
 * with the Agent tools, which have no Session scope.
 */

import * as path from 'node:path'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MAX_SOURCES, type ObsidianSettings } from '../shared/settings-contract.ts'
import {
  KNOWLEDGE_SERVICE, fail, isFailResult, MAX_INBOX_ITEMS,
  type AddSourceInput, type AddSourceOk, type ApplyOk, type BrowseOk, type FailResult, type InboxItem,
  type KnowledgeResult, type KnowledgeSourceInfo, type ListSourcesOk,
  type ProposeInput, type ReadDoc, type SearchOk, type SearchOptions,
  type SourceKind,
} from '../shared/rpc-contract.ts'
import { KnowledgeIndex } from './indexer.ts'
import { KnowledgeSourceRuntime } from './knowledge-source.ts'
import { digestNote } from './markdown.ts'
import { fileStemOf } from './scanner.ts'
import { InboxStore } from './inbox-store.ts'
import { KnowledgeSourceStore } from './source-store.ts'
import { normalizeSourceRelPath, resolveContainedPath } from './source-path.ts'

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100
const MAX_QUERY_CHARS = 256

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function failure(error: unknown, fallback: FailResult): FailResult {
  switch (errorCode(error)) {
    case 'FS_NOT_FOUND': return fail('NOT_FOUND', 'path not found')
    case 'FS_STALE_VERSION':
    case 'FS_NOT_OBSERVED': return fail('CONFLICT', 'file changed on disk; reload it before saving')
    case 'FS_SANDBOX_DENIED':
    case 'FS_PERMISSION_DENIED': return fail('SANDBOX_DENIED',
      'the workspace sandbox denied the write. If the target lives outside ' +
      'the current workspace, switch to the workspace that contains it, or grant ' +
      'the session a wider file-sandbox mode, then retry.')
    case 'FS_TOO_LARGE': return fail('TOO_LARGE', 'file exceeds the size limit')
    case 'FS_AMBIGUOUS_EDIT': return fail('CONFLICT', 'target resolution is ambiguous; reload it')
    default: return fallback
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The installed rc.5 local fs backend uses the canonical absolute path as its
 *  stable target identity. Compare after resolve so later stat/read/write calls
 *  stay pinned to the checked identity even if a path is swapped concurrently. */
function targetIsCanonical(target: FsTarget, expectedPath: string): boolean {
  return String(target.targetKey) === expectedPath
}

function assertUniqueSourceIds(config: ObsidianSettings): void {
  const sourceIds = config.knowledgeSources.map((source) => source.id)
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('duplicate knowledge source ids in configuration')
  }
}

function sameSourceIndexingConfig(left: ObsidianSettings['knowledgeSources'][number], right: ObsidianSettings['knowledgeSources'][number]): boolean {
  return left.path === right.path && left.kind === right.kind &&
    sameStrings(left.include, right.include) && sameStrings(left.exclude, right.exclude)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export class KnowledgeService extends TypertRemoteService {
  /** Public because Cordis proxies forward service reads/writes through it. */
  context: Context
  #config: ObsidianSettings
  readonly #index: KnowledgeIndex
  readonly #runtimes = new Map<string, KnowledgeSourceRuntime>()
  readonly #inboxStore: InboxStore
  readonly #sourceStore: KnowledgeSourceStore
  readonly #ready: Promise<void>
  #settingsUpdates: Promise<void> = Promise.resolve()
  #shuttingDown = false

  constructor(ctx: Context, config: ObsidianSettings, dataDir: string) {
    assertUniqueSourceIds(config)
    super(ctx, KNOWLEDGE_SERVICE)
    this.context = ctx
    this.#config = { ...config, knowledgeSources: [] }
    this.#index = KnowledgeIndex.open(path.join(dataDir, 'knowledge.db'))
    this.#inboxStore = new InboxStore(dataDir)
    this.#sourceStore = new KnowledgeSourceStore(dataDir)
    this.#ready = this.#sourceStore.load(config.knowledgeSources).then(async (sources) => {
      assertUniqueSourceIds({ ...config, knowledgeSources: sources })
      await this.#applySettings({ ...config, knowledgeSources: sources })
    })
    this.listSources = this.listSources.bind(this)
    this.addSource = this.addSource.bind(this)
    this.removeSource = this.removeSource.bind(this)
    this.browse = this.browse.bind(this)
    this.indexSource = this.indexSource.bind(this)
    this.search = this.search.bind(this)
    this.read = this.read.bind(this)
    this.proposeInbox = this.proposeInbox.bind(this)
    this.listInbox = this.listInbox.bind(this)
    this.applyInbox = this.applyInbox.bind(this)
    this.dismissInbox = this.dismissInbox.bind(this)
  }

  /** Keep non-source plugin preferences live; knowledge sources belong to the page store. */
  updateSettings(config: ObsidianSettings): Promise<void> {
    if (this.#shuttingDown) return Promise.resolve()
    return this.#queueSettingsChange(async () => {
      await this.#ready
      await this.#applySettings({ ...config, knowledgeSources: this.#config.knowledgeSources })
    })
  }

  /** Hook invoked by the Host on runtime teardown (plugin reload/disable). */
  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return
    this.#shuttingDown = true
    await this.#ready.catch(() => undefined)
    await this.#settingsUpdates.catch(() => undefined)
    const runtimes = [...this.#runtimes.values()]
    this.#runtimes.clear()
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
    this.#index.close()
  }

  // ── Scope-free internals (shared with Agent tools) ─────────────────────────

  listSourceInfos(): KnowledgeSourceInfo[] {
    return this.#config.knowledgeSources.map((source) => this.#infoOf(source.id))
  }

  async addKnowledgeSource(input: AddSourceInput, signal?: AbortSignal): Promise<KnowledgeResult<AddSourceOk>> {
    signal?.throwIfAborted()
    if (this.#shuttingDown) return fail('IO', 'knowledge service is shutting down')
    const name = input.name.trim()
    const requestedPath = input.path.trim()
    if (name === '' || name.length > 64 || requestedPath === '' || requestedPath.length > 1024 || !path.isAbsolute(requestedPath)) {
      return fail('INVALID', 'provide a source name and an absolute folder path')
    }

    let sourcePath: string
    try {
      const stat = await fs.stat(requestedPath)
      if (!stat.isDirectory()) return fail('INVALID', 'knowledge source path must be a folder')
      sourcePath = await fs.realpath(requestedPath)
    } catch (error) {
      return failure(error, fail('NOT_FOUND', 'knowledge source folder not found'))
    }
    signal?.throwIfAborted()

    return this.#queueSettingsChange(async () => {
      await this.#ready
      signal?.throwIfAborted()
      if (this.#shuttingDown) return fail('IO', 'knowledge service is shutting down')
      const sources = this.#config.knowledgeSources
      if (sources.length >= MAX_SOURCES) return fail('INVALID', `at most ${MAX_SOURCES} knowledge sources are allowed`)
      if (sources.some((source) => path.resolve(source.path) === sourcePath)) {
        return fail('ALREADY_EXISTS', 'this folder is already a knowledge source')
      }
      const source = {
        id: randomUUID(), name, path: sourcePath, kind: input.kind, include: [], exclude: [],
      } as const
      const next = [...sources, source]
      await this.#sourceStore.save(next)
      await this.#applySettings({ ...this.#config, knowledgeSources: next })
      return { ok: true, source: this.#infoOf(source.id) }
    })
  }

  async removeKnowledgeSource(sourceId: string): Promise<KnowledgeResult<{ ok: true }>> {
    if (this.#shuttingDown) return fail('IO', 'knowledge service is shutting down')
    return this.#queueSettingsChange(async () => {
      await this.#ready
      if (this.#shuttingDown) return fail('IO', 'knowledge service is shutting down')
      if (this.#sourceOf(sourceId) === null) return fail('NOT_FOUND', 'unknown knowledge source')
      const next = this.#config.knowledgeSources.filter((source) => source.id !== sourceId)
      await this.#sourceStore.save(next)
      await this.#applySettings({ ...this.#config, knowledgeSources: next })
      return { ok: true }
    })
  }

  browseSource(sourceId: string, directoryPath = ''): KnowledgeResult<BrowseOk> {
    if (this.#sourceOf(sourceId) === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const relative = directoryPath === '' ? '' : normalizeSourceRelPath(directoryPath)
    if (relative === null) return fail('INVALID', 'invalid or unsafe directory path')
    const listing = this.#index.listDirectory(sourceId, relative)
    return { ok: true, sourceId, directoryPath: relative, ...listing }
  }

  async searchSources(query: string, options: SearchOptions): Promise<KnowledgeResult<SearchOk>> {
    await this.#ready
    const trimmed = query.trim()
    if (trimmed === '' || trimmed.length > MAX_QUERY_CHARS) {
      return { ok: true, query: trimmed, hits: [], truncated: false }
    }
    if (options.sourceId !== undefined && this.#sourceOf(options.sourceId) === null) {
      return fail('NOT_FOUND', 'unknown knowledge source')
    }
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT)
    const field = options.field ?? 'body'
    const hits = this.#index.search(options.sourceId, field, trimmed, limit)
    return { ok: true, query: trimmed, hits, truncated: hits.length >= limit }
  }

  async readSource(sourceId: string, relPath: string, signal?: AbortSignal): Promise<KnowledgeResult<ReadDoc>> {
    await this.#ready
    const source = this.#sourceOf(sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const relative = normalizeSourceRelPath(relPath)
    if (relative === null) return fail('INVALID', 'invalid or unsafe path')
    const absPath = await resolveContainedPath(source.path, relative)
    if (absPath === null) return fail('INVALID', 'path resolves outside the configured source')
    signal?.throwIfAborted()

    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    let content: string
    let version: string
    try {
      const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
      handle = await fs.open(absPath, fsConstants.O_RDONLY | noFollow)
      const info = await handle.stat()
      if (!info.isFile()) return fail('NOT_FOUND', 'file not found')
      if (info.size > 4 * 1024 * 1024) return fail('TOO_LARGE', 'document is too large to review here')

      const pathInfo = await fs.lstat(absPath)
      const verifiedPath = await resolveContainedPath(source.path, relative)
      if (pathInfo.isSymbolicLink() || pathInfo.dev !== info.dev || pathInfo.ino !== info.ino || verifiedPath !== absPath) {
        return fail('INVALID', 'target identity changed while resolving path')
      }
      signal?.throwIfAborted()
      content = await handle.readFile({ encoding: 'utf8', signal })
      if (content.length > 4 * 1024 * 1024) return fail('TOO_LARGE', 'document is too large to review here')
      version = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`
    } catch (error) {
      return failure(error, fail('IO', 'failed to read file'))
    } finally {
      await handle?.close().catch(() => undefined)
    }
    const digest = digestNote(content, fileStemOf(relative))
    const known = this.#index.knownPaths(sourceId)
    const indexed = this.#index.getDoc(sourceId, relative)
    const links = digest.links.map((link) => ({
      target: link.target,
      alias: link.alias,
      resolvedPath: resolveAgainstKnown(link.target, link.alias, known),
    }))
    const backlinks = this.#index.backLinks(sourceId, relative)
    return {
      ok: true,
      sourceId,
      path: relative,
      content,
      version,
      title: digest.title,
      tags: [...digest.tags],
      links,
      backlinks,
      updatedAt: indexed?.mtimeMs ?? null,
    }
  }

  async propose(sourceId: string, input: ProposeInput, signal?: AbortSignal): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    await this.#ready
    if (this.#sourceOf(sourceId) === null) return fail('NOT_FOUND', 'unknown knowledge source')
    if (input.sourceId !== sourceId) return fail('INVALID', 'source mismatch')
    const relative = normalizeSourceRelPath(input.targetPath)
    if (relative === null) return fail('INVALID', 'invalid or unsafe target path')
    const source = this.#sourceOf(sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const absPath = await resolveContainedPath(source.path, relative)
    if (absPath === null) return fail('INVALID', 'target resolves outside the configured source')
    const target = await this.context.fs.resolve(absPath)
    const existing = await this.context.fs.stat(target, signal)
    const baseVersion = existing === undefined || existing.type !== 'file' ? null : String(existing.version)
    const item = await this.#inboxStore.add({ ...input, targetPath: relative })
    const updated = await this.#inboxStore.update(item.id, { baseVersion })
    return { ok: true, item: updated ?? item }
  }

  async listInboxItems(): Promise<KnowledgeResult<{ ok: true; items: InboxItem[] }>> {
    const items = await this.#inboxStore.list()
    return { ok: true, items: items.slice(-MAX_INBOX_ITEMS) }
  }

  async applyInboxItem(itemId: string, signal?: AbortSignal): Promise<KnowledgeResult<ApplyOk>> {
    await this.#ready
    const items = await this.#inboxStore.list()
    const item = items.find((entry) => entry.id === itemId) ?? null
    if (item === null) return fail('NOT_FOUND', 'proposal not found')
    if (item.status !== 'pending') return fail('CONFLICT', `proposal is already ${item.status}`)
    const source = this.#sourceOf(item.sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const relative = normalizeSourceRelPath(item.targetPath)
    if (relative === null) return fail('INVALID', 'invalid or unsafe target path')
    const absPath = await resolveContainedPath(source.path, relative)
    if (absPath === null) return fail('INVALID', 'target resolves outside the configured source')

    const target: FsTarget = await this.context.fs.resolve(absPath)
    if (!targetIsCanonical(target, absPath)) return fail('INVALID', 'target identity changed while resolving path')

    let content: string
    let intent: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }
    try {
      const info = await this.context.fs.stat(target, signal)
      if (item.kind === 'create') {
        if (info !== undefined && info.type === 'file') return fail('CONFLICT', 'target file already exists')
        content = item.body
        intent = { kind: 'createIfAbsent' }
      } else {
        if (info === undefined || info.type !== 'file') return fail('CONFLICT', 'target file no longer exists; reload it')
        const existing = await this.context.fs.readText(target, signal)
        const base: FsVersion = FsVersion(item.baseVersion ?? String(info.version))
        content = item.kind === 'append' ? `${existing.replace(/\s*$/u, '')}\n\n${item.body}\n` : item.body
        intent = { kind: 'replaceIfVersion', version: base }
      }
    } catch (error) {
      return failure(error, fail('IO', 'failed to read target'))
    }

    try {
      const outcome = await this.context.fs.writeText(target, content, intent, signal)
      const version = String(outcome.version)
      await this.#inboxStore.update(item.id, { status: 'applied', baseVersion: version, conflictMessage: null })
      return { ok: true, itemId: item.id, version }
    } catch (error) {
      const result = failure(error, fail('IO', 'write failed'))
      if (result.code === 'CONFLICT') {
        await this.#inboxStore.update(item.id, { status: 'conflicted', conflictMessage: result.message })
      }
      return result
    }
  }

  async dismissInboxItem(itemId: string): Promise<KnowledgeResult<{ ok: true }>> {
    const item = await this.#inboxStore.update(itemId, { status: 'dismissed' })
    if (item === null) return fail('NOT_FOUND', 'proposal not found')
    return { ok: true }
  }

  // ── Typert RPC surface (profile-scoped knowledge) ──────────────────────────

  @Remote
  async listSources(): Promise<KnowledgeResult<ListSourcesOk>> {
    await this.#ready
    await this.#settingsUpdates
    return { ok: true, sources: this.listSourceInfos() }
  }

  @Remote
  async addSource(input: AddSourceInput, signal?: AbortSignal): Promise<KnowledgeResult<AddSourceOk>> {
    return this.addKnowledgeSource(input, signal)
  }

  @Remote
  async removeSource(sourceId: string): Promise<KnowledgeResult<{ ok: true }>> {
    return this.removeKnowledgeSource(sourceId)
  }

  @Remote
  async browse(sourceId: string, directoryPath: string): Promise<KnowledgeResult<BrowseOk>> {
    await this.#ready
    return this.browseSource(sourceId, directoryPath)
  }

  @Remote
  async indexSource(sourceId: string): Promise<KnowledgeResult<AddSourceOk>> {
    await this.#ready
    if (this.#sourceOf(sourceId) === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const runtime = this.#runtimes.get(sourceId)
    if (runtime === undefined) return fail('NOT_FOUND', 'unknown knowledge source')
    try {
      await runtime.sync()
    } catch (error) {
      return failure(error, fail('IO', `indexing failed: ${errorMessage(error)}`))
    }
    return { ok: true, source: this.#infoOf(sourceId) }
  }

  @Remote
  async search(query: string, options: SearchOptions): Promise<KnowledgeResult<SearchOk>> {
    return this.searchSources(query, options)
  }

  @Remote
  async read(sourceId: string, relPath: string, signal?: AbortSignal): Promise<KnowledgeResult<ReadDoc>> {
    return this.readSource(sourceId, relPath, signal)
  }

  @Remote
  async proposeInbox(input: ProposeInput, signal?: AbortSignal): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    return this.propose(input.sourceId, input, signal)
  }

  @Remote
  async listInbox(): Promise<KnowledgeResult<{ ok: true; items: InboxItem[] }>> {
    return this.listInboxItems()
  }

  @Remote
  async applyInbox(itemId: string, signal?: AbortSignal): Promise<KnowledgeResult<ApplyOk>> {
    return this.applyInboxItem(itemId, signal)
  }

  @Remote
  async dismissInbox(itemId: string): Promise<KnowledgeResult<{ ok: true }>> {
    return this.dismissInboxItem(itemId)
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  #queueSettingsChange<T>(change: () => Promise<T>): Promise<T> {
    const task = this.#settingsUpdates.then(change, change)
    this.#settingsUpdates = task.then(() => undefined, () => undefined)
    return task
  }

  #startRuntime(runtime: KnowledgeSourceRuntime): void {
    void runtime.sync().catch(() => undefined).finally(() => runtime.startWatch())
  }

  async #applySettings(config: ObsidianSettings): Promise<void> {
    assertUniqueSourceIds(config)
    const previousById = new Map(this.#config.knowledgeSources.map((source) => [source.id, source]))
    const nextById = new Map(config.knowledgeSources.map((source) => [source.id, source]))

    for (const previous of this.#config.knowledgeSources) {
      const next = nextById.get(previous.id)
      if (next !== undefined && sameSourceIndexingConfig(previous, next) && this.#runtimes.has(previous.id)) continue
      const runtime = this.#runtimes.get(previous.id)
      if (runtime !== undefined) {
        this.#runtimes.delete(previous.id)
        await runtime.stop()
      }
      this.#index.clearSource(previous.id)
    }

    this.#config = config
    for (const source of config.knowledgeSources) {
      const previous = previousById.get(source.id)
      if (previous !== undefined && sameSourceIndexingConfig(previous, source) && this.#runtimes.has(source.id)) continue
      const runtime = new KnowledgeSourceRuntime(source, this.#index)
      this.#runtimes.set(source.id, runtime)
      this.#startRuntime(runtime)
    }
  }

  #sourceOf(sourceId: string): { id: string; name: string; path: string; kind: SourceKind } | null {
    return this.#config.knowledgeSources.find((source) => source.id === sourceId) ?? null
  }

  #infoOf(sourceId: string): KnowledgeSourceInfo {
    const source = this.#sourceOf(sourceId)
    if (source === null) {
      return { id: sourceId, name: '', path: '', kind: 'folder', indexedAt: null, fileCount: 0, lastError: 'unknown source' }
    }
    const runtime = this.#runtimes.get(sourceId)
    return {
      id: source.id,
      name: source.name,
      path: source.path,
      kind: source.kind,
      indexedAt: runtime?.state.indexedAt ?? null,
      fileCount: runtime?.state.fileCount ?? 0,
      lastError: runtime?.state.lastError ?? null,
    }
  }
}

function resolveAgainstKnown(target: string, alias: string | null, known: ReadonlySet<string>): string | null {
  for (const candidate of [target, alias]) {
    if (candidate === null) continue
    const clean = candidate.trim()
    if (clean === '' || clean.startsWith('#') || clean.startsWith('/')) continue
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(clean)) continue
    const hash = clean.indexOf('#')
    const withoutHeading = hash >= 0 ? clean.slice(0, hash) : clean
    const withMd = withoutHeading.endsWith('.md') ? withoutHeading : `${withoutHeading}.md`
    if (known.has(withMd)) return withMd
    if (known.has(withoutHeading)) return withoutHeading
  }
  return null
}

export { isFailResult }
