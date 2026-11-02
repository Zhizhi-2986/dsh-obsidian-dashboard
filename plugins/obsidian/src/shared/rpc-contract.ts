/** RPC contract between the dsh-obsidian Client and Host halves.
 *
 * The Host serves this contract over the DSH Typert protocol
 * (`TypertRemoteService` + `@Remote`, see `src/host/knowledge-service.ts`);
 * the Client mounts the mirror face via `ctx.remote.$mount` (see
 * `src/client/remote.ts`). Every invocation carries the Typert
 * `workspaceFileScope` lookup parameter, resolved per Session by the host.
 *
 * Values crossing the wire use `{ ok: true, ... }` / `{ ok: false, code, message }`
 * envelopes with zod schemas on both sides (workspace-files convention).
 */

import { z } from 'zod'
import { MAX_INBOX_ITEMS, SOURCE_KINDS, type KnowledgeSourceKind } from './constants.ts'
export { MAX_INBOX_ITEMS }
export type SourceKind = KnowledgeSourceKind

export const PKG = 'dsh-obsidian'
export const KNOWLEDGE_SERVICE = 'knowledge'
export const NS = 'dsh-obsidian'

export const FAIL_CODES = [
  'NOT_FOUND', 'OUT_OF_SCOPE', 'ALREADY_EXISTS', 'TOO_LARGE',
  'INVALID', 'CONFLICT', 'SANDBOX_DENIED', 'NO_SESSION', 'IO',
] as const
export type FailCode = (typeof FAIL_CODES)[number]

export const FailResultSchema = z.object({
  ok: z.literal(false),
  code: z.enum(FAIL_CODES),
  message: z.string(),
})
export type FailResult = z.infer<typeof FailResultSchema>

export function fail(code: FailCode, message: string): FailResult {
  return { ok: false, code, message }
}

export function isFailResult(value: unknown): value is FailResult {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

// ── Knowledge sources ────────────────────────────────────────────────────────


export const KnowledgeSourceInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  kind: z.enum(SOURCE_KINDS),
  /** Index freshness: null = not indexed yet. */
  indexedAt: z.number().nullable(),
  fileCount: z.number(),
  lastError: z.string().nullable(),
})
export type KnowledgeSourceInfo = z.infer<typeof KnowledgeSourceInfoSchema>

export const ListSourcesOkSchema = z.object({
  ok: z.literal(true),
  sources: z.array(KnowledgeSourceInfoSchema),
})
export type ListSourcesOk = z.infer<typeof ListSourcesOkSchema>

export const AddSourceInputSchema = z.object({
  name: z.string().min(1).max(64),
  path: z.string().min(1).max(1024),
  kind: z.enum(SOURCE_KINDS),
}).strict()
export type AddSourceInput = z.infer<typeof AddSourceInputSchema>

export const AddSourceOkSchema = z.object({
  ok: z.literal(true),
  source: KnowledgeSourceInfoSchema,
})
export type AddSourceOk = z.infer<typeof AddSourceOkSchema>

// ── Documents & search ───────────────────────────────────────────────────────

export const DocLinkSchema = z.object({
  /** Raw link target as written in the note ("[[My Note]]", "[[dir/file|alias]]"). */
  target: z.string(),
  alias: z.string().nullable(),
  /** Relative path resolved against the source root, when resolvable. */
  resolvedPath: z.string().nullable(),
})
export type DocLink = z.infer<typeof DocLinkSchema>

export const DocumentRefSchema = z.object({
  sourceId: z.string(),
  /** Path relative to the source root. */
  path: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.number().nullable(),
})
export type DocumentRef = z.infer<typeof DocumentRefSchema>

export const SearchOptionsSchema = z.object({
  /** Restrict to one source. */
  sourceId: z.string().optional(),
  /** Field scope: body, title, tags, links. Default body. */
  field: z.enum(['body', 'title', 'tags', 'links', 'all']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
export type SearchOptions = z.infer<typeof SearchOptionsSchema>

export const SearchHitSchema = DocumentRefSchema.extend({
  /** FTS snippet with highlight markers, when available. */
  snippet: z.string().nullable(),
  /** Highlighted line (1-based) in the source document, when available. */
  line: z.number().nullable(),
})
export type SearchHit = z.infer<typeof SearchHitSchema>

export const SearchOkSchema = z.object({
  ok: z.literal(true),
  query: z.string(),
  hits: z.array(SearchHitSchema),
  truncated: z.boolean(),
})
export type SearchOk = z.infer<typeof SearchOkSchema>

export const ReadDocSchema = z.object({
  ok: z.literal(true),
  sourceId: z.string(),
  path: z.string(),
  content: z.string(),
  /** Version token for guarded writes (drafting / inbox). */
  version: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  links: z.array(DocLinkSchema),
  backlinks: z.array(DocLinkSchema),
  updatedAt: z.number().nullable(),
})
export type ReadDoc = z.infer<typeof ReadDocSchema>

// ── Proposal inbox (review-before-write) ─────────────────────────────────────

export const PROPOSAL_KINDS = ['create', 'append', 'update'] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

export const InboxItemSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  kind: z.enum(PROPOSAL_KINDS),
  title: z.string(),
  /** Target: sourceId + relative path. */
  sourceId: z.string(),
  targetPath: z.string(),
  /** Proposed content for create; snippet/append text for append/update. */
  body: z.string().max(200_000),
  status: z.enum(['pending', 'applied', 'dismissed', 'conflicted']),
  /** Version token captured when the draft was proposed. */
  baseVersion: z.string().nullable(),
  conflictMessage: z.string().nullable(),
})
export type InboxItem = z.infer<typeof InboxItemSchema>

export const ProposeInputSchema = z.object({
  kind: z.enum(PROPOSAL_KINDS),
  title: z.string().min(1).max(120),
  sourceId: z.string(),
  targetPath: z.string().min(1).max(1024),
  body: z.string().min(1).max(200_000),
}).strict()
export type ProposeInput = z.infer<typeof ProposeInputSchema>

export const ApplyOkSchema = z.object({
  ok: z.literal(true),
  itemId: z.string(),
  version: z.string(),
})
export type ApplyOk = z.infer<typeof ApplyOkSchema>

// ── Wire types ───────────────────────────────────────────────────────────────

export type KnowledgeResult<T extends { ok: true }> = T | FailResult
