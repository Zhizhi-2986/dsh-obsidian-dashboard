/** Client-side Typert contribution and typed RPC helpers for the
 *  dsh-obsidian `knowledge` service (mirror of host/knowledge-service.ts).
 */

import { z } from 'zod'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {
  KNOWLEDGE_SERVICE, PKG, FAIL_CODES,
  type FailResult, type AddSourceOk, type ApplyOk, type InboxItem,
  type KnowledgeSourceInfo, type ListSourcesOk, type ReadDoc,
  type SearchOk, type SearchOptions,
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
  kind: z.enum(['create', 'append', 'update']),
  title: Str,
  sourceId: Str,
  targetPath: Str,
  body: Str,
  status: z.enum(['pending', 'applied', 'dismissed', 'conflicted']),
  baseVersion: Str.nullable(),
  conflictMessage: Str.nullable(),
})
const ProposeOkSchema = z.object({ ok: z.literal(true), item: InboxItemSchema })
const InboxListOkSchema = z.object({ ok: z.literal(true), items: z.array(InboxItemSchema) })
const ApplyOkSchema = z.object({ ok: z.literal(true), itemId: Str, version: Str })
const OkSchema = z.object({ ok: z.literal(true) })

const ListSourcesResultSchema = z.union([ListSourcesOkSchema, FailResultSchema])
const AddSourceResultSchema = z.union([AddSourceOkSchema, FailResultSchema])
const SearchResultSchema = z.union([SearchOkSchema, FailResultSchema])
const ReadResultSchema = z.union([ReadDocSchema, FailResultSchema])
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

function sessionScopeParam() {
  return {
    name: 'workspaceFileScope',
    wire: 'workspaceFileScopeId',
    source: 'lookup' as const,
    lookup: 'workspaceFileScope',
    codec: {
      mode: 'strict' as const,
      typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      create: () => Str,
    },
  }
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
    parameters: [
      sessionScopeParam(),
      ...parameters.map((parameter) => parameter.codec.typeSymbol === `${PKG}/types#String`
        ? { ...parameter, codec: { ...parameter.codec, typeSymbol: `${PKG}#${KNOWLEDGE_SERVICE}/${method}:${parameter.name}` } }
        : parameter),
    ],
    result,
    ...(cancellable ? { cancellation: { parameter: 'signal' as const } } : {}),
  }
}

/** Strict Client contribution mounted via `ctx.remote.$mount`. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PKG,
  descriptors: [
    invocation('listSources', [], resultCodec(ListSourcesResultSchema, 'ListSourcesResult')),
    invocation('indexSource', [strParam('sourceId', QualifiedName)], resultCodec(AddSourceResultSchema, 'AddSourceResult'), true),
    invocation('search', [strParam('query', Str.max(256)), typedParam('options', SearchOptionsSchema, 'SearchOptions')], resultCodec(SearchResultSchema, 'SearchResult'), true),
    invocation('read', [strParam('sourceId', QualifiedName), strParam('relPath', RelPath)], resultCodec(ReadResultSchema, 'ReadResult'), true),
    invocation('proposeInbox', [typedParam('input', ProposeInputSchema, 'ProposeInput')], resultCodec(ProposeResultSchema, 'ProposeResult'), true),
    invocation('listInbox', [], resultCodec(InboxListResultSchema, 'InboxListResult')),
    invocation('applyInbox', [strParam('itemId', QualifiedName)], resultCodec(ApplyResultSchema, 'ApplyResult'), true),
    invocation('dismissInbox', [strParam('itemId', QualifiedName)], resultCodec(OkResultSchema, 'OkResult')),
  ],
}

// ── Typed call helpers on top of the mounted remote ──────────────────────────

export interface KnowledgeRpc {
  listSources(): Promise<ListSourcesOk | FailResult>
  indexSource(sourceId: string, signal?: AbortSignal): Promise<AddSourceOk | FailResult>
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchOk | FailResult>
  read(sourceId: string, relPath: string, signal?: AbortSignal): Promise<ReadDoc | FailResult>
  proposeInbox(input: {
    kind: 'create' | 'append' | 'update'
    title: string
    sourceId: string
    targetPath: string
    body: string
  }): Promise<{ ok: true; item: InboxItem } | FailResult>
  listInbox(): Promise<{ ok: true; items: InboxItem[] } | FailResult>
  applyInbox(itemId: string, signal?: AbortSignal): Promise<ApplyOk | FailResult>
  dismissInbox(itemId: string): Promise<{ ok: true } | FailResult>
}

export function knowledgeRpcOf(ctx: { readonly remote: unknown }): KnowledgeRpc {
  const remote = ctx.remote as {
    knowledge: Record<string, (...args: unknown[]) => Promise<unknown>>
  }
  return {
    listSources: async () => await (remote.knowledge.listSources() as Promise<ListSourcesOk | FailResult>),
    indexSource: async (sourceId, signal) =>
      await (remote.knowledge.indexSource(sourceId, signal) as Promise<AddSourceOk | FailResult>),
    search: async (query, options = {}, signal) =>
      await (remote.knowledge.search(query, options, signal) as Promise<SearchOk | FailResult>),
    read: async (sourceId, relPath, signal) =>
      await (remote.knowledge.read(sourceId, relPath, signal) as Promise<ReadDoc | FailResult>),
    proposeInbox: async (input) =>
      await (remote.knowledge.proposeInbox(input) as Promise<{ ok: true; item: InboxItem } | FailResult>),
    listInbox: async () =>
      await (remote.knowledge.listInbox() as Promise<{ ok: true; items: InboxItem[] } | FailResult>),
    applyInbox: async (itemId, signal) =>
      await (remote.knowledge.applyInbox(itemId, signal) as Promise<ApplyOk | FailResult>),
    dismissInbox: async (itemId) =>
      await (remote.knowledge.dismissInbox(itemId) as Promise<{ ok: true } | FailResult>),
  }
}

export type { KnowledgeSourceInfo }
