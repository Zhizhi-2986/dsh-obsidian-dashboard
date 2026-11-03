/** Knowledge main panel: full-text search, document open, proposal inbox. */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, useRef, type ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowseOk, InboxItem, KnowledgeSourceInfo, ReadDoc, SourceKind } from '../shared/rpc-contract.ts'
import type { KnowledgeRpc } from './remote.ts'
import { pickDirectory } from './directory-picker.ts'
import { NS, type KnowledgeKey } from './locales.ts'
import { zhCN, enUS } from './locales.ts'

const PANEL_TABS = ['search', 'browse', 'sources', 'preview', 'inbox'] as const
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
  browseToolbar: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid rgba(127,127,127,0.14)' },
  breadcrumb: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', color: 'rgba(127,127,127,0.8)', fontSize: 11, overflowX: 'auto' as const },
  folderButton: { width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', marginBottom: 5, borderRadius: 7, border: '1px solid rgba(127,127,127,0.14)', background: 'rgba(127,127,127,0.05)', color: 'inherit', textAlign: 'left' as const, cursor: 'pointer' },
  sourceForm: { display: 'flex', flexDirection: 'column' as const, gap: 10, maxWidth: 720, margin: '12px auto', padding: 16, borderRadius: 10, border: '1px solid rgba(127,127,127,0.2)', background: 'rgba(127,127,127,0.04)' },
  sourceRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid rgba(127,127,127,0.12)' },
  sourceLabel: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 12, color: 'rgba(127,127,127,0.85)' },
  sourceInput: { padding: '7px 9px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.3)', background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 13 },
  previewToolbar: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid rgba(127,127,127,0.14)' },
  previewContent: { margin: 0, padding: 16, whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const, lineHeight: 1.65, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
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

function hitTone(kind: InboxItem['kind']): string { return KIND_TONE[kind] }
function statusTone(status: InboxItem['status']): string { return STATUS_TONE[status] }

export function KnowledgePanelView({ ctx, rpc }: KnowledgePanelViewProps): ReactElement {
  const active = useLocale(ctx)
  const t = useMemo(() => knowledgeT(active), [active])
  const [tab, setTab] = useState<PanelTab>('search')
  const [query, setQuery] = useState('')
  const [sourceId, setSourceId] = useState<string>('')
  const [browseSourceId, setBrowseSourceId] = useState<string>('')
  const [browsePath, setBrowsePath] = useState('')
  const [browseResult, setBrowseResult] = useState<BrowseOk | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [previewDocument, setPreviewDocument] = useState<ReadDoc | null>(null)
  const [previewReturnTab, setPreviewReturnTab] = useState<'search' | 'browse'>('search')
  const [sources, setSources] = useState<KnowledgeSourceInfo[]>([])
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [newSourceName, setNewSourceName] = useState('')
  const [newSourcePath, setNewSourcePath] = useState('')
  const [newSourceKind, setNewSourceKind] = useState<SourceKind>('folder')
  const [sourceSaving, setSourceSaving] = useState(false)
  const [sourcePicking, setSourcePicking] = useState(false)
  const [sourceFormError, setSourceFormError] = useState<string | null>(null)
  const [hits, setHits] = useState<{ sourceId: string; path: string; title: string; tags: string[]; snippet: string | null }[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [items, setItems] = useState<InboxItem[]>([])
  const [inboxError, setInboxError] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const sourceRefreshSequence = useRef(0)
  const browseSelection = browseSourceId || sources[0]?.id || ''
  const selectedBrowseSource = sources.find((source) => source.id === browseSelection)

  const refreshSources = useCallback(async (): Promise<void> => {
    const requestId = ++sourceRefreshSequence.current
    try {
      const result = await rpc.listSources()
      if (requestId !== sourceRefreshSequence.current) return
      if (result.ok) {
        setSources(result.sources)
        setSourceError(null)
      } else {
        setSourceError(result.message)
      }
    } catch (error) {
      if (requestId === sourceRefreshSequence.current) {
        setSourceError(error instanceof Error ? error.message : String(error))
      }
    }
  }, [rpc])

  const chooseSourceDirectory = async (): Promise<void> => {
    setSourcePicking(true)
    setSourceFormError(null)
    try {
      const desktop = (globalThis as typeof globalThis & {
        __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> }
      }).__DSH_DIRECTORY_PICKER__
      const workspace = desktop ? undefined : (ctx as unknown as {
        get(name: string): { pickDirectory(): Promise<string | null> } | undefined
      }).get('uiWorkspace')
      const selected = await pickDirectory(desktop, workspace)
      if (selected !== null) {
        setNewSourcePath(selected)
        const folderName = selected.replace(/\\/gu, '/').replace(/\/+$/u, '').split('/').pop()
        if (folderName) setNewSourceName((previous) => previous.trim() === '' ? folderName : previous)
      }
    } catch {
      setSourceFormError(t('settingsPickerFailed'))
    } finally {
      setSourcePicking(false)
    }
  }

  const addSource = async (): Promise<void> => {
    setSourceFormError(null)
    setSourceSaving(true)
    try {
      const result = await rpc.addSource({ name: newSourceName, path: newSourcePath, kind: newSourceKind })
      if (!result.ok) {
        setSourceFormError(result.message)
        return
      }
      setNewSourceName('')
      setNewSourcePath('')
      setBrowsePath('')
      setBrowseSourceId(result.source.id)
      await refreshSources()
      setTab('browse')
    } catch (error) {
      setSourceFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSourceSaving(false)
    }
  }

  const removeSource = async (source: KnowledgeSourceInfo): Promise<void> => {
    setSourceFormError(null)
    setBusyIds((prev) => new Set(prev).add(source.id))
    try {
      const result = await rpc.removeSource(source.id)
      if (result.ok) {
        sourceRefreshSequence.current += 1
        setSources((prev) => prev.filter((entry) => entry.id !== source.id))
        if (browseSourceId === source.id) {
          setBrowseSourceId('')
          setBrowsePath('')
        }
      } else {
        setSourceFormError(result.message)
      }
    } catch (error) {
      setSourceFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(source.id); return next })
    }
  }

  const needsSourceRefresh = sources.some((source) => source.indexedAt === null && source.lastError === null)

  useEffect(() => {
    if (tab === 'inbox') return
    void refreshSources()
  }, [refreshSources, tab])

  useEffect(() => {
    if (!needsSourceRefresh) return
    const timer = setInterval(() => { void refreshSources() }, 750)
    return () => clearInterval(timer)
  }, [refreshSources, needsSourceRefresh])

  useEffect(() => {
    void rpc.listInbox().then((result) => {
      if (result.ok) {
        setItems([...result.items].reverse())
        setInboxError(null)
      } else {
        setInboxError(result.message)
      }
    }).catch((error) => setInboxError(error instanceof Error ? error.message : String(error)))
  }, [rpc])

  useEffect(() => {
    if (tab !== 'browse' || browseSelection === '') {
      setBrowseResult(null)
      setBrowseError(null)
      setBrowseLoading(false)
      return
    }
    if (selectedBrowseSource?.indexedAt === null && selectedBrowseSource.lastError === null) {
      setBrowseResult(null)
      setBrowseError(null)
      setBrowseLoading(true)
      return
    }
    let cancelled = false
    setBrowseLoading(true)
    setBrowseError(null)
    setBrowseResult(null)
    void rpc.browse(browseSelection, browsePath).then((result) => {
      if (cancelled) return
      if (result.ok) setBrowseResult(result)
      else setBrowseError(result.message)
    }).catch((error) => {
      if (!cancelled) setBrowseError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (!cancelled) setBrowseLoading(false)
    })
    return () => { cancelled = true }
  }, [tab, browseSelection, browsePath, selectedBrowseSource?.indexedAt, selectedBrowseSource?.lastError, rpc])

  const readAndPreviewDocument = async (source: KnowledgeSourceInfo, relPath: string): Promise<void> => {
    setOpenError(null)
    try {
      const result = await rpc.read(source.id, relPath)
      if (result.ok) {
        setPreviewReturnTab(tab === 'browse' ? 'browse' : 'search')
        setPreviewDocument(result)
        setTab('preview')
      } else {
        setOpenError(result.message)
      }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    }
  }

  const runSearch = (searchQuery = query, searchSource = sourceId) => {
    const trimmed = searchQuery.trim()
    setSearchError(null)
    if (trimmed === '') { setHits([]); return }
    setSearching(true)
    void rpc.search(trimmed, { sourceId: searchSource || undefined, field: 'all', limit: 30 })
      .then((result) => {
        if (result.ok) setHits(result.hits)
        else { setHits([]); setSearchError(result.message) }
      })
      .catch((error) => {
        setHits([])
        setSearchError(error instanceof Error ? error.message : String(error))
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
        <button style={s.tab(tab === 'browse')} onClick={() => setTab('browse')}>{t('browseLabel')}</button>
        {previewDocument ? <button style={s.tab(tab === 'preview')} onClick={() => setTab('preview')}>{t('previewLabel')}</button> : null}
        <button style={s.tab(tab === 'sources')} onClick={() => setTab('sources')}>{t('sourcesLabel')}</button>
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
            {sourceError ? <div style={s.empty} role="alert">{sourceError}</div> : null}
            {openError ? <div style={s.empty} role="alert">{openError}</div> : null}
            {searchError ? <div style={s.empty} role="alert">{t('searchFailed')}: {searchError}</div> : null}
            {hits.length === 0 && !searchError ? (
              <div style={s.empty}>{query.trim() === '' ? t('searchIdle') : t('searchEmpty')}</div>
            ) : hits.map((hit) => {
              const source = sources.find((entry) => entry.id === hit.sourceId)
              return (
                <div key={`${hit.sourceId}/${hit.path}`} style={s.hit}>
                  <div style={s.hitTitle}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hit.title}</span>
                    {source ? <button style={s.button()} onClick={() => void readAndPreviewDocument(source, hit.path)}>{t('openFile')}</button> : null}
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
      ) : tab === 'preview' ? (
        <>
          <div style={s.previewToolbar}>
            <button style={s.button()} onClick={() => setTab(previewReturnTab)}>{t('previewBack')}</button>
            {previewDocument ? (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{previewDocument.title}</div>
                <div style={s.hitMeta}>{previewDocument.sourceId} · {previewDocument.path}</div>
              </div>
            ) : null}
          </div>
          {openError ? <div style={s.empty} role="alert">{openError}</div> : null}
          {previewDocument?.tags.length ? (
            <div style={s.tags}>{previewDocument.tags.map((tag) => <span key={tag} style={s.tag}>#{tag}</span>)}</div>
          ) : null}
          <div style={{ ...s.body, padding: 0 }}>
            {previewDocument ? <pre style={s.previewContent}>{previewDocument.content}</pre> : null}
          </div>
        </>
      ) : tab === 'browse' ? (
        <>
          <div style={s.browseToolbar}>
            <select
              style={s.select}
              value={browseSelection}
              onChange={(event) => { setBrowseSourceId(event.target.value); setBrowsePath('') }}
            >
              <option value="">{t('browseSelectSource')}</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select>
            {browseResult ? <span style={s.hitMeta}>{browseResult.documents.length} · {browseResult.directoryPath || '/'}</span> : null}
          </div>
          {browseResult ? (
            <div style={s.breadcrumb}>
              <button style={s.button()} onClick={() => setBrowsePath('')}>{sources.find((source) => source.id === browseSelection)?.name ?? t('browseLabel')}</button>
              {browseResult.directoryPath.split('/').filter(Boolean).map((segment, index, segments) => (
                <span key={`${index}/${segment}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>/</span>
                  <button style={s.button()} onClick={() => setBrowsePath(segments.slice(0, index + 1).join('/'))}>{segment}</button>
                </span>
              ))}
            </div>
          ) : null}
          <div style={s.body}>
            {sourceError ? <div style={s.empty} role="alert">{sourceError}</div> : null}
            {openError ? <div style={s.empty} role="alert">{openError}</div> : null}
            {selectedBrowseSource?.lastError ? <div style={s.empty} role="alert">{selectedBrowseSource.lastError}</div> : null}
            {browseError ? <div style={s.empty} role="alert">{t('browseFailed')}: {browseError}</div> : null}
            {!browseSelection ? (
              <div style={s.empty}>
                {t('browseSelectSource')}
                <div style={{ marginTop: 10 }}>
                  <button style={s.button('primary')} onClick={() => setTab('sources')}>{t('settingsSourceAdd')}</button>
                </div>
              </div>
            ) : null}
            {browseSelection && browseLoading && browseResult === null ? <div style={s.empty}>{t('browseLoading')}</div> : null}
            {browseSelection && !browseLoading && browseResult && browseResult.directories.length === 0 && browseResult.documents.length === 0 ? (
              <div style={s.empty}>{t('browseEmpty')}</div>
            ) : null}
            {browseResult ? (
              <>
                {browseResult.directoryPath !== '' ? (
                  <button style={{ ...s.folderButton, fontSize: 12 }} onClick={() => setBrowsePath(browseResult.directoryPath.split('/').slice(0, -1).join('/'))}>
                    <span aria-hidden>↰</span><span>{t('browseUp')}</span>
                  </button>
                ) : null}
                {browseResult.directories.map((directory) => (
                  <button key={`dir:${directory}`} style={s.folderButton} onClick={() => setBrowsePath(browsePath === '' ? directory : `${browsePath}/${directory}`)}>
                    <span aria-hidden>▸</span><span style={{ flex: 1 }}>{directory}</span><span style={s.hitMeta}>/</span>
                  </button>
                ))}
                {browseResult.documents.map((document) => {
                  const source = sources.find((entry) => entry.id === document.sourceId)
                  const canOpen = source !== undefined
                  return (
                    <div key={`doc:${document.path}`} style={s.row}>
                      <span aria-hidden>▤</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{document.title}</div>
                        <div style={s.hitMeta}>{document.path}</div>
                      </div>
                      {canOpen && source ? <button style={s.button()} onClick={() => void readAndPreviewDocument(source, document.path)}>{t('openFile')}</button> : null}
                    </div>
                  )
                })}
              </>
            ) : null}
          </div>
        </>
      ) : tab === 'sources' ? (
        <div style={s.body}>
          <div style={{ maxWidth: 760, margin: '0 auto' }}>
            {sourceError ? <div style={s.empty} role="alert">{sourceError}</div> : null}
            {sources.length === 0 ? <div style={s.empty}>{t('sourcesEmpty')}</div> : sources.map((source) => (
              <div key={source.id} style={s.sourceRow}>
                <span style={s.badge(source.kind === 'vault' ? '#8fd08a' : '#8fb4d0')}>{source.kind === 'vault' ? t('settingsSourceKindVault') : t('settingsSourceKindFolder')}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{source.name}</div>
                  <div style={{ ...s.hitMeta, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.path}</div>
                  <div style={s.hitMeta}>{source.lastError ?? (source.indexedAt === null ? t('sourceReindexing') : `${source.fileCount} · ${new Date(source.indexedAt).toLocaleString()}`)}</div>
                </div>
                <button style={s.button('danger')} disabled={busyIds.has(source.id)} onClick={() => void removeSource(source)}>{t('settingsSourceRemove')}</button>
              </div>
            ))}
            <div style={s.sourceForm}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t('settingsSourceAdd')}</div>
              <label style={s.sourceLabel}>
                {t('settingsSourceName')}
                <input style={s.sourceInput} value={newSourceName} onChange={(event) => setNewSourceName(event.target.value)} maxLength={64} />
              </label>
              <label style={s.sourceLabel}>
                {t('settingsSourcePath')}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input style={{ ...s.sourceInput, flex: 1, minWidth: 0 }} value={newSourcePath} onChange={(event) => setNewSourcePath(event.target.value)} placeholder="/absolute/path/to/vault" />
                  <button type="button" style={s.button()} disabled={sourcePicking || sourceSaving} onClick={() => void chooseSourceDirectory()}>{t('settingsPickDirectory')}</button>
                </div>
              </label>
              <label style={s.sourceLabel}>
                {t('settingsSourceKind')}
                <select style={s.select} value={newSourceKind} onChange={(event) => setNewSourceKind(event.target.value as SourceKind)}>
                  <option value="folder">{t('settingsSourceKindFolder')}</option>
                  <option value="vault">{t('settingsSourceKindVault')}</option>
                </select>
              </label>
              {sourceFormError ? <div style={{ ...s.hitMeta, color: 'rgba(210,90,70,0.95)' }} role="alert">{sourceFormError}</div> : null}
              <div style={s.hitMeta}>{t('settingsPathHint')}</div>
              <div><button style={s.button('primary')} disabled={sourceSaving || newSourceName.trim() === '' || newSourcePath.trim() === ''} onClick={() => void addSource()}>{sourceSaving ? '…' : t('settingsSourceAdd')}</button></div>
            </div>
          </div>
        </div>
      ) : (
        <div style={s.body}>
          {inboxError ? <div style={s.empty} role="alert">{inboxError}</div> : null}
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
