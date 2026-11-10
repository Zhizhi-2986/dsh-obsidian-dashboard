/** Directory walker for knowledge sources (Host half, node:fs based).
 *
 * Reads use plain node:fs (the sandbox confines *mutations*; reads are
 * unconfined per dsh-fs-sandbox), which keeps bulk scans fast over large
 * vaults. All *writes* in dsh-obsidian go through `ctx.fs` version-guarded
 * writes instead (see knowledge-service.ts).
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { resolveContainedPath } from './source-path.ts'

export interface ScannedFile {
  /** Path relative to the source root, using `/` separators. */
  readonly relPath: string
  readonly absPath: string
  readonly mtimeMs: number
  readonly size: number
}

export interface ScanOptions {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
  /** Extensions indexed as notes (lower-cased). Defaults to md + txt. */
  readonly noteExtensions?: readonly string[]
}

const DEFAULT_NOTE_EXTENSIONS = ['.md', '.markdown', '.txt'] as const

/** Directories always skipped, vault or plain folder. */
const ALWAYS_IGNORED = new Set([
  '.git', '.hg', '.svn', '.obsidian', '.trash', '.smart-connections',
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv',
  '.DS_Store',
])

function isIgnoredDir(name: string): boolean {
  return ALWAYS_IGNORED.has(name) || name.startsWith('.') && name !== '.'
}

/** Normalize a relative include/exclude pattern (POSIX separators). */
export function normalizeRel(p: string): string {
  return p.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '')
}

function matches(relPath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false
  const rel = normalizeRel(relPath)
  return patterns.some((pattern) => {
    const normalized = normalizeRel(pattern)
    if (normalized === '') return false
    return rel === normalized || rel.startsWith(`${normalized}/`)
  })
}

function isIncluded(relPath: string, options: ScanOptions): boolean {
  if (matches(relPath, options.exclude)) return false
  if (options.include.length === 0) return true
  return matches(relPath, options.include)
}

/** Recursively walk a source root; returns notes (and their parents are
 *  implied). Skipped dirs are never descended into. */
export async function scanSource(
  root: string,
  options: ScanOptions = { include: [], exclude: [] },
  signal?: AbortSignal,
): Promise<ScannedFile[]> {
  const sourceRoot = await fs.realpath(root)
  const extensions = options.noteExtensions ?? DEFAULT_NOTE_EXTENSIONS
  const accepted = new Set(extensions.map((ext) => ext.toLowerCase()))
  const results: ScannedFile[] = []

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (signal?.aborted) throw new DOMException('scan aborted', 'AbortError')
    if (dirRel !== '') {
      const verifiedDirectory = await resolveContainedPath(sourceRoot, dirRel)
      if (verifiedDirectory === null || verifiedDirectory !== dirAbs) {
        throw Object.assign(new Error('indexed directory escaped the configured source'), { code: 'OUTSIDE_SOURCE' })
      }
    }
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch (error) {
      // Missing nested directories can be ordinary concurrent removals. A
      // missing root or other I/O failure must abort the scan so callers do
      // not mistake an incomplete listing for an empty source.
      if (dirRel === '' || !isMissing(error)) throw error
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (signal?.aborted) throw new DOMException('scan aborted', 'AbortError')
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue
        if (!isIncluded(`${rel}/`, options)) continue
        await walk(path.join(dirAbs, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!accepted.has(ext)) continue
      if (!isIncluded(rel, options)) continue
      const candidate = path.join(dirAbs, entry.name)
      let pathInfo
      try {
        pathInfo = await fs.lstat(candidate)
      } catch (error) {
        if (!isMissing(error)) throw error
        continue
      }
      if (pathInfo.isSymbolicLink()) {
        throw Object.assign(new Error('indexed file became a symbolic link'), { code: 'OUTSIDE_SOURCE' })
      }
      if (!pathInfo.isFile()) continue
      const verifiedPath = await resolveContainedPath(sourceRoot, rel)
      if (verifiedPath === null || verifiedPath !== candidate) {
        throw Object.assign(new Error('indexed file escaped the configured source'), { code: 'OUTSIDE_SOURCE' })
      }
      const stat = await fs.stat(verifiedPath)
      results.push({ relPath: rel, absPath: verifiedPath, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }

  await walk(sourceRoot, '')
  return results
}

/** Strip the note extension from a relative path for title fallback. */
export function fileStemOf(relPath: string): string {
  const base = path.posix.basename(relPath)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Absolute → source-relative conversion guard: reject paths outside root. */
export function toSourceRel(root: string, absPath: string): string | null {
  const rel = path.relative(root, absPath)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/gu, '/')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
