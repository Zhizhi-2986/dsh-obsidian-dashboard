/** Read-only Agent tools for dsh-obsidian.
 *
 * Writes are deliberately NOT exposed to the Agent: the design mandates
 * review-before-write through the proposal inbox (UI-gated). Only the
 * indexed search and document read surface reach the Agent loop.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { KnowledgeService } from './knowledge-service.ts'

export function registerKnowledgeTools(ctx: Context, service: KnowledgeService): void {
  ctx.tools.register(defineKnowledgeSearch(service))
  ctx.tools.register(defineKnowledgeRead(service))
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
    async execute(args: { query: string; sourceId?: string; field?: 'body' | 'title' | 'tags' | 'all'; limit?: number }) {
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
  }
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
    async execute(args: { sourceId: string; path: string }) {
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
  }
}
