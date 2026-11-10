/** Plugins-page settings card: inbox policy only. Knowledge sources are managed in the Knowledge page. */

import type { ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ObsidianSettings } from '../shared/settings-contract.ts'
import { NS } from './locales.ts'

const s = {
  body: { display: 'flex', flexDirection: 'column' as const, gap: 12, fontFamily: 'inherit', fontSize: 13 },
}

export interface KnowledgeSettingsCardProps extends PropsLocale<typeof NS> {
  readonly view: 'summary' | 'page'
  readonly scope: ConfigForm<ObsidianSettings>
}

export function KnowledgeSettingsCard({ view, t }: KnowledgeSettingsCardProps): ReactElement {
  if (view === 'summary') return <span>{t('settingsDescription')}</span>
  return <div style={s.body}><p>{t('settingsDescription')}</p></div>
}
