import type { Context } from '@deepseek-ai/cordis'
import type { FailResult, InboxItem, KnowledgeResult, RebaseOperation } from '../shared/rpc-contract.ts'
import { fail } from '../shared/rpc-contract.ts'
import type { KnowledgeSourceConfig } from '../shared/settings-contract.ts'
import { MAX_PROPOSAL_BASELINE_BYTES, decodeBoundedText } from './bounded-read.ts'
import { failure } from './failure.ts'
import { resolveContainedFsTarget } from './fs-target.ts'
import { InboxStore } from './inbox-store.ts'
import { normalizeSourceRelPath, resolveContainedPath } from './source-path.ts'

interface RebaseDependencies {
  readonly context: Context
  readonly ready: Promise<void>
  readonly inbox: InboxStore
  readonly sourceOf: (sourceId: string) => KnowledgeSourceConfig | null
  readonly sourceRootFailure: (source: KnowledgeSourceConfig) => Promise<FailResult | null>
  readonly withTargetLock: <T>(key: string, task: () => Promise<T>) => Promise<T>
}

interface CurrentSnapshot {
  readonly content: string
  readonly version: string
}

/** Create a new append/update proposal from a verified current-file snapshot. */
export async function rebaseInboxProposal(
  deps: RebaseDependencies,
  itemId: string,
  operation: RebaseOperation,
  signal?: AbortSignal,
): Promise<KnowledgeResult<{ ok: true; item: InboxItem }>> {
  await deps.ready
  signal?.throwIfAborted()
  let items: InboxItem[]
  try {
    items = await deps.inbox.list()
  } catch (error) {
    return failure(error, fail('IO', 'failed to read inbox'))
  }
  const initial = items.find((entry) => entry.id === itemId) ?? null
  if (initial === null) return fail('NOT_FOUND', 'proposal not found')
  const key = `${initial.sourceId}\u0000${initial.targetPath}`
  return deps.withTargetLock(key, async () => {
    const currentItems = await deps.inbox.list()
    const item = currentItems.find((entry) => entry.id === itemId) ?? null
    if (item === null) return fail('NOT_FOUND', 'proposal not found')
    if (item.status !== 'conflicted') return fail('CONFLICT', 'only conflicted proposals can be rebaselined')
    let targetKind: 'append' | 'update'
    if (item.kind === 'create') {
      if (operation === 'same') return fail('INVALID', 'choose whether to append or replace the existing file')
      targetKind = operation
    } else {
      if (operation !== 'same' && operation !== item.kind) return fail('INVALID', 'rebase operation cannot change an append/update proposal kind')
      targetKind = item.kind
    }
    const source = deps.sourceOf(item.sourceId)
    if (source === null) return fail('NOT_FOUND', 'unknown knowledge source')
    const relative = normalizeSourceRelPath(item.targetPath)
    if (relative === null) return fail('OUTSIDE_SOURCE', 'target path is outside the configured source')
    const snapshot = await captureCurrentSnapshot(deps, source, relative, signal)
    if (!snapshot.ok) return snapshot
    signal?.throwIfAborted()
    try {
      const rebased = await deps.inbox.add({
        kind: targetKind, title: item.title, sourceId: item.sourceId, targetPath: relative, body: item.body,
      }, snapshot.content, snapshot.version, item.agentId, item.id)
      if (rebased === null) return fail('TOO_LARGE', 'the inbox storage limit is reached; resolve old proposals before rebasing')
      return { ok: true, item: rebased }
    } catch (error) {
      if (signal?.aborted) throw error
      return failure(error, fail('IO', 'failed to persist rebased proposal'))
    }
  })
}

async function captureCurrentSnapshot(
  deps: RebaseDependencies,
  source: KnowledgeSourceConfig,
  relative: string,
  signal?: AbortSignal,
): Promise<KnowledgeResult<{ ok: true } & CurrentSnapshot>> {
  const rootFailure = await deps.sourceRootFailure(source)
  if (rootFailure !== null) return rootFailure
  let absolutePath: string | null
  try {
    absolutePath = await resolveContainedPath(source.path, relative)
  } catch (error) {
    return failure(error, fail('IO', 'failed to resolve current target'))
  }
  if (absolutePath === null) return fail('OUTSIDE_SOURCE', 'target resolves outside the configured source')
  try {
    const target = await resolveContainedFsTarget(deps.context, source.path, absolutePath)
    if (target === null) return fail('OUTSIDE_SOURCE', 'target is outside the configured source in the DSH filesystem')
    const before = await deps.context.fs.stat(target, signal)
    if (before?.type !== 'file') return fail('CONFLICT', 'target file no longer exists')
    if (typeof before.size === 'number' && before.size > MAX_PROPOSAL_BASELINE_BYTES) return fail('TOO_LARGE', 'target file is too large to review')
    const bytes = await deps.context.fs.readBytes(target, signal, MAX_PROPOSAL_BASELINE_BYTES)
    const content = decodeBoundedText(bytes)
    if (content === null) return fail('INVALID', 'target is not valid UTF-8 text')
    const confirmed = await deps.context.fs.stat(target, signal)
    if (confirmed?.type !== 'file' || String(confirmed.version) !== String(before.version)) {
      return fail('CONFLICT', 'target changed while capturing a new baseline; retry')
    }
    const rootStillPinned = await deps.sourceRootFailure(source)
    if (rootStillPinned !== null) return rootStillPinned
    const finalPath = await resolveContainedPath(source.path, relative)
    if (finalPath === null) return fail('OUTSIDE_SOURCE', 'target moved outside the source while capturing a new baseline')
    if (finalPath !== absolutePath) return fail('CONFLICT', 'target path changed while capturing a new baseline')
    const finalTarget = await resolveContainedFsTarget(deps.context, source.path, finalPath)
    if (finalTarget === null) return fail('OUTSIDE_SOURCE', 'target is outside the configured source in the DSH filesystem')
    const finalInfo = await deps.context.fs.stat(finalTarget, signal)
    if (finalInfo?.type !== 'file' || String(finalInfo.version) !== String(before.version)) {
      return fail('CONFLICT', 'target changed while capturing a new baseline; retry')
    }
    signal?.throwIfAborted()
    return { ok: true, content, version: String(before.version) }
  } catch (error) {
    if (signal?.aborted) throw error
    return failure(error, fail('IO', 'failed to capture a new proposal baseline'))
  }
}
