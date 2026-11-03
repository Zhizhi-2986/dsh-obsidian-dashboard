/** Agent tools for dsh-obsidian.
 *
 * Agents can search/read notes and submit bounded proposals to the review inbox.
 * They cannot write source files: only a user action in the UI applies a proposal.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ProposeInputSchema, type ProposeInput } from '../shared/rpc-contract.ts'
import type { KnowledgeService } from './knowledge-service.ts'

type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }

export function registerKnowledgeTools(ctx: Context, service: KnowledgeService): void {
  ctx.tools.register(defineTool(defineKnowledgeSearch(service)))
  ctx.tools.register(defineTool(defineKnowledgeRead(service)))
  ctx.tools.register(defineTool(defineKnowledgePropose(service)))
}

function defineKnowledgeSearch(service: KnowledgeService) {
  return {
    name: 'knowledge_search',
    description: 'Full-text search over the dsh-obsidian knowledge workspace ' +
      '(indexed notes of configured knowledge sources). Returns matching notes ' +
      'with title, source, tags, and a highlighted snippet. Use before ' +
      'knowledge_read to locate the exact note.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search terms; whitespace-separated terms are matched as any-of.',
      },
      sourceId: {
        type: 'string',
        description: 'Restrict the search to one knowledge source id; omit to search all sources.',
      },
      field: {
        type: 'string',
        enum: ['body', 'title', 'tags', 'all'],
        description: 'Field scope to search; defaults to body.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum hits to return; defaults to 10, capped at 100.',
      },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args: { query: string; sourceId?: string; field?: 'body' | 'title' | 'tags' | 'all'; limit?: number }): Promise<ToolJson> {
      const result = await service.searchSources(args.query, {
        sourceId: args.sourceId,
        field: args.field,
        limit: Math.min(args.limit ?? 10, 100),
      })
      if (!result.ok) {
        return { ok: false, code: result.code, message: result.message, hits: [] }
      }
      return {
        ok: true,
        query: result.query,
        hits: result.hits.map((hit) => ({
          sourceId: hit.sourceId,
          path: hit.path,
          title: hit.title,
          tags: hit.tags,
          snippet: hit.snippet,
        })),
        truncated: result.truncated,
      }
    },
  } as const
}

function defineKnowledgeRead(service: KnowledgeService) {
  return {
    name: 'knowledge_read',
    description: 'Read a note from a dsh-obsidian knowledge source by its ' +
      'sourceId and relative path (as returned by knowledge_search). Returns ' +
      'the full markdown content, frontmatter-derived title, tags, outbound ' +
      'links, and backlinks.',
    parameters: {
      sourceId: {
        type: 'string',
        required: true,
        description: 'Knowledge source id that contains the note.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'Path of the note relative to the source root, e.g. notes/foo.md.',
      },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args: { sourceId: string; path: string }): Promise<ToolJson> {
      const result = await service.readSource(args.sourceId, args.path)
      if (!result.ok) {
        return { ok: false, code: result.code, message: result.message }
      }
      return {
        ok: true,
        sourceId: result.sourceId,
        path: result.path,
        title: result.title,
        tags: result.tags,
        links: result.links,
        backlinks: result.backlinks,
        content: result.content,
      }
    },
  } as const
}

function defineKnowledgePropose(service: KnowledgeService) {
  return {
    name: 'knowledge_propose',
    description: 'Submit a create, append, or update proposal to the dsh-obsidian ' +
      'knowledge inbox for human review. This only creates a pending draft; it ' +
      'never writes or modifies the source file. The user must review and apply it.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['create', 'append', 'update'],
        description: 'Proposal operation: create a note, append text, or propose a replacement.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Short human-readable proposal title (1–120 characters).',
      },
      sourceId: {
        type: 'string',
        required: true,
        description: 'Configured knowledge source id, usually from knowledge_search.',
      },
      targetPath: {
        type: 'string',
        required: true,
        description: 'Target path relative to the configured source root, e.g. notes/foo.md.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'Proposed Markdown content (1–200000 characters).',
      },
    },
    output: {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args: ProposeInput): Promise<ToolJson> {
      const parsed = ProposeInputSchema.safeParse(args)
      if (!parsed.success) return { ok: false, code: 'INVALID', message: 'invalid proposal input' }
      const result = await service.propose(parsed.data.sourceId, parsed.data)
      if (!result.ok) {
        return { ok: false, code: result.code, message: result.message }
      }
      return {
        ok: true,
        itemId: result.item.id,
        title: result.item.title,
        kind: result.item.kind,
        sourceId: result.item.sourceId,
        targetPath: result.item.targetPath,
        status: result.item.status,
      }
    },
  } as const
}
