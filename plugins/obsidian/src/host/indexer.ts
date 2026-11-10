/** Knowledge index backed by node:sqlite FTS5.
 *
 * One database per plugin data directory; each document row carries its
 * source id. FTS virtual table is tokenized with `porter unicode61` and
 * ships `snippet()` highlight markers for the client. All operations are
 * synchronous (`DatabaseSync`), matching the Host-half usage pattern.
 */

import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from './private-storage.ts'
import { DatabaseSync } from 'node:sqlite'
import type { DocLink, DocumentRef, SearchHit } from '../shared/rpc-contract.ts'
import type { ParsedLink } from './markdown.ts'

export interface IndexedDoc {
  readonly sourceId: string
  readonly relPath: string
  readonly title: string
  readonly tags: readonly string[]
  readonly mtimeMs: number | null
}

const FTS_COLUMNS = ['source_id', 'rel_path', 'title', 'tags', 'body'] as const
const BODY_COLUMN_INDEX = FTS_COLUMNS.indexOf('body')

export class KnowledgeIndex {
  readonly #db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.#db = db
  }

  static open(file: string): KnowledgeIndex {
    if (file !== ':memory:') {
      ensurePrivateDirectorySync(dirname(file))
      ensurePrivateFileSync(file)
    }
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        source_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        mtime_ms INTEGER,
        PRIMARY KEY (source_id, rel_path)
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        source_id UNINDEXED,
        rel_path UNINDEXED,
        title,
        tags,
        body,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS links (
        source_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        target TEXT NOT NULL,
        resolved_path TEXT,
        PRIMARY KEY (source_id, rel_path, target)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS links_resolved ON links (source_id, resolved_path);
    `)
    return new KnowledgeIndex(db)
  }

  close(): void {
    this.#db.close()
  }

  /** Recreate the FTS content for one document. */
  upsertDoc(sourceId: string, relPath: string, title: string, tags: readonly string[], body: string, mtimeMs: number | null): void {
    const tagsJson = JSON.stringify(tags)
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare(`
        INSERT INTO docs (source_id, rel_path, title, tags, mtime_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (source_id, rel_path) DO UPDATE SET
          title = excluded.title, tags = excluded.tags, mtime_ms = excluded.mtime_ms
      `).run(sourceId, relPath, title, tagsJson, mtimeMs)
      this.#db.prepare('DELETE FROM docs_fts WHERE source_id = ? AND rel_path = ?').run(sourceId, relPath)
      this.#db.prepare(`
        INSERT INTO docs_fts (source_id, rel_path, title, tags, body)
        VALUES (?, ?, ?, ?, ?)
      `).run(sourceId, relPath, title, tagsJson, body)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  deleteDoc(sourceId: string, relPath: string): void {
    this.#db.prepare('DELETE FROM docs WHERE source_id = ? AND rel_path = ?').run(sourceId, relPath)
    this.#db.prepare('DELETE FROM docs_fts WHERE source_id = ? AND rel_path = ?').run(sourceId, relPath)
    this.#db.prepare('DELETE FROM links WHERE source_id = ? AND rel_path = ?').run(sourceId, relPath)
  }

  clearSource(sourceId: string): void {
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare('DELETE FROM docs WHERE source_id = ?').run(sourceId)
      this.#db.prepare('DELETE FROM docs_fts WHERE source_id = ?').run(sourceId)
      this.#db.prepare('DELETE FROM links WHERE source_id = ?').run(sourceId)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  /** Immediate indexed folders and note files under one source-relative directory. */
  listDirectory(sourceId: string, directoryPath: string): { directories: string[]; documents: DocumentRef[] } {
    const normalizedDirectory = directoryPath.endsWith('/') ? directoryPath.slice(0, -1) : directoryPath
    const prefix = normalizedDirectory === '' ? '' : `${normalizedDirectory}/`
    const directoryRows = this.#db.prepare(`
      SELECT DISTINCT substr(rest, 1, instr(rest, '/') - 1) AS name
      FROM (
        SELECT substr(rel_path, length(?) + 1) AS rest
        FROM docs
        WHERE source_id = ? AND substr(rel_path, 1, length(?)) = ?
      )
      WHERE instr(rest, '/') > 0
      ORDER BY name
    `).all(prefix, sourceId, prefix, prefix) as Array<{ name: string }>
    const rows = this.#db.prepare(`
      SELECT rel_path, title, tags, mtime_ms
      FROM docs
      WHERE source_id = ?
        AND substr(rel_path, 1, length(?)) = ?
        AND instr(substr(rel_path, length(?) + 1), '/') = 0
      ORDER BY rel_path
    `).all(sourceId, prefix, prefix, prefix) as Array<{
      rel_path: string
      title: string
      tags: string
      mtime_ms: number | null
    }>
    return {
      directories: directoryRows.map((row) => row.name),
      documents: rows.map((row) => ({
        sourceId,
        path: row.rel_path,
        title: row.title,
        tags: JSON.parse(row.tags) as string[],
        updatedAt: row.mtime_ms,
      })),
    }
  }

  /** All indexed relative paths of one source (for link resolution). */
  knownPaths(sourceId: string): Set<string> {
    const rows = this.#db.prepare('SELECT rel_path FROM docs WHERE source_id = ?').all(sourceId) as Array<{ rel_path: string }>
    return new Set(rows.map((row) => row.rel_path))
  }

  countDocs(sourceId: string): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM docs WHERE source_id = ?').get(sourceId) as { n: number }
    return row.n
  }

  getDoc(sourceId: string, relPath: string): IndexedDoc | null {
    const row = this.#db.prepare('SELECT source_id, rel_path, title, tags, mtime_ms FROM docs WHERE source_id = ? AND rel_path = ?').get(sourceId, relPath) as
      | { source_id: string; rel_path: string; title: string; tags: string; mtime_ms: number | null }
      | undefined
    if (row === undefined) return null
    return {
      sourceId: row.source_id,
      relPath: row.rel_path,
      title: row.title,
      tags: JSON.parse(row.tags) as string[],
      mtimeMs: row.mtime_ms,
    }
  }

  setLinks(sourceId: string, relPath: string, links: readonly ParsedLink[], known: ReadonlySet<string>): void {
    this.#db.exec('BEGIN')
    try {
      this.#db.prepare('DELETE FROM links WHERE source_id = ? AND rel_path = ?').run(sourceId, relPath)
      const insert = this.#db.prepare('INSERT OR IGNORE INTO links (source_id, rel_path, target, resolved_path) VALUES (?, ?, ?, ?)')
      for (const link of links) {
        insert.run(sourceId, relPath, link.target, link.alias)
        // Resolve against known vault paths: primary target, then alias.
        const resolved = resolveOne(link, known)
        if (resolved !== null) {
          this.#db.prepare('UPDATE links SET resolved_path = ? WHERE source_id = ? AND rel_path = ? AND target = ?')
            .run(resolved, sourceId, relPath, link.target)
        }
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  outLinks(sourceId: string, relPath: string): DocLink[] {
    const rows = this.#db.prepare('SELECT target, resolved_path FROM links WHERE source_id = ? AND rel_path = ?').all(sourceId, relPath) as Array<{ target: string; resolved_path: string | null }>
    return rows.map((row) => ({ target: row.target, alias: null, resolvedPath: row.resolved_path }))
  }

  backLinks(sourceId: string, relPath: string): DocLink[] {
    const rows = this.#db.prepare(`
      SELECT l.target, l.rel_path AS from_path
      FROM links l
      WHERE l.source_id = ? AND l.resolved_path = ?
      ORDER BY l.rel_path
    `).all(sourceId, relPath) as Array<{ target: string; from_path: string }>
    return rows.map((row) => ({ target: row.target, alias: null, resolvedPath: row.from_path }))
  }

  /** Field-scoped full-text search with `snippet` highlights. */
  search(sourceId: string | undefined, field: 'body' | 'title' | 'tags' | 'links' | 'all' | undefined, rawQuery: string, limit: number): SearchHit[] {
    if (field === 'links') return this.#searchLinks(sourceId, rawQuery, limit)
    const ftsQuery = toFtsQuery(rawQuery)
    if (ftsQuery === '') return []

    const column = field === 'title' ? 'title' : field === 'tags' ? 'tags' : 'body'
    const matchQuery = field === undefined || field === 'all' ? ftsQuery : `${column} : (${ftsQuery})`
    const lineStart = `\uE000${randomUUID()}\uE001`
    const lineEnd = `\uE002${randomUUID()}\uE003`
    let sql = `
      WITH matching AS MATERIALIZED (
      SELECT d.source_id, d.rel_path, d.title, d.tags, d.mtime_ms,
             snippet(docs_fts, ${BODY_COLUMN_INDEX}, '⟦', '⟧', ' … ', 24) AS snippet,
             highlight(docs_fts, ${BODY_COLUMN_INDEX}, '${lineStart}', '${lineEnd}') AS marked_body,
             rank AS score
      FROM docs_fts
      JOIN docs d ON d.source_id = docs_fts.source_id AND d.rel_path = docs_fts.rel_path
      WHERE docs_fts MATCH ?
    `
    const params: Array<string | number> = [matchQuery]
    if (sourceId !== undefined) {
      sql += ' AND d.source_id = ?'
      params.push(sourceId)
    }
    sql += `
      )
      SELECT source_id, rel_path, title, tags, mtime_ms, snippet,
        CASE WHEN instr(marked_body, ?) = 0 THEN NULL ELSE
          length(substr(marked_body, 1, instr(marked_body, ?) - 1)) -
          length(replace(substr(marked_body, 1, instr(marked_body, ?) - 1), char(10), '')) + 1
        END AS line
      FROM matching
    `
    params.push(lineStart, lineStart, lineStart)
    sql += ' ORDER BY score LIMIT ?'
    params.push(limit)

    const rows = this.#db.prepare(sql).all(...params) as Array<{
      source_id: string
      rel_path: string
      title: string
      tags: string
      mtime_ms: number | null
      snippet: string | null
      line: number | null
    }>
    return rows.map((row) => ({
      sourceId: row.source_id,
      path: row.rel_path,
      title: row.title,
      tags: JSON.parse(row.tags) as string[],
      updatedAt: row.mtime_ms,
      snippet: row.snippet,
      line: row.line,
    }))
  }

  #searchLinks(sourceId: string | undefined, rawQuery: string, limit: number): SearchHit[] {
    const terms = toSearchTerms(rawQuery)
    if (terms.length === 0) return []
    const clauses = terms.map(() => 'instr(lower(l.target), lower(?)) > 0').join(' OR ')
    let sql = `
      SELECT DISTINCT d.source_id, d.rel_path, d.title, d.tags, d.mtime_ms,
             NULL AS snippet, NULL AS line
      FROM docs d
      JOIN links l ON l.source_id = d.source_id AND l.rel_path = d.rel_path
      WHERE (${clauses})
    `
    const params: Array<string | number> = [...terms]
    if (sourceId !== undefined) {
      sql += ' AND d.source_id = ?'
      params.push(sourceId)
    }
    sql += ' ORDER BY d.mtime_ms DESC LIMIT ?'
    params.push(limit)
    const rows = this.#db.prepare(sql).all(...params) as Array<{
      source_id: string
      rel_path: string
      title: string
      tags: string
      mtime_ms: number | null
      snippet: string | null
      line: number | null
    }>
    return rows.map((row) => ({
      sourceId: row.source_id,
      path: row.rel_path,
      title: row.title,
      tags: JSON.parse(row.tags) as string[],
      updatedAt: row.mtime_ms,
      snippet: row.snippet,
      line: row.line,
    }))
  }

  /** Tag prefix search over indexed tags. */
  searchTags(prefix: string, limit: number): Array<{ tag: string; count: number }> {
    const rows = this.#db.prepare(`
      SELECT j.value AS tag, COUNT(*) AS count
      FROM docs, json_each(docs.tags) AS j
      WHERE j.value LIKE ?
      GROUP BY j.value
      ORDER BY count DESC, tag ASC
      LIMIT ?
    `).all(`${prefix}%`, limit) as Array<{ tag: string; count: number }>
    return rows
  }
}

function resolveOne(link: ParsedLink, known: ReadonlySet<string>): string | null {
  const candidates = [link.target, link.alias].filter((candidate): candidate is string => candidate !== null && candidate !== '')
  for (const candidate of candidates) {
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

/** Convert free-form user input into a safe FTS5 query: OR-ed quoted phrases
 *  per whitespace-separated chunk, each chunk trimmed of FTS punctuation.
 *  `"deep dive"` → `"deep dive"`, `one two` → `"one" OR "two"`. */
export function toFtsQuery(raw: string): string {
  return toSearchTerms(raw).map((chunk) => `"${chunk}"`).join(' OR ')
}

function toSearchTerms(raw: string): string[] {
  return raw
    .replace(/["'*:^~(){}[\]\\-]+/gu, ' ')
    .split(/\s+/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
}
