/** Plugin data directory resolution.
 *
 * The DSH profile context (`profileContext`) exposes { dir, patchPath, home }
 * to host plugins; fall back to `$HOME/.dsh` for standalone dev runs, same
 * convention as native plugins (credentials-local writes $DSH_HOME files).
 */

import * as os from 'node:os'
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export function dataDirOf(ctx: Context): string {
  const profile = (ctx as { profileContext?: { home?: string; dir?: string } }).profileContext
  const home = profile?.home ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugins', 'dsh-obsidian')
}
