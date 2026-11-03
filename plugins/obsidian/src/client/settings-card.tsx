/** Plugins-page settings card: inbox policy only. Knowledge sources are managed in the Knowledge page. */

import { useSyncExternalStore, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ObsidianSettings } from '../shared/settings-contract.ts'
import { NS } from './locales.ts'

const s = {
  body: { display: 'flex', flexDirection: 'column' as const, gap: 12, fontFamily: 'inherit', fontSize: 13 },
  card: { border: '1px solid rgba(127,127,127,0.2)', borderRadius: 10, padding: '12px 14px' },
  hint: { color: 'rgba(127,127,127,0.7)', fontSize: 11 },
  checkboxRow: { display: 'flex', alignItems: 'center' as const, gap: 8 },
}

export interface KnowledgeSettingsCardProps extends PropsLocale<typeof NS> {
  readonly view: 'summary' | 'page'
  readonly scope: ConfigForm<ObsidianSettings>
}

export function KnowledgeSettingsCard({ scope, view, t }: KnowledgeSettingsCardProps): ReactElement | null {
  const snap = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )

  if (view === 'summary') return <span>{t('settingsDescription')}</span>
  const value = snap.value
  if (snap.status !== 'ready' || value === undefined) return null

  return (
    <div style={s.body}>
      <p>{t('settingsDescription')}</p>
      <div style={s.card}>
        <label style={s.checkboxRow}>
          <input
            type="checkbox"
            checked={value.inbox.keepDraftOnConflict === true}
            disabled={!snap.writable}
            onChange={(event) => { void scope.set('inbox', { ...value.inbox, keepDraftOnConflict: event.target.checked }) }}
          />
          <span>{t('settingsInboxKeeDraft')}</span>
        </label>
        <p style={s.hint}>{t('settingsInboxKeepDraftHint')}</p>
      </div>
    </div>
  )
}
