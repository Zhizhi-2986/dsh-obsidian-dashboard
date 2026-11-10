import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { SourceRootIdentity } from '../shared/settings-contract.ts'

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

export async function captureSourceRootIdentity(sourceRoot: string): Promise<{ path: string; identity: SourceRootIdentity }> {
  const canonicalPath = await fs.realpath(sourceRoot)
  const info = await fs.stat(canonicalPath)
  if (!info.isDirectory()) throw new Error('knowledge source root is not a directory')
  return { path: canonicalPath, identity: { dev: String(info.dev), ino: String(info.ino) } }
}

/** Verify that the configured root still identifies the registered directory. */
export async function sourceRootIdentityMatches(sourceRoot: string, expected: SourceRootIdentity): Promise<boolean> {
  const canonicalPath = await fs.realpath(sourceRoot)
  if (canonicalPath !== sourceRoot) return false
  const info = await fs.stat(canonicalPath)
  return info.isDirectory() && String(info.dev) === expected.dev && String(info.ino) === expected.ino
}

export async function resolveContainedPath(sourceRoot: string, relativePath: string): Promise<string | null> {
  const normalized = normalizeSourceRelPath(relativePath)
  if (normalized === null) return null

  let root: string
  try {
    root = await fs.realpath(sourceRoot)
  } catch (error) {
    if (isPermissionDenied(error)) throw error
    return null
  }

  const candidate = path.resolve(root, ...normalized.split('/'))
  if (!isWithin(root, candidate, false)) return null

  let realParent: string
  try {
    realParent = await fs.realpath(path.dirname(candidate))
  } catch (error) {
    if (isPermissionDenied(error)) throw error
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
    if (isPermissionDenied(error)) throw error
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

function isPermissionDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'EACCES' || error.code === 'EPERM')
}
