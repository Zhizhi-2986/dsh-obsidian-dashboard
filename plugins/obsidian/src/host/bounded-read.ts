import { promises as fs } from 'node:fs'

export const MAX_PROPOSAL_BASELINE_BYTES = 4 * 1024 * 1024
const TEXT_BINARY_SAMPLE_BYTES = 8192

export async function readHandleTextBounded(
  handle: Awaited<ReturnType<typeof fs.open>>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  while (totalBytes <= maxBytes) {
    signal?.throwIfAborted()
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - totalBytes))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    totalBytes += bytesRead
    if (totalBytes > maxBytes) throw Object.assign(new Error('file exceeds the read limit'), { code: 'FS_TOO_LARGE' })
    chunks.push(buffer.subarray(0, bytesRead))
  }
  return decodeText(Buffer.concat(chunks, totalBytes))
}

export function decodeBoundedText(bytes: Uint8Array): string | null {
  try {
    return decodeText(bytes)
  } catch {
    return null
  }
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.subarray(0, TEXT_BINARY_SAMPLE_BYTES).includes(0)) {
    throw Object.assign(new Error('file is not text'), { code: 'FS_NOT_TEXT' })
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw Object.assign(new Error('file is not valid UTF-8 text'), { code: 'FS_NOT_TEXT' })
  }
}
