/** dsh-obsidian Host half entry: config, inject list, plugin start/stop. */

import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import { ObsidianConfig, defaults, type ObsidianSettings } from './shared/settings-contract.ts'
import { KnowledgeService } from './host/knowledge-service.ts'
import { registerKnowledgeTools } from './host/tools.ts'
import { dataDirOf } from './host/data-dir.ts'

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

export function apply(ctx: Context, config: ObsidianSettings): void {
  const settings: ObsidianSettings = {
    knowledgeSources: config.knowledgeSources ?? [],
    inbox: config.inbox ?? defaults().inbox,
  }
  const dataDir = dataDirOf(ctx)
  const service = new KnowledgeService(ctx, settings, dataDir)
  registerKnowledgeTools(ctx, service)
  // Fiber unload (reload/disable) runs disposers in reverse order.
  ctx.effect(() => () => service.shutdown())
}
