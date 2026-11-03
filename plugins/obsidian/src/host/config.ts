import type { Volatile } from '@deepseek-ai/cordis'
import type { InboxSettings, KnowledgeSourceConfig, ObsidianSettings } from '../shared/settings-contract.ts'

/** Cordis resolves `.volatile()` Config fields as Volatile references, not plain values. */
export interface ObsidianHostConfig {
  readonly knowledgeSources: Volatile<KnowledgeSourceConfig[]>
  readonly inbox: Volatile<InboxSettings>
}

/** Take a detached value snapshot for one Host service update. */
export function settingsFromConfig(config: ObsidianHostConfig): ObsidianSettings {
  return {
    knowledgeSources: config.knowledgeSources.get(),
    inbox: config.inbox.get(),
  }
}
