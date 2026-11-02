/** Host Knowledge RPC — TypertRemoteService for the dsh-obsidian client half.
 *
 * Every @Remote method receives the Typert `workspaceFileScope` lookup
 * parameter (session → { sessionId, workspaceRoot }), following workspace-files.
 * Reads are unconfined by the sandbox (vaults may live outside the session
 * workspace); **all writes go through `ctx.fs` version-guarded intents** so
 * the sandbox and stale-version checks apply to every proposal application.
 * The scope-free internals (`searchSources`, `readSource`, ...) are shared
 * with the Agent tools, which have no Session scope.
 */

import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsVersion, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ObsidianSettings } from '../shared/settings-contract.ts'
import {
  KNOWLEDGE_SERVICE, fail, isFailResult, MAX_INBOX_ITEMS,
  type AddSourceOk, type ApplyOk, type FailResult, type InboxItem,
  type KnowledgeResult, type KnowledgeSourceInfo, type ListSourcesOk,
  type ProposeInput, type ReadDoc, type SearchOk, type SearchOptions,
  type SourceKind,
} from '../shared/rpc-contract.ts'
import { KnowledgeIndex } from './indexer.ts'
import { KnowledgeSourceRuntime } from './knowledge-source.ts'
import { digestNote } from './markdown.ts'
import { fileStemOf } from './scanner.ts'
import { InboxStore } from './inbox-store.ts'
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

export class KnowledgeService extends TypertRemoteService {
  /** Public because Cordis proxies forward service reads/writes through it. */
  context: Context
  readonly #config: ObsidianSettings
  readonly #index: KnowledgeIndex
  readonly #runtimes = new Map<string, KnowledgeSourceRuntime>()
  readonly #inboxStore: InboxStore

  constructor(ctx: Context, config: ObsidianSettings, dataDir: string) {
    const sourceIds = config.knowledgeSources.map((source) => source.id)
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw new Error('duplicate knowledge source ids in configuration')
    }
    super(ctx, KNOWLEDGE_SERVICE)
    this.context = ctx
    this.#config = config
    this.#index = KnowledgeIndex.open(path.join(dataDir, 'knowledge.db'))
    this.#inboxStore = new InboxStore(dataDir)
    for (const source of config.knowledgeSources) {
      const runtime = new KnowledgeSourceRuntime(source, this.#index)
      this.#runtimes.set(source.id, runtime)
      // Kick off initial sync; watcher starts after the first pass completes.
      void runtime.sync().catch(() => undefined).finally(() => runtime.startWatch())
    }
  }

  /** Hook invoked by the Host on runtime teardown (plugin reload/disable). */
  shutdown(): void {
    const runtimes = [...this.#runtimes.values()]
    this.#runtimes.clear()
    void Promise.all(runtimes.map((runtime) => runtime.stop()))
      .then(() => this.#index.close())
  }

  // ── Scope-free internals (shared with Agent tools) ─────────────────────────

  listSourceInfos(): KnowledgeSourceInfo[] {
    return this.#config.knowledgeSources.map((source) => this.#infoOf(source.id))
  }

  async searchSources(query: string, options: SearchOptions): Promise<KnowledgeResult<SearchOk>> {
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
    const source = this.#sourceOf(sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const relative = normalizeSourceRelPath(relPath)
    if (relative === null) return fail('INVALID', 'invalid or unsafe path')
    const absPath = await resolveContainedPath(source.path, relative)
    if (absPath === null) return fail('INVALID', 'path resolves outside the configured source')
    const target = await this.context.fs.resolve(absPath)
    if (!targetIsCanonical(target, absPath)) return fail('INVALID', 'target identity changed while resolving path')
    const info = await this.context.fs.stat(target, signal)
    if (info === undefined || info.type !== 'file') return fail('NOT_FOUND', 'file not found')
    let content: string
    try {
      content = await this.context.fs.readText(target, signal)
    } catch (error) {
      return failure(error, fail('IO', 'failed to read file'))
    }
    if (content.length > 4 * 1024 * 1024) return fail('TOO_LARGE', 'document is too large to review here')
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
      version: String(info.version),
      title: digest.title,
      tags: [...digest.tags],
      links,
      backlinks,
      updatedAt: indexed?.mtimeMs ?? null,
    }
  }

  async propose(sourceId: string, input: ProposeInput, signal?: AbortSignal): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
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

  // ── Typert RPC surface (per-Session scope) ─────────────────────────────────

  @Remote
  async listSources(_scope: WorkspaceFileScope): Promise<KnowledgeResult<ListSourcesOk>> {
    return { ok: true, sources: this.listSourceInfos() }
  }

  @Remote
  async indexSource(_scope: WorkspaceFileScope, sourceId: string): Promise<KnowledgeResult<AddSourceOk>> {
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
  async search(scope: WorkspaceFileScope, query: string, options: SearchOptions): Promise<KnowledgeResult<SearchOk>> {
    return this.searchSources(query, options)
  }

  @Remote
  async read(scope: WorkspaceFileScope, sourceId: string, relPath: string, signal?: AbortSignal): Promise<KnowledgeResult<ReadDoc>> {
    return this.readSource(sourceId, relPath, signal)
  }

  @Remote
  async proposeInbox(scope: WorkspaceFileScope, input: ProposeInput, signal?: AbortSignal): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    return this.propose(input.sourceId, input, signal)
  }

  @Remote
  async listInbox(_scope: WorkspaceFileScope): Promise<KnowledgeResult<{ ok: true; items: InboxItem[] }>> {
    return this.listInboxItems()
  }

  @Remote
  async applyInbox(scope: WorkspaceFileScope, itemId: string, signal?: AbortSignal): Promise<KnowledgeResult<ApplyOk>> {
    return this.applyInboxItem(itemId, signal)
  }

  @Remote
  async dismissInbox(_scope: WorkspaceFileScope, itemId: string): Promise<KnowledgeResult<{ ok: true }>> {
    return this.dismissInboxItem(itemId)
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

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
