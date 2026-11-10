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
import { MAX_SOURCES, type KnowledgeSourceConfig, type ObsidianSettings, type SourceRootIdentity } from '../shared/settings-contract.ts'
import {
  KNOWLEDGE_SERVICE, fail, isFailResult, MAX_INBOX_ITEMS,
  type AddSourceInput, type AddSourceOk, type ApplyOk, type BrowseOk, type FailResult, type InboxItem,
  type KnowledgeResult, type KnowledgeSourceInfo, type ListSourcesOk,
  type ProposeInput, type ReadDoc, type RebaseOperation, type SearchOk, type SearchOptions,
  type SourceKind,
} from '../shared/rpc-contract.ts'
import { KnowledgeIndex } from './indexer.ts'
import { KnowledgeSourceRuntime } from './knowledge-source.ts'
import { resolveContainedFsTarget } from './fs-target.ts'
import { resolveAgainstKnown } from './link-resolution.ts'
import { digestNote } from './markdown.ts'
import { fileStemOf } from './scanner.ts'
import { InboxStore } from './inbox-store.ts'
import { rebaseInboxProposal } from './inbox-rebase.ts'
import { failure, errorMessage } from './failure.ts'
import { withKeyedLock } from './keyed-lock.ts'
import { KnowledgeSourceStore } from './source-store.ts'
import { MAX_PROPOSAL_BASELINE_BYTES, decodeBoundedText, readHandleTextBounded } from './bounded-read.ts'
import { assertUniqueSourceIds, sameSourceIndexingConfig } from './source-config.ts'
import { captureSourceRootIdentity, normalizeSourceRelPath, resolveContainedPath, sourceRootIdentityMatches } from './source-path.ts'
import { hasRootIdentity, sourceRootFailure } from './source-root.ts'

const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 100
const MAX_QUERY_CHARS = 256
const SOURCE_REMOVAL_CONFLICT_MESSAGE = 'knowledge source was removed; this proposal is retained but cannot be applied'
export class KnowledgeService extends TypertRemoteService {
  /** Public because Cordis proxies forward service reads/writes through it. */
  context: Context
  #config: ObsidianSettings
  readonly #index: KnowledgeIndex
  readonly #runtimes = new Map<string, KnowledgeSourceRuntime>()
  readonly #rootErrors = new Map<string, string>()
  readonly #targetWrites = new Map<string, Promise<void>>()
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
    this.#ready = this.#sourceStore.load(config.knowledgeSources).then(async (loadedSources) => {
      let sourcesChanged = false
      const sources: KnowledgeSourceConfig[] = []
      for (const source of loadedSources) {
        if (hasRootIdentity(source.rootIdentity)) {
          sources.push(source)
          continue
        }
        try {
          const pinned = await captureSourceRootIdentity(source.path)
          sources.push({ ...source, path: pinned.path, rootIdentity: pinned.identity })
          sourcesChanged = true
        } catch (error) {
          this.#rootErrors.set(source.id, errorMessage(error))
          sources.push(source)
        }
      }
      if (sourcesChanged) await this.#sourceStore.save(sources)
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
    this.updateInboxDraft = this.updateInboxDraft.bind(this)
    this.rebaseInbox = this.rebaseInbox.bind(this)
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
    let rootIdentity: Awaited<ReturnType<typeof captureSourceRootIdentity>>['identity']
    try {
      const initialStat = await fs.stat(requestedPath)
      if (!initialStat.isDirectory()) return fail('INVALID', 'knowledge source path must be a folder')
      const pinned = await captureSourceRootIdentity(requestedPath)
      sourcePath = pinned.path
      rootIdentity = pinned.identity
    } catch (error) {
      return failure(error, fail('NOT_FOUND', 'knowledge source folder not found'))
    }
    signal?.throwIfAborted()

    return this.#queueSettingsChange(() => this.#addPersistedSource(name, input.kind, sourcePath, rootIdentity, signal))
  }

  async #addPersistedSource(
    name: string,
    kind: SourceKind,
    sourcePath: string,
    rootIdentity: SourceRootIdentity,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult<AddSourceOk>> {
    await this.#ready
    signal?.throwIfAborted()
    if (this.#shuttingDown) return fail('IO', 'knowledge service is shutting down')
    const sources = this.#config.knowledgeSources
    try {
      if (!await sourceRootIdentityMatches(sourcePath, rootIdentity)) return fail('OUTSIDE_SOURCE', 'knowledge source root changed while it was being added')
    } catch (error) {
      return failure(error, fail('IO', 'failed to verify knowledge source root'))
    }
    if (sources.length >= MAX_SOURCES) return fail('INVALID', `at most ${MAX_SOURCES} knowledge sources are allowed`)
    if (sources.some((source) => path.resolve(source.path) === sourcePath)) return fail('ALREADY_EXISTS', 'this folder is already a knowledge source')
    const source = { id: randomUUID(), name, path: sourcePath, kind, include: [], exclude: [], rootIdentity } as const
    const previousConfig = this.#config
    const next = [...sources, source]
    try {
      await this.#sourceStore.save(next)
    } catch (error) {
      return failure(error, fail('IO', 'failed to persist knowledge source'))
    }
    try {
      await this.#applySettings({ ...previousConfig, knowledgeSources: next })
    } catch (error) {
      let restored = true
      try {
        await this.#sourceStore.save(sources)
      } catch {
        restored = false
      }
      try {
        await this.#applySettings(previousConfig)
      } catch {
        restored = false
      }
      return failure(error, fail('IO', restored
        ? 'failed to initialize knowledge source; addition was rolled back'
        : 'source addition partially failed; reload the source list to reconcile state'))
    }
    return { ok: true, source: this.#infoOf(source.id) }
  }

  async removeKnowledgeSource(sourceId: string): Promise<KnowledgeResult<{ ok: true }>> {
    if (this.#shuttingDown) return fail('IO', 'knowledge service is shutting down')
    return this.#queueSettingsChange(async () => {
      await this.#ready
      if (this.#shuttingDown) return fail('IO', 'knowledge service is shutting down')
      if (this.#sourceOf(sourceId) === null) return fail('NOT_FOUND', 'unknown knowledge source')
      let items: InboxItem[]
      try {
        items = await this.#inboxStore.list()
      } catch (error) {
        return failure(error, fail('IO', 'failed to check pending proposals before removing source'))
      }
      const changedIds: string[] = []
      for (const item of items) {
        if (item.sourceId !== sourceId || item.status !== 'pending') continue
        try {
          if (await this.#markSourceProposalConflicted(item)) changedIds.push(item.id)
        } catch (error) {
          const restored = await this.#restoreSourceRemovalDrafts(sourceId, changedIds)
          return failure(error, fail('IO', restored
            ? 'failed to preserve proposal state; earlier proposal changes were restored'
            : 'failed to preserve proposal state and could not restore every draft'))
        }
      }
      const previousConfig = this.#config
      const previousSources = previousConfig.knowledgeSources
      const next = previousSources.filter((source) => source.id !== sourceId)
      try {
        await this.#sourceStore.save(next)
      } catch (error) {
        const restored = await this.#restoreSourceRemovalDrafts(sourceId, changedIds)
        return failure(error, fail('IO', restored
          ? 'failed to persist source removal; pending proposals were restored'
          : 'failed to persist source removal and could not restore every pending proposal'))
      }
      try {
        await this.#applySettings({ ...this.#config, knowledgeSources: next })
      } catch (error) {
        let restored = true
        try {
          await this.#sourceStore.save(previousSources)
        } catch {
          restored = false
        }
        try {
          await this.#applySettings(previousConfig)
        } catch {
          restored = false
        }
        if (!await this.#restoreSourceRemovalDrafts(sourceId, changedIds)) restored = false
        return failure(error, fail('IO', restored
          ? 'failed to apply source removal; source and pending proposals were restored'
          : 'source removal partially failed; reload sources and Inbox to reconcile state'))
      }
      return { ok: true }
    })
  }

  browseSource(sourceId: string, directoryPath = ''): KnowledgeResult<BrowseOk> {
    if (this.#sourceOf(sourceId) === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const relative = directoryPath === '' ? '' : normalizeSourceRelPath(directoryPath)
    if (relative === null) return fail('OUTSIDE_SOURCE', 'directory path is outside the configured source')
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
    const selectedSources = options.sourceId === undefined
      ? this.#config.knowledgeSources
      : this.#config.knowledgeSources.filter((source) => source.id === options.sourceId)
    for (const source of selectedSources) {
      const rootFailure = await sourceRootFailure(source)
      if (rootFailure !== null) return rootFailure
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
    const rootFailure = await sourceRootFailure(source)
    if (rootFailure !== null) return rootFailure
    const relative = normalizeSourceRelPath(relPath)
    if (relative === null) return fail('OUTSIDE_SOURCE', 'document path is outside the configured source')
    let absPath: string | null
    try {
      absPath = await resolveContainedPath(source.path, relative)
    } catch (error) {
      return failure(error, fail('IO', 'failed to resolve document path'))
    }
    if (absPath === null) return fail('OUTSIDE_SOURCE', 'path resolves outside the configured source')
    const rootStillPinned = await sourceRootFailure(source)
    if (rootStillPinned !== null) return rootStillPinned
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
      content = await readHandleTextBounded(handle, MAX_PROPOSAL_BASELINE_BYTES, signal)
      const afterRead = await handle.stat()
      if (afterRead.dev !== info.dev || afterRead.ino !== info.ino || afterRead.mtimeMs !== info.mtimeMs || afterRead.size !== info.size) {
        return fail('CONFLICT', 'file changed while it was being read; retry the read')
      }
      version = `${afterRead.dev}:${afterRead.ino}:${afterRead.mtimeMs}:${afterRead.size}`
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

  async propose(sourceId: string, input: ProposeInput, signal?: AbortSignal, agentId: string | null = null): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    return this.#queueSettingsChange(() => this.#proposeWithSource(sourceId, input, signal, agentId))
  }

  async #proposeWithSource(sourceId: string, input: ProposeInput, signal?: AbortSignal, agentId: string | null = null): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    await this.#ready
    signal?.throwIfAborted()
    if (this.#sourceOf(sourceId) === null) return fail('NOT_FOUND', 'unknown knowledge source')
    if (input.sourceId !== sourceId) return fail('INVALID', 'source mismatch')
    const relative = normalizeSourceRelPath(input.targetPath)
    if (relative === null) return fail('OUTSIDE_SOURCE', 'target path is outside the configured source')
    const source = this.#sourceOf(sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const rootFailure = await sourceRootFailure(source)
    if (rootFailure !== null) return rootFailure
    let absPath: string | null
    try {
      absPath = await resolveContainedPath(source.path, relative)
    } catch (error) {
      return failure(error, fail('IO', 'failed to resolve proposal target'))
    }
    if (absPath === null) return fail('OUTSIDE_SOURCE', 'target resolves outside the configured source')
    const rootStillPinned = await sourceRootFailure(source)
    if (rootStillPinned !== null) return rootStillPinned

    let baselineContent = ''
    let baseVersion: string | null = null
    try {
      const target = await resolveContainedFsTarget(this.context, source.path, absPath)
      if (target === null) return fail('OUTSIDE_SOURCE', 'target is outside the configured source in the DSH filesystem')
      const existing = await this.context.fs.stat(target, signal)
      if (existing?.type === 'file') {
        baseVersion = String(existing.version)
        if (input.kind !== 'create') {
          if (typeof existing.size === 'number' && existing.size > MAX_PROPOSAL_BASELINE_BYTES) {
            return fail('TOO_LARGE', 'target file is too large to review')
          }
          const bytes = await this.context.fs.readBytes(target, signal, MAX_PROPOSAL_BASELINE_BYTES)
          const decoded = decodeBoundedText(bytes)
          if (decoded === null) return fail('INVALID', 'target is not valid UTF-8 text')
          baselineContent = decoded
          const confirmed = await this.context.fs.stat(target, signal)
          if (confirmed?.type !== 'file' || String(confirmed.version) !== baseVersion) {
            return fail('CONFLICT', 'target changed while capturing proposal baseline; retry proposal creation')
          }
        }
      } else if (input.kind !== 'create') {
        return fail('CONFLICT', 'append/update proposals require an existing readable target file')
      }
    } catch (error) {
      return failure(error, fail('IO', 'failed to capture proposal baseline'))
    }

    if (baselineContent.length > 4 * 1024 * 1024) return fail('TOO_LARGE', 'target file is too large to review')
    signal?.throwIfAborted()
    let item: InboxItem | null
    try {
      item = await this.#inboxStore.add({ ...input, targetPath: relative }, baselineContent, baseVersion, agentId)
    } catch (error) {
      return failure(error, fail('IO', 'failed to persist proposal'))
    }
    if (item === null) return fail('TOO_LARGE', 'the inbox storage limit is reached; resolve old proposals before adding another')
    return { ok: true, item }
  }

  async updateInboxDraftItem(itemId: string, body: string): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    if (typeof body !== 'string' || body.length > 200_000) return fail('INVALID', 'draft must be at most 200,000 characters')
    let items: InboxItem[]
    try {
      items = await this.#inboxStore.list()
    } catch (error) {
      return failure(error, fail('IO', 'failed to read inbox'))
    }
    const current = items.find((item) => item.id === itemId) ?? null
    if (current === null) return fail('NOT_FOUND', 'proposal not found')
    const key = `${current.sourceId}\u0000${current.targetPath}`
    try {
      return await withKeyedLock(this.#targetWrites, key, async () => {
      const latestItems = await this.#inboxStore.list()
      const latest = latestItems.find((item) => item.id === itemId) ?? null
      if (latest === null) return fail('NOT_FOUND', 'proposal not found')
      if (latest.status !== 'pending') return fail('CONFLICT', `proposal is already ${latest.status}`)
        const item = await this.#inboxStore.update(itemId, { body, conflictMessage: null })
        return item === null ? fail('NOT_FOUND', 'proposal not found') : { ok: true, item }
      })
    } catch (error) {
      return failure(error, fail('IO', 'failed to persist proposal draft'))
    }
  }

  async rebaseInboxItem(itemId: string, operation: RebaseOperation = 'same', signal?: AbortSignal): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    return this.#queueSettingsChange(() => this.#rebaseInboxItem(itemId, operation, signal))
  }

  async #rebaseInboxItem(itemId: string, operation: RebaseOperation, signal?: AbortSignal): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    return rebaseInboxProposal({
      context: this.context,
      ready: this.#ready,
      inbox: this.#inboxStore,
      sourceOf: (sourceId) => this.#sourceOf(sourceId),
      sourceRootFailure,
      withTargetLock: (key, task) => withKeyedLock(this.#targetWrites, key, task),
    }, itemId, operation, signal)
  }

  async listInboxItems(): Promise<KnowledgeResult<{ ok: true; items: InboxItem[] }>> {
    try {
      const items = await this.#inboxStore.list()
      return { ok: true, items: items.slice(-MAX_INBOX_ITEMS) }
    } catch (error) {
      return failure(error, fail('IO', 'failed to read inbox'))
    }
  }

  async applyInboxItem(itemId: string, expectedRevision: number, signal?: AbortSignal): Promise<KnowledgeResult<ApplyOk>> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return fail('INVALID', 'a valid confirmation revision is required')
    let items: InboxItem[]
    try {
      items = await this.#inboxStore.list()
    } catch (error) {
      return failure(error, fail('IO', 'failed to read inbox'))
    }
    const item = items.find((entry) => entry.id === itemId) ?? null
    if (item === null) return fail('NOT_FOUND', 'proposal not found')
    if (item.revision !== expectedRevision) return fail('STALE_CONFIRMATION', 'proposal changed after confirmation; review it again')
    const key = `${item.sourceId}\u0000${item.targetPath}`
    try {
      return await withKeyedLock(this.#targetWrites, key, () => this.#applyInboxItem(itemId, expectedRevision, signal))
    } catch (error) {
      return failure(error, fail('IO', 'failed to apply proposal'))
    }
  }

  async #applyInboxItem(itemId: string, expectedRevision: number, signal?: AbortSignal): Promise<KnowledgeResult<ApplyOk>> {
    await this.#ready
    const items = await this.#inboxStore.list()
    const item = items.find((entry) => entry.id === itemId) ?? null
    if (item === null) return fail('NOT_FOUND', 'proposal not found')
    if (item.revision !== expectedRevision) return fail('STALE_CONFIRMATION', 'proposal changed after confirmation; review it again')
    if (item.status !== 'pending') return fail('CONFLICT', `proposal is already ${item.status}`)
    const source = this.#sourceOf(item.sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const rootFailure = await sourceRootFailure(source)
    if (rootFailure !== null) return rootFailure
    const relative = normalizeSourceRelPath(item.targetPath)
    if (relative === null) return fail('OUTSIDE_SOURCE', 'target path is outside the configured source')
    let absPath: string | null
    try {
      absPath = await resolveContainedPath(source.path, relative)
    } catch (error) {
      return failure(error, fail('IO', 'failed to resolve proposal target'))
    }
    if (absPath === null) return fail('OUTSIDE_SOURCE', 'target resolves outside the configured source')

    let target: FsTarget | null
    try {
      target = await resolveContainedFsTarget(this.context, source.path, absPath)
    } catch (error) {
      return failure(error, fail('IO', 'failed to resolve target in the DSH filesystem'))
    }
    if (target === null) return fail('OUTSIDE_SOURCE', 'target is outside the configured source in the DSH filesystem')

    let content: string
    let intent: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }
    try {
      const info = await this.context.fs.stat(target, signal)
      if (item.kind === 'create') {
        if (info !== undefined && info.type === 'file') {
          const message = 'target file already exists; review the current file before creating an update or append proposal'
          await this.#inboxStore.update(item.id, { status: 'conflicted', conflictMessage: message })
          return fail('CONFLICT', message)
        }
        content = item.body
        intent = { kind: 'createIfAbsent' }
      } else {
        if (info === undefined || info.type !== 'file') return fail('CONFLICT', 'target file no longer exists; reload it')
        if (item.baseVersion === null) return fail('CONFLICT', 'proposal has no safe baseline; create a new proposal')
        if (String(info.version) !== item.baseVersion) {
          const message = 'file changed after this proposal was created; review a new baseline before applying'
          await this.#inboxStore.update(item.id, { status: 'conflicted', conflictMessage: message })
          return fail('CONFLICT', message)
        }
        if (typeof info.size === 'number' && info.size > MAX_PROPOSAL_BASELINE_BYTES) {
          return fail('TOO_LARGE', 'target file is too large to review')
        }
        const currentBytes = await this.context.fs.readBytes(target, signal, MAX_PROPOSAL_BASELINE_BYTES)
        const existing = decodeBoundedText(currentBytes)
        if (existing === null) return fail('INVALID', 'target is not valid UTF-8 text')
        const base: FsVersion = FsVersion(item.baseVersion)
        content = item.kind === 'append' ? `${existing.replace(/\s*$/u, '')}\n\n${item.body}\n` : item.body
        intent = { kind: 'replaceIfVersion', version: base }
      }
    } catch (error) {
      return failure(error, fail('IO', 'failed to read target'))
    }

    let writeTarget: FsTarget
    try {
      const rootStillPinned = await sourceRootFailure(source)
      if (rootStillPinned !== null) return rootStillPinned
      const currentAbsPath = await resolveContainedPath(source.path, relative)
      if (currentAbsPath === null) return fail('OUTSIDE_SOURCE', 'target moved outside the configured source before writing')
      if (currentAbsPath !== absPath) return fail('CONFLICT', 'target path changed while the proposal was being reviewed')
      const currentTarget = await resolveContainedFsTarget(this.context, source.path, currentAbsPath)
      if (currentTarget === null) return fail('OUTSIDE_SOURCE', 'target is outside the configured source in the DSH filesystem')
      const currentInfo = await this.context.fs.stat(currentTarget, signal)
      if (item.kind === 'create') {
        if (currentInfo !== undefined && currentInfo.type === 'file') {
          const message = 'target file already exists; review the current file before creating an update or append proposal'
          await this.#inboxStore.update(item.id, { status: 'conflicted', conflictMessage: message })
          return fail('CONFLICT', message)
        }
      } else if (currentInfo === undefined || currentInfo.type !== 'file' || String(currentInfo.version) !== item.baseVersion) {
        const message = 'file changed after this proposal was created; review a new baseline before applying'
        await this.#inboxStore.update(item.id, { status: 'conflicted', conflictMessage: message })
        return fail('CONFLICT', message)
      }
      writeTarget = currentTarget
    } catch (error) {
      return failure(error, fail('IO', 'failed to revalidate target before writing'))
    }

    try {
      const outcome = await this.context.fs.writeText(writeTarget, content, intent, signal)
      const version = String(outcome.version)
      let statusError: string | null = null
      try {
        const updated = await this.#inboxStore.update(item.id, { status: 'applied', baseVersion: version, conflictMessage: null })
        if (updated === null) statusError = 'file was written but the proposal record no longer exists'
      } catch (error) {
        statusError = errorMessage(error)
      }
      let syncError: string | null = null
      const runtime = this.#runtimes.get(item.sourceId)
      if (runtime !== undefined) {
        try {
          await runtime.sync()
        } catch (error) {
          syncError = errorMessage(error)
        }
      }
      return { ok: true, itemId: item.id, version, statusError, syncError }
    } catch (error) {
      const result = failure(error, fail('IO', 'write failed'))
      if (result.code === 'CONFLICT') {
        await this.#inboxStore.update(item.id, { status: 'conflicted', conflictMessage: result.message })
      }
      return result
    }
  }

  async dismissInboxItem(itemId: string): Promise<KnowledgeResult<{ ok: true }>> {
    let items: InboxItem[]
    try {
      items = await this.#inboxStore.list()
    } catch (error) {
      return failure(error, fail('IO', 'failed to read inbox'))
    }
    const current = items.find((entry) => entry.id === itemId) ?? null
    if (current === null) return fail('NOT_FOUND', 'proposal not found')
    const key = `${current.sourceId}\u0000${current.targetPath}`
    try {
      return await withKeyedLock(this.#targetWrites, key, async () => {
        const latestItems = await this.#inboxStore.list()
        const latest = latestItems.find((entry) => entry.id === itemId) ?? null
        if (latest === null) return fail('NOT_FOUND', 'proposal not found')
        if (latest.status === 'applied') return fail('CONFLICT', 'applied proposals cannot be dismissed')
        if (latest.status === 'dismissed') return { ok: true }
        const item = await this.#inboxStore.update(itemId, { status: 'dismissed' })
        return item === null ? fail('NOT_FOUND', 'proposal not found') : { ok: true }
      })
    } catch (error) {
      return failure(error, fail('IO', 'failed to update proposal status'))
    }
  }

  // ── Typert RPC surface (profile-scoped knowledge) ──────────────────────────

  @Remote
  async listSources(): Promise<KnowledgeResult<ListSourcesOk>> {
    await this.#ready
    await this.#settingsUpdates
    for (const source of this.#config.knowledgeSources) {
      await this.#ensureRuntime(source)
    }
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
    const source = this.#sourceOf(sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const rootFailure = await sourceRootFailure(source)
    if (rootFailure !== null) return rootFailure
    return this.browseSource(sourceId, directoryPath)
  }

  @Remote
  async indexSource(sourceId: string): Promise<KnowledgeResult<AddSourceOk>> {
    await this.#ready
    const source = this.#sourceOf(sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const runtime = await this.#ensureRuntime(source)
    if (isFailResult(runtime)) return runtime
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
  async updateInboxDraft(itemId: string, body: string): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    return this.updateInboxDraftItem(itemId, body)
  }

  @Remote
  async rebaseInbox(itemId: string, operation: RebaseOperation, signal?: AbortSignal): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
    return this.rebaseInboxItem(itemId, operation, signal)
  }

  @Remote
  async applyInbox(itemId: string, expectedRevision: number, signal?: AbortSignal): Promise<KnowledgeResult<ApplyOk>> {
    return this.applyInboxItem(itemId, expectedRevision, signal)
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

  async #markSourceProposalConflicted(item: InboxItem): Promise<boolean> {
    const key = `${item.sourceId}\u0000${item.targetPath}`
    return withKeyedLock(this.#targetWrites, key, async () => {
      const latestItems = await this.#inboxStore.list()
      const latest = latestItems.find((entry) => entry.id === item.id) ?? null
      if (latest?.status !== 'pending') return false
      return await this.#inboxStore.update(item.id, {
        status: 'conflicted', conflictMessage: SOURCE_REMOVAL_CONFLICT_MESSAGE,
      }) !== null
    })
  }

  async #restoreSourceRemovalDrafts(sourceId: string, changedIds: readonly string[]): Promise<boolean> {
    let items: InboxItem[]
    try {
      items = await this.#inboxStore.list()
    } catch {
      return false
    }
    for (const id of changedIds) {
      const item = items.find((entry) => entry.id === id && entry.sourceId === sourceId)
      if (item === undefined) continue
      const key = `${item.sourceId}\u0000${item.targetPath}`
      try {
        const restored = await withKeyedLock(this.#targetWrites, key, async () => {
          const latestItems = await this.#inboxStore.list()
          const latest = latestItems.find((entry) => entry.id === id) ?? null
          if (latest?.status !== 'conflicted' || latest.conflictMessage !== SOURCE_REMOVAL_CONFLICT_MESSAGE) return true
          return await this.#inboxStore.update(id, { status: 'pending', conflictMessage: null }) !== null
        })
        if (!restored) return false
      } catch {
        return false
      }
    }
    return true
  }

  #startRuntime(runtime: KnowledgeSourceRuntime): void {
    void runtime.sync().catch(() => undefined).finally(() => runtime.startWatch())
  }

  async #ensureRuntime(source: KnowledgeSourceConfig): Promise<KnowledgeSourceRuntime | FailResult> {
    const rootFailure = await sourceRootFailure(source)
    if (rootFailure !== null) {
      this.#rootErrors.set(source.id, rootFailure.message)
      return rootFailure
    }
    this.#rootErrors.delete(source.id)
    let runtime = this.#runtimes.get(source.id)
    if (runtime === undefined) {
      runtime = new KnowledgeSourceRuntime(source, this.#index)
      this.#runtimes.set(source.id, runtime)
      this.#startRuntime(runtime)
    }
    return runtime
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
      const rootFailure = await sourceRootFailure(source)
      if (rootFailure !== null) {
        this.#rootErrors.set(source.id, rootFailure.message)
        const existingRuntime = this.#runtimes.get(source.id)
        if (existingRuntime !== undefined) {
          this.#runtimes.delete(source.id)
          await existingRuntime.stop()
        }
        this.#index.clearSource(source.id)
        continue
      }
      this.#rootErrors.delete(source.id)
      const previous = previousById.get(source.id)
      if (previous !== undefined && sameSourceIndexingConfig(previous, source) && this.#runtimes.has(source.id)) continue
      const runtime = new KnowledgeSourceRuntime(source, this.#index)
      this.#runtimes.set(source.id, runtime)
      this.#startRuntime(runtime)
    }
  }

  #sourceOf(sourceId: string): KnowledgeSourceConfig | null {
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
      lastError: this.#rootErrors.get(sourceId) ?? runtime?.state.lastError ?? null,
    }
  }
}

export { isFailResult }
