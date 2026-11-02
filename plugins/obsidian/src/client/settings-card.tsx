/** Plugins-page settings card: knowledge source list, add/remove, inbox policy. */

import { useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ObsidianSettings } from '../shared/settings-contract.ts'
import type { KnowledgeSourceInfo, SourceKind } from '../shared/rpc-contract.ts'
import type { KnowledgeRpc } from './remote.ts'
import { NS } from './locales.ts'
import { knowledgeT } from './panel.tsx'
import { uniqueSourceId } from './source-id.ts'

const s = {
  body: { display: 'flex', flexDirection: 'column' as const, gap: 12, fontFamily: 'inherit', fontSize: 13 },
  readOnly: { color: 'rgba(210,120,60,0.9)', fontSize: 12 },
  card: { border: '1px solid rgba(127,127,127,0.2)', borderRadius: 10, padding: '12px 14px' },
  row: { display: 'flex', alignItems: 'center' as const, gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(127,127,127,0.12)' },
  meta: { flex: 1, minWidth: 0, fontSize: 12 },
  metaTitle: { fontWeight: 600 },
  metaSub: { color: 'rgba(127,127,127,0.75)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  badge: (kind: SourceKind) => ({
    fontSize: 10, padding: '1px 7px', borderRadius: 9, background: kind === 'vault' ? 'rgba(143,208,138,0.85)' : 'rgba(143,180,208,0.85)', color: '#0d0f12', fontWeight: 600,
  }),
  field: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  label: { fontSize: 12, color: 'rgba(127,127,127,0.85)' },
  input: { padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 13 },
  select: { padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 12 },
  actions: { display: 'flex', gap: 8 },
  button: (tone: 'plain' | 'primary' | 'danger' = 'plain') => ({
    padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', cursor: 'pointer', fontSize: 12,
    background: tone === 'primary' ? 'rgba(68,120,255,0.85)' : tone === 'danger' ? 'rgba(210,70,70,0.75)' : 'transparent',
    color: tone === 'plain' ? 'inherit' : '#fff',
  }),
  hint: { color: 'rgba(127,127,127,0.7)', fontSize: 11 },
  checkboxRow: { display: 'flex', alignItems: 'center' as const, gap: 8 },
}

export interface KnowledgeSettingsCardProps extends PropsRuntime<'plugins.item'>, PropsLocale<typeof NS> {
  readonly ctx: ClientContext
  readonly rpc: KnowledgeRpc
  readonly scope: ConfigForm<ObsidianSettings>
}

const MAX_SOURCES = 20

export function KnowledgeSettingsCard(props: KnowledgeSettingsCardProps): ReactElement | null {
  const { ctx, rpc, scope, view, t } = props
  const snap = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const active = useSyncExternalStore(
    (listener) => ctx.locale.subscribe(listener),
    () => ctx.locale.getSnapshot().active,
  )
  const kt = useMemo(() => knowledgeT(active), [active])
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [kind, setKind] = useState<SourceKind>('folder')
  const [addError, setAddError] = useState<string | null>(null)
  const writable = snap.writable

  if (view === 'summary') return <span>{kt('settingsDescription')}</span>
  const value = snap.value
  if (snap.status !== 'ready' || value === undefined) return null

  const sources = value.knowledgeSources ?? []
  const setSources = async (next: ObsidianSettings['knowledgeSources']): Promise<boolean> => {
    if (!writable || saving) return false
    setSaving(true)
    try {
      return await scope.set('knowledgeSources', next)
    } finally {
      setSaving(false)
    }
  }

  const addSource = async (): Promise<void> => {
    setAddError(null)
    const trimmedName = name.trim()
    const trimmedPath = dirPath.trim().replace(/\/+$/u, '')
    if (trimmedName === '' || trimmedPath === '') { setAddError(t('settingsSourceName')); return }
    if (sources.some((source) => source.path === trimmedPath)) { setAddError('path'); return }
    if (sources.length >= MAX_SOURCES) { setAddError('max'); return }
    const id = uniqueSourceId(trimmedName, sources.map((source) => source.id))
    const accepted = await setSources([...sources, {
      id, name: trimmedName, path: trimmedPath, kind,
      include: [], exclude: [],
    }])
    if (accepted) {
      setName('')
      setDirPath('')
    }
  }

  const removeSource = async (id: string): Promise<void> => {
    await setSources(sources.filter((source) => source.id !== id))
  }

  const errorText = (code: string | null): string => {
    if (code === 'path') return t('settingsSourcePath')
    if (code === 'max') return `MAX_SOURCES (${MAX_SOURCES})`
    return code ?? ''
  }

  return (
    <div style={s.body}>
      <p>{t('settingsDescription')}</p>
      {!writable ? <p style={s.readOnly} role="status">readOnly</p> : null}

      <div style={s.card}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('sourcesLabel')}</div>
        {sources.length === 0 ? <p style={s.hint}>{t('settingsNoSources')}</p> : null}
        {sources.map((source) => (
          <div key={source.id} style={s.row}>
            <span style={s.badge(source.kind)}>{source.kind === 'vault' ? t('settingsSourceKindVault') : t('settingsSourceKindFolder')}</span>
            <div style={s.meta}>
              <div style={s.metaTitle}>{source.name}</div>
              <div style={s.metaSub}>{source.path}</div>
            </div>
            <button style={s.button('danger')} disabled={!writable || saving} onClick={() => void removeSource(source.id)}>{t('settingsSourceRemove')}</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <div style={s.field}>
            <label style={s.label}>{t('settingsSourceName')}</label>
            <input style={s.input} value={name} disabled={!writable} onChange={(event) => setName(event.target.value)} />
          </div>
          <div style={{ ...s.field, flex: 1, minWidth: 180 }}>
            <label style={s.label}>{t('settingsSourcePath')}</label>
            <input style={s.input} value={dirPath} disabled={!writable} placeholder="/absolute/path/to/vault" onChange={(event) => setDirPath(event.target.value)} />
          </div>
          <div style={s.field}>
            <label style={s.label}>{t('settingsSourceKind')}</label>
            <select style={s.select} value={kind} disabled={!writable} onChange={(event) => setKind(event.target.value as SourceKind)}>
              <option value="folder">{t('settingsSourceKindFolder')}</option>
              <option value="vault">{t('settingsSourceKindVault')}</option>
            </select>
          </div>
          <div style={{ ...s.actions, alignItems: 'flex-end' }}>
            <button style={s.button('primary')} disabled={!writable || saving} onClick={() => void addSource()}>{t('settingsSourceAdd')}</button>
          </div>
        </div>
        {addError ? <p style={{ ...s.hint, color: 'rgba(210,120,80,0.9)' }}>{errorText(addError)}</p> : null}
        <p style={s.hint}>{t('settingsPickDirectory')}</p>
      </div>

      <div style={s.card}>
        <label style={s.checkboxRow}>
          <input
            type="checkbox"
            checked={value.inbox.keepDraftOnConflict === true}
            disabled={!writable || saving}
            onChange={(event) => { void scope.set('inbox', { ...value.inbox, keepDraftOnConflict: event.target.checked }) }}
          />
          <span>{t('settingsInboxKeeDraft')}</span>
        </label>
        <p style={s.hint}>{t('settingsInboxKeepDraftHint')}</p>
      </div>
    </div>
  )
}
