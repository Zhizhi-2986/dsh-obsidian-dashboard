/** Shared settings contract for dsh-obsidian (Host Config + Client ConfigForm).

 * All writable fields must be schemastery `.volatile()`: the DSH settings
 * pipeline rejects non-volatile writes with a hard error (audit D: dsh-settings
 * /lib/index.js:122,505-507). Keep this contract declarative and JSON-safe.
 */

import z from '@deepseek-ai/schemastery'
import { SOURCE_KINDS, type KnowledgeSourceKind } from './constants.ts'
export { MAX_INBOX_ITEMS, SOURCE_KINDS } from './constants.ts'
export type { KnowledgeSourceKind } from './constants.ts'

export const MAX_SOURCES = 20
export const MAX_SOURCE_NAME_LENGTH = 64
export const MAX_SOURCE_PATH_LENGTH = 1024
export const MAX_PROPOSAL_TITLE_LENGTH = 120
export const MAX_PROPOSAL_BODY_CHARS = 200_000

/** Knowledge source kinds. `vault` = Obsidian-style vault (Wikilinks, tags,
 * frontmatter, attachments); `folder` = plain directory of documents. */

export interface KnowledgeSourceConfig {
  /** Stable id used by the RPC and the index. Never a user-visible label. */
  readonly id: string
  readonly name: string
  readonly path: string
  readonly kind: KnowledgeSourceKind
  /** Include subpaths (relative to source root), empty = everything. */
  readonly include: readonly string[]
  /** Exclude subpaths (relative to source root). */
  readonly exclude: readonly string[]
}

export interface InboxSettings {
  /** Versions: keep a proposal draft on conflict instead of failing silently. */
  readonly keepDraftOnConflict: boolean
}

export interface ObsidianSettings {
  /** Legacy bootstrap only; the Knowledge page persists active sources in sources.json. */
  readonly knowledgeSources: readonly KnowledgeSourceConfig[]
  readonly inbox: InboxSettings
}

const KnowledgeSource = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(MAX_SOURCE_NAME_LENGTH),
  path: z.string().min(1).max(MAX_SOURCE_PATH_LENGTH),
  kind: z.union(SOURCE_KINDS),
  include: z.array(z.string().max(256)).max(20).default([]),
  exclude: z.array(z.string().max(256)).max(20).default([]),
})

export const ObsidianConfig: ReturnType<typeof z.object> = z.object({
  knowledgeSources: z.array(KnowledgeSource).max(MAX_SOURCES).default([]).volatile(),
  inbox: z.object({
    keepDraftOnConflict: z.boolean().default(true),
  }).default({ keepDraftOnConflict: true }).volatile(),
})

export function defaults(): ObsidianSettings {
  return { knowledgeSources: [], inbox: { keepDraftOnConflict: true } }
}
