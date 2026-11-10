/** Host-side bounded UTF-8 reads for indexing. */

import { constants as fsConstants, promises as fs } from 'node:fs'
import { readHandleTextBounded } from './bounded-read.ts'
import { resolveContainedPath } from './source-path.ts'

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

interface ReadSnapshot {
  readonly text: string
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
  readonly size: number
}

/** Read a regular UTF-8 text file through a no-follow handle with a hard byte cap.
 * Missing/non-regular/binary entries are ignored; permission, I/O, and growth
 * errors propagate so the index runtime can report them instead of deleting docs. */
export async function readFileText(absPath: string, maxBytes = DEFAULT_MAX_BYTES): Promise<string | null> {
  const snapshot = await readFileSnapshot(absPath, maxBytes)
  return snapshot?.text ?? null
}

/** Resolve a source-relative file again before and after the bounded handle read. */
export async function readSourceFileText(sourceRoot: string, relativePath: string, maxBytes = DEFAULT_MAX_BYTES): Promise<string | null> {
  const absolutePath = await resolveContainedPath(sourceRoot, relativePath)
  if (absolutePath === null) throw Object.assign(new Error('indexed path is outside or linked outside the configured source'), { code: 'OUTSIDE_SOURCE' })
  const snapshot = await readFileSnapshot(absolutePath, maxBytes)
  if (snapshot === null) return null

  const verifiedPath = await resolveContainedPath(sourceRoot, relativePath)
  if (verifiedPath === null || verifiedPath !== absolutePath) {
    throw Object.assign(new Error('indexed path changed outside the configured source while reading'), { code: 'OUTSIDE_SOURCE' })
  }
  let current
  try {
    current = await fs.stat(verifiedPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.mtimeMs !== snapshot.mtimeMs || current.size !== snapshot.size) {
    throw Object.assign(new Error('indexed file changed after it was read'), { code: 'FS_STALE_VERSION' })
  }
  return snapshot.text
}

async function readFileSnapshot(absPath: string, maxBytes: number): Promise<ReadSnapshot | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
    const nonBlocking = fsConstants.O_NONBLOCK ?? 0
    handle = await fs.open(absPath, fsConstants.O_RDONLY | noFollow | nonBlocking)
    const before = await handle.stat()
    if (!before.isFile()) return null
    if (before.size > maxBytes) throw Object.assign(new Error('file exceeds the index read limit'), { code: 'FS_TOO_LARGE' })

    let text: string
    try {
      text = await readHandleTextBounded(handle, maxBytes)
    } catch (error) {
      if (errorCode(error) === 'FS_NOT_TEXT') return null
      throw error
    }
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
      throw Object.assign(new Error('file changed while indexing'), { code: 'FS_STALE_VERSION' })
    }
    return { text, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, size: after.size }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
