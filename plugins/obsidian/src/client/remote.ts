/** Client-side Typert contribution and typed RPC helpers for the
 *  dsh-obsidian `knowledge` service (mirror of host/knowledge-service.ts).
 */

import { z } from 'zod'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {
  KNOWLEDGE_SERVICE, PKG, FAIL_CODES, InboxRevisionSchema, REBASE_OPERATIONS, fail,
  type FailResult, type AddSourceInput, type AddSourceOk, type ApplyOk, type BrowseOk, type InboxItem, type RebaseOperation,
  type KnowledgeSourceInfo, type ListSourcesOk, type ReadDoc,
  type SearchOk, type SearchOptions,
  type SaveDocumentInput, type SaveDocumentOk,
} from '../shared/rpc-contract.ts'

const Str = z.string()
const QualifiedName = Str.max(64)
const RelPath = Str.min(1).max(1024)

const FailResultSchema = z.object({ ok: z.literal(false), code: z.enum(FAIL_CODES), message: z.string() })

const KnowledgeSourceInfoSchema = z.object({
  id: Str,
  name: Str,
  path: Str,
  kind: z.enum(['vault', 'folder']),
  indexedAt: z.number().nullable(),
  fileCount: z.number(),
  lastError: Str.nullable(),
})
const ListSourcesOkSchema = z.object({ ok: z.literal(true), sources: z.array(KnowledgeSourceInfoSchema) })
const DocumentRefSchema = z.object({
  sourceId: Str,
  path: Str,
  title: Str,
  tags: z.array(Str),
  updatedAt: z.number().nullable(),
})
const BrowseOkSchema = z.object({
  ok: z.literal(true),
  sourceId: Str,
  directoryPath: Str,
  directories: z.array(Str),
  documents: z.array(DocumentRefSchema),
})
const AddSourceInputSchema = z.object({
  name: Str.min(1).max(64),
  path: Str.min(1).max(1024),
  kind: z.enum(['vault', 'folder']),
}).strict()
const AddSourceOkSchema = z.object({ ok: z.literal(true), source: KnowledgeSourceInfoSchema })
const SearchOptionsSchema = z.object({
  sourceId: Str.optional(),
  field: z.enum(['body', 'title', 'tags', 'links', 'all']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
const SearchHitSchema = z.object({
  sourceId: Str,
  path: Str,
  title: Str,
  tags: z.array(Str),
  updatedAt: z.number().nullable(),
  snippet: Str.nullable(),
  line: z.number().nullable(),
})
const SearchOkSchema = z.object({ ok: z.literal(true), query: Str, hits: z.array(SearchHitSchema), truncated: z.boolean() })
const DocLinkSchema = z.object({ target: Str, alias: Str.nullable(), resolvedPath: Str.nullable() })
const ReadDocSchema = z.object({
  ok: z.literal(true),
  sourceId: Str,
  path: Str,
  content: Str,
  version: Str,
  title: Str,
  tags: z.array(Str),
  links: z.array(DocLinkSchema),
  backlinks: z.array(DocLinkSchema),
  updatedAt: z.number().nullable(),
})
const SaveDocumentInputSchema = z.object({ sourceId: Str, path: RelPath, content: Str.max(4_194_304), expectedVersion: Str.nullable(), expectedContent: Str.max(4_194_304).nullable() }).strict()
const SaveDocumentOkSchema = z.object({ ok: z.literal(true), version: Str, syncError: Str.nullable() })
const ProposeInputSchema = z.object({
  kind: z.enum(['create', 'append', 'update']),
  title: Str.min(1).max(120),
  sourceId: Str,
  targetPath: RelPath,
  body: Str.min(1).max(200_000),
}).strict()
const InboxItemSchema = z.object({
  id: Str,
  createdAt: z.number(),
  revision: InboxRevisionSchema,
  kind: z.enum(['create', 'append', 'update']),
  title: Str,
  sourceId: Str,
  targetPath: Str,
  agentId: Str.nullable(),
  rebasedFrom: Str.nullable(),
  body: Str,
  baselineContent: Str.max(4_194_304),
  status: z.enum(['pending', 'applied', 'dismissed', 'conflicted']),
  baseVersion: Str.nullable(),
  conflictMessage: Str.nullable(),
})
const RebaseOperationSchema = z.enum(REBASE_OPERATIONS)
const ProposeOkSchema = z.object({ ok: z.literal(true), item: InboxItemSchema })
const InboxListOkSchema = z.object({ ok: z.literal(true), items: z.array(InboxItemSchema) })
const ApplyOkSchema = z.object({ ok: z.literal(true), itemId: Str, version: Str, statusError: Str.nullable(), syncError: Str.nullable() })
const OkSchema = z.object({ ok: z.literal(true) })

const ListSourcesResultSchema = z.union([ListSourcesOkSchema, FailResultSchema])
const BrowseResultSchema = z.union([BrowseOkSchema, FailResultSchema])
const AddSourceResultSchema = z.union([AddSourceOkSchema, FailResultSchema])
const SearchResultSchema = z.union([SearchOkSchema, FailResultSchema])
const ReadResultSchema = z.union([ReadDocSchema, FailResultSchema])
const SaveDocumentResultSchema = z.union([SaveDocumentOkSchema, FailResultSchema])
const ProposeResultSchema = z.union([ProposeOkSchema, FailResultSchema])
const InboxListResultSchema = z.union([InboxListOkSchema, FailResultSchema])
const ApplyResultSchema = z.union([ApplyOkSchema, FailResultSchema])
const OkResultSchema = z.union([OkSchema, FailResultSchema])

function strParam(name: string, schema: z.ZodType = Str) {
  return {
    name,
    wire: name,
    source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol: `${PKG}/types#String`, create: () => schema },
  }
}

function typedParam(name: string, schema: z.ZodType, typeName: string) {
  const param = strParam(name, schema)
  return { ...param, codec: { ...param.codec, typeSymbol: `${PKG}/types#${typeName}` } }
}

function resultCodec(schema: z.ZodType, typeSymbol: string) {
  return { mode: 'strict' as const, typeSymbol: `${PKG}/types#${typeSymbol}`, create: () => schema }
}

function invocation(method: string, parameters: ReturnType<typeof strParam>[], result: ReturnType<typeof resultCodec>, cancellable = false) {
  return {
    id: `${PKG}#${KNOWLEDGE_SERVICE}/${method}`,
    service: KNOWLEDGE_SERVICE,
    namespace: KNOWLEDGE_SERVICE,
    method,
    invocation: { kind: 'direct' as const },
    parameters: parameters.map((parameter) => parameter.codec.typeSymbol === `${PKG}/types#String`
      ? { ...parameter, codec: { ...parameter.codec, typeSymbol: `${PKG}#${KNOWLEDGE_SERVICE}/${method}:${parameter.name}` } }
      : parameter),
    result,
    ...(cancellable ? { cancellation: { parameter: 'signal' as const } } : {}),
  }
}

/** Strict Client contribution mounted via `ctx.remote.$mount`. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PKG,
  descriptors: [
    invocation('listSources', [], resultCodec(ListSourcesResultSchema, 'ListSourcesResult')),
    invocation('addSource', [typedParam('input', AddSourceInputSchema, 'AddSourceInput')], resultCodec(AddSourceResultSchema, 'AddSourceResult'), true),
    invocation('removeSource', [strParam('sourceId', QualifiedName)], resultCodec(OkResultSchema, 'OkResult')),
    invocation('browse', [strParam('sourceId', QualifiedName), strParam('directoryPath', Str.max(1024))], resultCodec(BrowseResultSchema, 'BrowseResult')),
    invocation('indexSource', [strParam('sourceId', QualifiedName)], resultCodec(AddSourceResultSchema, 'AddSourceResult'), true),
    invocation('search', [strParam('query', Str.max(256)), typedParam('options', SearchOptionsSchema, 'SearchOptions')], resultCodec(SearchResultSchema, 'SearchResult'), true),
    invocation('read', [strParam('sourceId', QualifiedName), strParam('relPath', RelPath)], resultCodec(ReadResultSchema, 'ReadResult'), true),
    invocation('saveDocument', [typedParam('input', SaveDocumentInputSchema, 'SaveDocumentInput')], resultCodec(SaveDocumentResultSchema, 'SaveDocumentResult'), true),
    invocation('proposeInbox', [typedParam('input', ProposeInputSchema, 'ProposeInput')], resultCodec(ProposeResultSchema, 'ProposeResult'), true),
    invocation('listInbox', [], resultCodec(InboxListResultSchema, 'InboxListResult')),
    invocation('updateInboxDraft', [strParam('itemId', QualifiedName), strParam('body', Str.max(200_000))], resultCodec(ProposeResultSchema, 'ProposeResult')),
    invocation('rebaseInbox', [strParam('itemId', QualifiedName), typedParam('operation', RebaseOperationSchema, 'RebaseOperation')], resultCodec(ProposeResultSchema, 'ProposeResult'), true),
    invocation('applyInbox', [strParam('itemId', QualifiedName), typedParam('expectedRevision', InboxRevisionSchema, 'InboxRevision')], resultCodec(ApplyResultSchema, 'ApplyResult'), true),
    invocation('dismissInbox', [strParam('itemId', QualifiedName)], resultCodec(OkResultSchema, 'OkResult')),
  ],
}

// ── Typed call helpers on top of the mounted remote ──────────────────────────

export interface KnowledgeRpc {
  listSources(): Promise<ListSourcesOk | FailResult>
  addSource(input: AddSourceInput, signal?: AbortSignal): Promise<AddSourceOk | FailResult>
  removeSource(sourceId: string): Promise<{ ok: true } | FailResult>
  browse(sourceId: string, directoryPath: string): Promise<BrowseOk | FailResult>
  indexSource(sourceId: string, signal?: AbortSignal): Promise<AddSourceOk | FailResult>
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchOk | FailResult>
  read(sourceId: string, relPath: string, signal?: AbortSignal): Promise<ReadDoc | FailResult>
  saveDocument(input: SaveDocumentInput, signal?: AbortSignal): Promise<SaveDocumentOk | FailResult>
  proposeInbox(input: {
    kind: 'create' | 'append' | 'update'
    title: string
    sourceId: string
    targetPath: string
    body: string
  }): Promise<{ ok: true; item: InboxItem } | FailResult>
  listInbox(): Promise<{ ok: true; items: InboxItem[] } | FailResult>
  updateInboxDraft(itemId: string, body: string): Promise<{ ok: true; item: InboxItem } | FailResult>
  rebaseInbox(itemId: string, operation?: RebaseOperation, signal?: AbortSignal): Promise<{ ok: true; item: InboxItem } | FailResult>
  applyInbox(itemId: string, expectedRevision: number, signal?: AbortSignal): Promise<ApplyOk | FailResult>
  dismissInbox(itemId: string): Promise<{ ok: true } | FailResult>
}

function unwrapGatewayResponse<T>(response: unknown): T | FailResult {
  if (typeof response !== 'object' || response === null || !('ok' in response)) {
    throw new Error('invalid DSH Gateway response envelope')
  }
  const envelope = response as { ok: boolean; value?: unknown; error?: unknown }
  if (envelope.ok && 'value' in envelope) return envelope.value as T
  if (!envelope.ok && 'error' in envelope) {
    const error = envelope.error
    const message = error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error)
    return fail('IO', message)
  }
  throw new Error('invalid DSH Gateway response envelope')
}

export function knowledgeRpcOf(ctx: { readonly remote: unknown }): KnowledgeRpc {
  const remote = ctx.remote as {
    knowledge: Record<string, (...args: unknown[]) => Promise<unknown>>
  }
  const invoke = async <T,>(method: string, ...args: unknown[]): Promise<T | FailResult> =>
    unwrapGatewayResponse<T>(await remote.knowledge[method](...args))
  return {
    listSources: async () => await invoke<ListSourcesOk>('listSources'),
    addSource: async (input, signal) => await invoke<AddSourceOk>('addSource', input, signal),
    removeSource: async (sourceId) => await invoke<{ ok: true }>('removeSource', sourceId),
    browse: async (sourceId, directoryPath) => await invoke<BrowseOk>('browse', sourceId, directoryPath),
    indexSource: async (sourceId, signal) => await invoke<AddSourceOk>('indexSource', sourceId, signal),
    search: async (query, options = {}, signal) => await invoke<SearchOk>('search', query, options, signal),
    read: async (sourceId, relPath, signal) => await invoke<ReadDoc>('read', sourceId, relPath, signal),
    saveDocument: async (input, signal) => await invoke<SaveDocumentOk>('saveDocument', input, signal),
    proposeInbox: async (input) => await invoke<{ ok: true; item: InboxItem }>('proposeInbox', input),
    listInbox: async () => await invoke<{ ok: true; items: InboxItem[] }>('listInbox'),
    updateInboxDraft: async (itemId, body) => await invoke<{ ok: true; item: InboxItem }>('updateInboxDraft', itemId, body),
    rebaseInbox: async (itemId, operation, signal) => await invoke<{ ok: true; item: InboxItem }>('rebaseInbox', itemId, operation ?? 'same', signal),
    applyInbox: async (itemId, expectedRevision, signal) => await invoke<ApplyOk>('applyInbox', itemId, expectedRevision, signal),
    dismissInbox: async (itemId) => await invoke<{ ok: true }>('dismissInbox', itemId),
  }
}

export type { KnowledgeSourceInfo }
