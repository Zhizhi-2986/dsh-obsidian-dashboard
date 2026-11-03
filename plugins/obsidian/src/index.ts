/** dsh-obsidian Host half entry: config, inject list, plugin start/stop. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import { ObsidianConfig } from './shared/settings-contract.ts'
import { KnowledgeService } from './host/knowledge-service.ts'
import { dataDirOf } from './host/data-dir.ts'
import { settingsFromConfig, type ObsidianHostConfig } from './host/config.ts'
import { registerKnowledgeTools } from './host/tools.ts'

export const name = 'dsh-obsidian'

/** Services this plugin consumes directly on the Host side. */
export const inject = [
  'fs',
  'sessions',
  'sandboxPolicy',
  'tools',
  'typert',
]

export const Config: Schema = ObsidianConfig

export function apply(ctx: Context, config: ObsidianHostConfig): void {
  const service = new KnowledgeService(ctx, settingsFromConfig(config), dataDirOf(ctx))
  registerKnowledgeTools(ctx, service)
  ctx.on('loader/volatile-update', (paths) => {
    if (!paths.some(([key]) => key === 'inbox')) return
    void service.updateSettings(settingsFromConfig(config)).catch((error) => {
      ctx.logger('dsh-obsidian').warn(error)
    })
  })
  // Fiber unload (reload/disable) runs disposers in reverse order.
  ctx.effect(() => () => service.shutdown())
}
