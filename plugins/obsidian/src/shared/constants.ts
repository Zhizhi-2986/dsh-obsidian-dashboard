/** Runtime-safe constants shared by host settings and client RPC schemas. */

export const MAX_INBOX_ITEMS = 200
export const SOURCE_KINDS = ['vault', 'folder'] as const
export type KnowledgeSourceKind = (typeof SOURCE_KINDS)[number]
