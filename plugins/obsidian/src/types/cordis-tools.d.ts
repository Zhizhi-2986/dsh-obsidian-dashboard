/** Module augmentation: expose the tools registry on the Cordis Context.
 *
 * Kept in its own file with a top-level import so this is a *module
 * augmentation* of the real @deepseek-ai/cordis package (preserving its
 * exports), not a shadowing ambient declaration.
 */

import '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: {
      register(tool: ToolDefinition): void
    }
  }
}
