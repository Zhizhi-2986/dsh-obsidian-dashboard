/** Host-side file text reads with a hard size cap (docs/notes only). */

import { promises as fs } from 'node:fs'

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Read a UTF-8 text file up to `maxBytes`; null on missing/binary/oversize. */
export async function readFileText(absPath: string, maxBytes = DEFAULT_MAX_BYTES): Promise<string | null> {
  let stat
  try {
    stat = await fs.stat(absPath)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > maxBytes) return null
  try {
    const buffer = await fs.readFile(absPath)
    if (buffer.includes(0)) return null // binary guard
    return buffer.toString('utf8')
  } catch {
    return null
  }
}
