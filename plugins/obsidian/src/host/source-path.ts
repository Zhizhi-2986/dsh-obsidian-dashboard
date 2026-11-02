import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** Resolve a source-relative file while rejecting lexical traversal and symlinks.
 *  Symlink entries are deliberately rejected, including links that point back inside
 *  the source, to keep reads/writes pinned to ordinary files. Missing leaf files are
 *  allowed for create proposals, but their parent must exist inside the source root. */
export function normalizeSourceRelPath(relativePath: string): string | null {
  if (
    relativePath === '' || relativePath.includes('\0') || relativePath.length > 1024 ||
    /^[A-Za-z]:[/\\]/u.test(relativePath)
  ) return null
  const normalizedInput = relativePath.replace(/\\/gu, '/')
  if (normalizedInput.startsWith('/') || normalizedInput.split('/').includes('..')) return null
  const normalized = path.posix.normalize(normalizedInput)
  return normalized === '' || normalized === '.' || normalized.startsWith('../') ? null : normalized
}

export async function resolveContainedPath(sourceRoot: string, relativePath: string): Promise<string | null> {
  const normalized = normalizeSourceRelPath(relativePath)
  if (normalized === null) return null

  let root: string
  try {
    root = await fs.realpath(sourceRoot)
  } catch {
    return null
  }

  const candidate = path.resolve(root, ...normalized.split('/'))
  if (!isWithin(root, candidate, false)) return null

  let realParent: string
  try {
    realParent = await fs.realpath(path.dirname(candidate))
  } catch {
    return null
  }
  if (!isWithin(root, realParent, true)) return null

  try {
    const info = await fs.lstat(candidate)
    if (info.isSymbolicLink()) return null
    const realTarget = await fs.realpath(candidate)
    return isWithin(root, realTarget, false) ? realTarget : null
  } catch (error) {
    if (isMissing(error)) return path.join(realParent, path.basename(candidate))
    return null
  }
}

function isWithin(root: string, candidate: string, allowRoot: boolean): boolean {
  const relative = path.relative(root, candidate)
  if (relative === '') return allowRoot
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
