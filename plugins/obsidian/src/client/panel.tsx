/** Knowledge main panel: full-text search, document open, proposal inbox. */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { KnowledgeSourceInfo } from '../shared/rpc-contract.ts'
import type { InboxItem } from '../shared/rpc-contract.ts'
import type { KnowledgeRpc } from './remote.ts'
import { sessionFileAddress } from './resource-address.ts'
import { NS, type KnowledgeKey } from './locales.ts'
import { zhCN, enUS } from './locales.ts'

const PANEL_TABS = ['search', 'inbox'] as const
type PanelTab = (typeof PANEL_TABS)[number]

const s = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100%', minWidth: 0, fontFamily: 'inherit', fontSize: 13 },
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 8px', borderBottom: '1px solid rgba(127,127,127,0.18)' },
  tabs: { display: 'flex', gap: 2, padding: '8px 12px 0', borderBottom: '1px solid rgba(127,127,127,0.18)' },
  tab: (active: boolean) => ({
    padding: '5px 10px', borderRadius: 6, cursor: 'pointer', border: 'none', background: active ? 'rgba(127,127,127,0.22)' : 'transparent',
    color: 'inherit', fontSize: 12, opacity: active ? 1 : 0.7,
  }),
  searchRow: { display: 'flex', gap: 6, padding: '8px 12px', alignItems: 'center' },
  input: { flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 13 },
  select: { padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 12, maxWidth: 140 },
  body: { flex: 1, overflowY: 'auto' as const, padding: '8px 12px 16px' },
  hit: { padding: '8px 10px', borderRadius: 8, marginBottom: 6, border: '1px solid rgba(127,127,127,0.14)', background: 'rgba(127,127,127,0.06)' },
  hitTitle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 },
  hitMeta: { color: 'rgba(127,127,127,0.85)', fontSize: 11, marginTop: 2 },
  hitSnippet: { color: 'rgba(127,127,127,0.75)', fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const },
  tags: { display: 'flex', gap: 4, flexWrap: 'wrap' as const, marginTop: 4 },
  tag: { fontSize: 11, color: 'rgba(127,127,127,0.8)', padding: '1px 6px', borderRadius: 8, background: 'rgba(127,127,127,0.12)' },
  button: (tone: 'plain' | 'primary' | 'danger' = 'plain') => ({
    padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', cursor: 'pointer', fontSize: 12,
    background: tone === 'primary' ? 'rgba(68,120,255,0.85)' : tone === 'danger' ? 'rgba(210,70,70,0.75)' : 'transparent',
    color: tone === 'plain' ? 'inherit' : '#fff', opacity: 1,
  }),
  empty: { color: 'rgba(127,127,127,0.7)', padding: '24px 8px', textAlign: 'center' as const, fontSize: 12 },
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 8, marginBottom: 6, border: '1px solid rgba(127,127,127,0.14)', background: 'rgba(127,127,127,0.06)' },
  badge: (tone: string) => ({ fontSize: 10, padding: '1px 7px', borderRadius: 9, background: tone, color: '#0d0f12', fontWeight: 600 }),
  footer: { padding: '7px 12px', borderTop: '1px solid rgba(127,127,127,0.18)', color: 'rgba(127,127,127,0.75)', fontSize: 11, display: 'flex', gap: 12, flexWrap: 'wrap' as const },
}

const KIND_TONE: Record<InboxItem['kind'], string> = { create: '#8fd08a', append: '#d0b98f', update: '#8fb4d0' }
const STATUS_TONE: Record<InboxItem['status'], string> = { pending: '#d0c78f', applied: '#8fd08a', dismissed: 'rgba(127,127,127,0.3)', conflicted: '#d08f8f' }

function useLocale(ctx: ClientContext) {
  return useSyncExternalStore(
    (listener) => ctx.locale.subscribe(listener),
    () => ctx.locale.getSnapshot().active,
  )
}

/** Resolve a dictionary key for the active locale (English fallback). */
export function knowledgeT(active: string) {
  return (key: KnowledgeKey): string => {
    const dict = active.toLowerCase().startsWith('zh') ? zhCN : enUS
    return dict[key]
  }
}

/** Posix-relative path of `abs` under `cwd`, or null when outside. */
function relativeToCwd(cwd: string, abs: string): string | null {
  const c = cwd.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const a = abs.replace(/\\/gu, '/')
  if (a === c) return ''
  if (a.startsWith(`${c}/`)) return a.slice(c.length + 1)
  return null
}

/** The sidebar panel icon; the sidebar owns the button and selected state. */
export function KnowledgeIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M10 4.5C8.7 3.4 6.9 3 4.8 3 4 3 3.2 3 2.5 3.1v12.4c.7-.1 1.5-.2 2.3-.2 2.1 0 3.9.4 5.2 1.5 1.3-1.1 3.1-1.5 5.2-1.5.8 0 1.6.1 2.3.2V3.1C16.8 3 16 3 15.2 3c-2.1 0-3.9.4-5.2 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      <path d="M10 4.5v12.5" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  )
}

export interface KnowledgePanelViewProps {
  readonly ctx: ClientContext
  readonly rpc: KnowledgeRpc
}

/** Session context accessor resolved lazily at open time. */
export type SessionAccessor = () => { sessionId?: string; cwd?: string }

function hitTone(kind: InboxItem['kind']): string { return KIND_TONE[kind] }
function statusTone(status: InboxItem['status']): string { return STATUS_TONE[status] }

export function KnowledgePanelView({ ctx, rpc }: KnowledgePanelViewProps): ReactElement {
  const active = useLocale(ctx)
  const t = useMemo(() => knowledgeT(active), [active])
  // `@deepseek-ai/dsh-session` and `dsh-api-session-controller` both declare
  // `Context.sessions` (lib-level conflict hidden by skipLibCheck); narrow to
  // the controller face we use.
  const sessionsList: ObservableSnapshot<SessionListState> = (ctx.sessions as unknown as ISessions).list
  const sessions = useSyncExternalStore(
    (listener) => sessionsList.subscribe(listener),
    () => sessionsList.getSnapshot(),
  )
  const [tab, setTab] = useState<PanelTab>('search')
  const [query, setQuery] = useState('')
  const [sourceId, setSourceId] = useState<string>('')
  const [sources, setSources] = useState<KnowledgeSourceInfo[]>([])
  const [hits, setHits] = useState<{ sourceId: string; path: string; title: string; tags: string[]; snippet: string | null }[]>([])
  const [searching, setSearching] = useState(false)
  const [items, setItems] = useState<InboxItem[]>([])
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())

  const refreshSources = () => {
    void rpc.listSources().then((result) => {
      if (result.ok) setSources(result.sources)
    })
  }

  useEffect(() => {
    refreshSources()
    void rpc.listInbox().then((result) => {
      if (result.ok) setItems([...result.items].reverse())
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const uiKey = ctx.get('uiSession')?.adapter.current.getSnapshot().key
  const sessionId = typeof uiKey === 'string' ? uiKey : undefined
  const summary = sessionId ? sessions.byId[sessionId as keyof typeof sessions.byId] : undefined

  const openDocument = (source: KnowledgeSourceInfo, relPath: string) => {
    const cwd = summary?.cwd
    if (!sessionId || !cwd || !source.path) return
    const relative = relativeToCwd(cwd, `${source.path.replace(/\\/gu, '/')}/${relPath}`)
    if (relative === null) return
    ctx.sidebarRight.openResource(sessionFileAddress(sessionId, relative))
  }

  const runSearch = (searchQuery = query, searchSource = sourceId) => {
    const trimmed = searchQuery.trim()
    if (trimmed === '') { setHits([]); return }
    setSearching(true)
    void rpc.search(trimmed, { sourceId: searchSource || undefined, field: 'body', limit: 30 })
      .then((result) => {
        setHits(result.ok ? result.hits : [])
      })
      .finally(() => setSearching(false))
  }

  const applyItem = (item: InboxItem) => {
    setBusyIds((prev) => new Set(prev).add(item.id))
    void rpc.applyInbox(item.id).then((result) => {
      if (result.ok && result.itemId === item.id) {
        setItems((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, status: 'applied' as const } : entry))
      } else if (!result.ok && result.code === 'CONFLICT') {
        setItems((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, status: 'conflicted' as const, conflictMessage: result.message } : entry))
      }
    }).finally(() => {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(item.id); return next })
    })
  }

  const dismissItem = (item: InboxItem) => {
    setBusyIds((prev) => new Set(prev).add(item.id))
    void rpc.dismissInbox(item.id).then((result) => {
      if (result.ok) {
        setItems((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, status: 'dismissed' as const } : entry))
      }
    }).finally(() => {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(item.id); return next })
    })
  }

  const pendingCount = items.filter((item) => item.status === 'pending').length

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('panelLabel')}</span>
        <div style={{ flex: 1 }} />
        <button style={s.tab(tab === 'search')} onClick={() => setTab('search')}>{t('searchResults')}</button>
        <button style={s.tab(tab === 'inbox')} onClick={() => setTab('inbox')}>
          {t('inboxLabel')}{pendingCount > 0 ? ` (${pendingCount})` : ''}
        </button>
      </div>

      {tab === 'search' ? (
        <>
          <div style={s.searchRow}>
            <input
              style={s.input}
              value={query}
              placeholder={t('searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') runSearch() }}
            />
            <select style={s.select} value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              <option value="">{t('sourcesLabel')} · All</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>{source.name}</option>
              ))}
            </select>
            <button style={s.button('primary')} disabled={searching} onClick={() => runSearch()}>
              {searching ? '…' : t('searchResults')}
            </button>
          </div>
          <div style={s.body}>
            {hits.length === 0 ? (
              <div style={s.empty}>{t('searchEmpty')}</div>
            ) : hits.map((hit) => {
              const source = sources.find((entry) => entry.id === hit.sourceId)
              return (
                <div key={`${hit.sourceId}/${hit.path}`} style={s.hit}>
                  <div style={s.hitTitle}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hit.title}</span>
                    {source ? <button style={s.button()} onClick={() => void rpc.read(hit.sourceId, hit.path).then((result) => { if (result.ok && source) openDocument(source, result.path) })}>{t('openFile')}</button> : null}
                  </div>
                  <div style={s.hitMeta}>{hit.sourceId} · {hit.path}</div>
                  {hit.snippet ? <div style={s.hitSnippet}>{hit.snippet}</div> : null}
                  {hit.tags.length > 0 ? (
                    <div style={s.tags}>{hit.tags.map((tag) => <span key={tag} style={s.tag}>#{tag}</span>)}</div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <div style={s.body}>
          {items.length === 0 ? (
            <div style={s.empty}>{t('inboxEmpty')}</div>
          ) : items.map((item) => (
            <div key={item.id} style={s.row}>
              <span style={s.badge(hitTone(item.kind))}>{item.kind}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
                <div style={{ color: 'rgba(127,127,127,0.8)', fontSize: 11 }}>
                  {item.sourceId} · {item.targetPath}
                  {item.status === 'conflicted' && item.conflictMessage ? ` · ${item.conflictMessage}` : ''}
                </div>
              </div>
              {item.status === 'pending' ? (
                <button style={s.button('primary')} disabled={busyIds.has(item.id)} onClick={() => applyItem(item)}>{t('inboxApply')}</button>
              ) : (
                <span style={s.badge(statusTone(item.status))}>{t(`inbox${item.status[0].toUpperCase()}${item.status.slice(1)}` as KnowledgeKey)}</span>
              )}
              {item.status === 'pending' || item.status === 'conflicted' ? (
                <button style={s.button('danger')} disabled={busyIds.has(item.id)} onClick={() => dismissItem(item)}>{t('inboxDismiss')}</button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      <div style={s.footer}>
        {sources.map((source) => (
          <span key={source.id}>
            {source.name} · {source.fileCount}{source.lastError ? ` · ${source.lastError}` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}
