/** Knowledge main panel: full-text search, document open, proposal inbox. */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, useRef, type FormEvent, type ReactElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowseOk, InboxItem, KnowledgeSourceInfo, ReadDoc, SearchHit, SourceKind } from '../shared/rpc-contract.ts'
import type { KnowledgeRpc } from './remote.ts'
import { MarkdownView, slugHeading } from './markdown-view.tsx'
import { pickDirectory } from './directory-picker.ts'
import { NS, type KnowledgeKey } from './locales.ts'
import { zhCN, enUS } from './locales.ts'

const PANEL_TABS = ['search', 'browse', 'sources', 'preview', 'inbox'] as const
type PanelTab = (typeof PANEL_TABS)[number]

const s = {
  root: { display: 'flex', flexDirection: 'column' as const, height: '100%', minWidth: 0, fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif', fontSize: 13, letterSpacing: '-0.1px' },
  header: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px 8px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)', background: 'color-mix(in srgb, currentColor 3%, transparent)' },
  tabs: { display: 'flex', gap: 3, padding: '7px 14px 0', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' },
  tab: (active: boolean) => ({
    padding: '5px 10px', borderRadius: 7, cursor: 'pointer', border: 'none', background: active ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent',
    color: 'inherit', fontSize: 12, opacity: active ? 1 : 0.72, transition: 'background 120ms ease, opacity 120ms ease',
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
    padding: '5px 11px', borderRadius: 7, border: '1px solid color-mix(in srgb, currentColor 18%, transparent)', cursor: 'pointer', fontSize: 12,
    background: tone === 'primary' ? '#3478f6' : tone === 'danger' ? '#d85b57' : 'color-mix(in srgb, currentColor 3%, transparent)',
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
  previewScreen: { display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0, minWidth: 0 },
  previewContent: { margin: 0, padding: 16, whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const, lineHeight: 1.65, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  footer: { padding: '7px 12px', borderTop: '1px solid rgba(127,127,127,0.18)', color: 'rgba(127,127,127,0.75)', fontSize: 11, display: 'flex', gap: 12, flexWrap: 'wrap' as const },
  workspace: { display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0 },
  sidebar: { minHeight: 38, display: 'flex', flexDirection: 'row' as const, alignItems: 'center', gap: 3, padding: '5px 12px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)', background: 'color-mix(in srgb, currentColor 3%, transparent)' },
  sidebarLabel: { padding: '0 9px 7px', fontSize: 10, color: 'rgba(127,127,127,.85)', fontWeight: 650, letterSpacing: '.45px', textTransform: 'uppercase' as const },
  sidebarNav: (active: boolean) => ({ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 10px', border: 0, borderRadius: 7, cursor: 'pointer', textAlign: 'left' as const, font: 'inherit', fontSize: 12, color: 'inherit', background: active ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent', fontWeight: active ? 600 : 400, whiteSpace: 'nowrap' as const }),
}

const KIND_TONE: Record<InboxItem['kind'], string> = { create: '#8fd08a', append: '#d0b98f', update: '#8fb4d0' }
const STATUS_TONE: Record<InboxItem['status'], string> = { pending: '#d0c78f', applied: '#8fd08a', dismissed: 'rgba(127,127,127,0.3)', conflicted: '#d08f8f' }

type DiffLine = { readonly kind: 'same' | 'added' | 'removed'; readonly text: string }

function finalProposalContent(item: InboxItem, draft = item.body): string {
  if (item.kind === 'append') return `${item.baselineContent.replace(/\s*$/u, '')}\n\n${draft}\n`
  return draft
}

function proposalDiff(before: string, after: string): DiffLine[] {
  const left = before.split('\n')
  const right = after.split('\n')
  if (left.length * right.length > 60_000) {
    return [
      ...left.map((text) => ({ kind: 'removed' as const, text })),
      ...right.map((text) => ({ kind: 'added' as const, text })),
    ]
  }
  const dp = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = left[i] === right[j] ? 1 + dp[i + 1]![j + 1]! : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      result.push({ kind: 'same', text: left[i++]! }); j += 1
    } else if (j < right.length && (i === left.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      result.push({ kind: 'added', text: right[j++]! })
    } else {
      result.push({ kind: 'removed', text: left[i++]! })
    }
  }
  return result
}

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

function sessionResourceAddress(sessionId: string, sourcePath: string, relPath: string): string {
  const fullPath = `${sourcePath.replace(/[\\/]+$/u, '')}/${relPath}`.replace(/\\/gu, '/')
  const encodedPath = fullPath.split('/').map((segment) => encodeURIComponent(segment)
    .replace(/%3A/giu, ':').replace(/\(/gu, '%28').replace(/\)/gu, '%29')).join('/')
  return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encodedPath}`
}

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
  const [editingDocument, setEditingDocument] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [savingDocument, setSavingDocument] = useState(false)
  const [newNoteTitle, setNewNoteTitle] = useState('')
  const [newNoteTarget, setNewNoteTarget] = useState<{ sourceId: string; directoryPath: string } | null>(null)
  const [newNoteDirectoryPath, setNewNoteDirectoryPath] = useState('')
  const [newNoteDialogOpen, setNewNoteDialogOpen] = useState(false)
  const [newNoteDialogError, setNewNoteDialogError] = useState<string | null>(null)
  const [pendingHeadingFragment, setPendingHeadingFragment] = useState<string | null>(null)
  const [previewReturnTab, setPreviewReturnTab] = useState<'search' | 'browse'>('search')
  const [sources, setSources] = useState<KnowledgeSourceInfo[]>([])
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [newSourceName, setNewSourceName] = useState('')
  const [newSourcePath, setNewSourcePath] = useState('')
  const [newSourceKind, setNewSourceKind] = useState<SourceKind>('folder')
  const [sourceSaving, setSourceSaving] = useState(false)
  const [sourcePicking, setSourcePicking] = useState(false)
  const [sourceFormError, setSourceFormError] = useState<string | null>(null)
  const [confirmSourceId, setConfirmSourceId] = useState<string | null>(null)
  const [sourceRemovalLoading, setSourceRemovalLoading] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [items, setItems] = useState<InboxItem[]>([])
  const [inboxError, setInboxError] = useState<string | null>(null)
  const [conflictDocument, setConflictDocument] = useState<ReadDoc | null>(null)
  const [conflictLoading, setConflictLoading] = useState(false)
  const [inboxFilter, setInboxFilter] = useState<InboxItem['status'] | 'all'>('all')
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null)
  const [editingInboxId, setEditingInboxId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [confirmItemId, setConfirmItemId] = useState<string | null>(null)
  const [confirmRevision, setConfirmRevision] = useState<number | null>(null)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const panelRootRef = useRef<HTMLDivElement | null>(null)
  const sourceRefreshSequence = useRef(0)
  const documentReadSequence = useRef(0)
  const searchSequence = useRef(0)
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

  const reindexSource = async (source: KnowledgeSourceInfo): Promise<void> => {
    setBusyIds((prev) => new Set(prev).add(source.id))
    setSourceError(null)
    try {
      const result = await rpc.indexSource(source.id)
      if (result.ok) setSources((prev) => prev.map((entry) => entry.id === source.id ? result.source : entry))
      else setSourceError(result.message)
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(source.id); return next })
    }
  }

  const removeSource = async (source: KnowledgeSourceInfo): Promise<void> => {
    setSourceFormError(null)
    setBusyIds((prev) => new Set(prev).add(source.id))
    try {
      const result = await rpc.removeSource(source.id)
      if (result.ok) {
        sourceRefreshSequence.current += 1
        documentReadSequence.current += 1
        setConfirmSourceId(null)
        setSources((prev) => prev.filter((entry) => entry.id !== source.id))
        setItems((prev) => prev.map((item) => item.sourceId === source.id && item.status === 'pending'
          ? { ...item, status: 'conflicted', conflictMessage: 'knowledge source was removed; this proposal is retained but cannot be applied' }
          : item))
        setConflictDocument(null)
        if (sourceId === source.id) setSourceId('')
        if (previewDocument?.sourceId === source.id) { setPreviewDocument(null); setTab('search') }
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

  const requestSourceRemoval = async (source: KnowledgeSourceInfo): Promise<void> => {
    setSourceRemovalLoading(true)
    setSourceFormError(null)
    try {
      const result = await rpc.listInbox()
      if (!result.ok) {
        setSourceFormError(result.message)
        return
      }
      const latestItems = [...result.items].reverse()
      setItems(latestItems)
      setConfirmSourceId(source.id)
    } catch (error) {
      setSourceFormError(error instanceof Error ? error.message : String(error))
    } finally {
      setSourceRemovalLoading(false)
    }
  }

  const needsSourceRefresh = sources.some((source) => source.indexedAt === null && source.lastError === null)

  useEffect(() => {
    if (tab !== 'preview') documentReadSequence.current += 1
  }, [tab])

  useEffect(() => {
    if (!['preview', 'browse'].includes(tab) || previewDocument === null || pendingHeadingFragment === null) return
    const headingId = slugHeading(pendingHeadingFragment)
    const article = panelRootRef.current?.querySelector('.dsh-obsidian-markdown') ?? null
    const heading = article === null
      ? undefined
      : [...article.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((element) => element.id === headingId)
    heading?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    setPendingHeadingFragment(null)
  }, [tab, previewDocument, pendingHeadingFragment])

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
        const nextItems = [...result.items].reverse()
        setItems(nextItems)
        setSelectedInboxId((current) => current ?? nextItems[0]?.id ?? null)
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

  const readAndPreviewDocument = async (source: KnowledgeSourceInfo, relPath: string, headingFragment?: string): Promise<void> => {
    if (editingDocument && previewDocument && editContent !== previewDocument.content && !window.confirm('Discard unsaved note changes?')) return
    const requestId = ++documentReadSequence.current
    setOpenError(null)
    try {
      const result = await rpc.read(source.id, relPath)
      if (requestId !== documentReadSequence.current) return
      if (result.ok) {
        setEditingDocument(false)
        setEditContent(result.content)
        const returnTab = tab === 'browse' ? 'browse' : tab === 'preview' ? previewReturnTab : 'search'
        setPreviewReturnTab(returnTab)
        setPreviewDocument(result)
        setPendingHeadingFragment(headingFragment ?? null)
        setTab('preview')
      } else {
        setOpenError(result.message)
      }
    } catch (error) {
      if (requestId === documentReadSequence.current) setOpenError(error instanceof Error ? error.message : String(error))
    }
  }

  const copyPreviewPath = async (): Promise<void> => {
    if (!previewDocument) return
    try {
      await navigator.clipboard.writeText(previewDocument.path)
      setCopyFeedback(t('copiedPath'))
    } catch {
      setCopyFeedback(t('copyPathFailed'))
    }
  }

  const saveDocument = async (): Promise<void> => {
    if (!previewDocument || savingDocument) return
    const title = newNoteTitle.trim()
    const targetPath = previewDocument.path || `${newNoteDirectoryPath ? `${newNoteDirectoryPath}/` : ''}${title}.md`
    if (previewDocument.version === '' && (title === '' || title.includes('/') || title.includes('\\'))) {
      setOpenError('Enter a note title without path separators.')
      return
    }
    setSavingDocument(true)
    setOpenError(null)
    try {
      const result = await rpc.saveDocument({
        sourceId: previewDocument.sourceId,
        path: targetPath,
        content: editContent,
        expectedVersion: previewDocument.version || null,
        expectedContent: previewDocument.version ? previewDocument.content : null,
      })
      if (!result.ok) {
        if (active.toLowerCase().startsWith('zh') && result.code === 'SANDBOX_DENIED') {
          setOpenError('此知识源未获得 DSH 写入授权，请在 DSH 允许写入的目录中添加该知识源。')
        } else if (active.toLowerCase().startsWith('zh') && result.code === 'READ_ONLY') {
          setOpenError('DSH 当前为只读模式，请允许工作区写入后再保存。')
        } else if (active.toLowerCase().startsWith('zh') && result.code === 'CONFLICT') {
          setOpenError('笔记正文在编辑期间发生了变化。当前草稿仍保留，请复制后重新打开笔记，比较内容再保存。')
        } else {
          setOpenError(result.message)
        }
        return
      }
      setPreviewDocument({ ...previewDocument, path: targetPath, title: previewDocument.path ? previewDocument.title : title, content: editContent, version: result.version, tags: [], links: [] })
      setEditingDocument(false)
      setNewNoteTitle('')
      setNewNoteDirectoryPath('')
      let refreshError: string | null = null
      try {
        const refreshed = await rpc.read(previewDocument.sourceId, targetPath)
        if (refreshed.ok) setPreviewDocument(refreshed)
        else refreshError = refreshed.message
      } catch (error) {
        refreshError = error instanceof Error ? error.message : String(error)
      }
      await refreshSources()
      if (refreshError || result.syncError) {
        const messages = [refreshError ? `refresh failed: ${refreshError}` : null, result.syncError ? `indexing failed: ${result.syncError}` : null].filter(Boolean)
        setOpenError(`Saved, but ${messages.join('; ')}`)
      }
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingDocument(false)
    }
  }

  const startNewNote = (): void => {
    if (editingDocument && (editContent !== (previewDocument?.content ?? '') || newNoteTitle.trim() !== '') && !window.confirm('Discard unsaved note changes?')) return
    const source = sources.find((entry) => entry.id === browseSelection)
    if (!source) { setSourceError('Select a knowledge source before creating a note.'); return }
    setNewNoteTitle('')
    setNewNoteDialogError(null)
    setNewNoteTarget({ sourceId: source.id, directoryPath: browsePath })
    setNewNoteDialogOpen(true)
  }

  const cancelNewNoteDialog = (): void => {
    setNewNoteDialogOpen(false)
    setNewNoteTarget(null)
    setNewNoteTitle('')
    setNewNoteDirectoryPath('')
    setNewNoteDialogError(null)
  }

  const confirmNewNoteDialog = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const title = newNoteTitle.trim()
    if (title === '' || title.includes('/') || title.includes('\\')) {
      setNewNoteDialogError(t('newNoteTitleInvalid'))
      return
    }
    if (!newNoteTarget) return
    const targetPath = `${newNoteTarget.directoryPath ? `${newNoteTarget.directoryPath}/` : ''}${title}.md`
    if (targetPath.length > 1024) {
      setNewNoteDialogError(t('newNoteTitleTooLong'))
      return
    }
    setPreviewDocument({ ok: true, sourceId: newNoteTarget.sourceId, path: '', content: '', version: '', title, tags: [], links: [], backlinks: [], updatedAt: null })
    setPreviewReturnTab('browse')
    setNewNoteDirectoryPath(newNoteTarget.directoryPath)
    setEditContent('')
    setEditingDocument(true)
    setTab('preview')
    setNewNoteDialogOpen(false)
    setNewNoteTarget(null)
    setNewNoteDialogError(null)
  }

  const switchTab = (nextTab: PanelTab): void => {
    if (editingDocument) {
      if ((editContent !== (previewDocument?.content ?? '') || newNoteTitle.trim() !== '') && !window.confirm('Discard unsaved note changes?')) return
      setEditingDocument(false)
      setEditContent('')
      setNewNoteTitle('')
      setNewNoteDirectoryPath('')
      if (previewDocument?.path === '') setPreviewDocument(null)
    }
    setTab(nextTab)
  }

  const citationFor = (hit: SearchHit, source?: KnowledgeSourceInfo): string => {
    const location = `${source?.name ?? hit.sourceId} · ${hit.path}${hit.line === null ? '' : `:${hit.line}`}`
    const citation = `> ${hit.title} — ${location}${hit.snippet ? `\n> ${hit.snippet.replace(/\s+/gu, ' ').trim()}` : ''}`
    if (!source) return citation
    const root = source.path.replace(/[\\/]+$/u, '').replace(/\\/gu, '/')
    const relativePath = hit.path.replace(/^[\\/]+/u, '').replace(/\\/gu, '/')
    const absolutePath = `${root}/${relativePath}`
    const linkPath = absolutePath.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/giu, ':')).join('/')
    const line = hit.line === null ? '' : `#L${hit.line}`
    return `${citation}\n> [${t('openInDsh')}](<${linkPath}${line}>)`
  }

  const copyCitation = async (hit: SearchHit, source?: KnowledgeSourceInfo): Promise<void> => {
    try {
      await navigator.clipboard.writeText(citationFor(hit, source))
      setCopyFeedback(t('copiedCitation'))
    } catch {
      setCopyFeedback(t('copyCitationFailed'))
    }
  }

  const openNativeFile = (source: KnowledgeSourceInfo, relPath: string, line: number | null): void => {
    const hostContext = ctx as unknown as {
      sidebarRight?: {
        mounted: { getSnapshot(): string | undefined }
        openResource(address: string, options?: { params?: { line?: number } }): void
      }
      layout?: { selectPanel(panelId: string | null): void }
    }
    const navigation = hostContext.sidebarRight
    if (!navigation) {
      setOpenError(t('nativeOpenUnavailable'))
      return
    }
    let sessionId = navigation.mounted.getSnapshot()
    if (!sessionId) {
      hostContext.layout?.selectPanel(null)
      sessionId = navigation.mounted.getSnapshot()
    }
    if (!sessionId) {
      setOpenError(t('nativeOpenUnavailable'))
      return
    }
    const address = sessionResourceAddress(sessionId, source.path, relPath)
    try {
      navigation.openResource(address, line === null ? undefined : { params: { line } })
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    }
  }

  const runSearch = useCallback((searchQuery = query, searchSource = sourceId) => {
    const requestId = ++searchSequence.current
    const trimmed = searchQuery.trim()
    setSearchError(null)
    if (trimmed === '') { setHits([]); setSearching(false); return }
    setSearching(true)
    void rpc.search(trimmed, { sourceId: searchSource || undefined, field: 'all', limit: 30 })
      .then((result) => {
        if (requestId !== searchSequence.current) return
        if (result.ok) setHits(result.hits)
        else { setHits([]); setSearchError(result.message) }
      })
      .catch((error) => {
        if (requestId !== searchSequence.current) return
        setHits([])
        setSearchError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (requestId === searchSequence.current) setSearching(false)
      })
  }, [query, rpc, sourceId])

  useEffect(() => {
    if (tab !== 'search') return
    const scheduledRequest = ++searchSequence.current
    const timer = setTimeout(() => {
      if (scheduledRequest === searchSequence.current) runSearch(query, sourceId)
    }, 300)
    return () => {
      clearTimeout(timer)
      if (scheduledRequest === searchSequence.current) searchSequence.current += 1
    }
  }, [query, sourceId, tab, runSearch])

  const requestApplyItem = (item: InboxItem) => {
    setConfirmItemId(item.id)
    setConfirmRevision(item.revision)
  }

  const confirmApplyItem = async (item: InboxItem): Promise<void> => {
    if (confirmRevision === null || item.revision !== confirmRevision) {
      setInboxError(t('inboxConfirmationStale'))
      setConfirmItemId(null)
      setConfirmRevision(null)
      return
    }
    setBusyIds((prev) => new Set(prev).add(item.id))
    setInboxError(null)
    try {
      const result = await rpc.applyInbox(item.id, confirmRevision)
      if (result.ok && result.itemId === item.id) {
        setItems((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, status: 'applied' as const } : entry))
        if (result.statusError != null) setInboxError(`File was applied, but the Inbox status could not be saved: ${result.statusError}`)
        else if (result.syncError != null) setInboxError(`File was applied, but index sync needs attention: ${result.syncError}`)
        setConfirmItemId(null)
        setConfirmRevision(null)
        void refreshSources()
      } else if (!result.ok && result.code === 'STALE_CONFIRMATION') {
        setInboxError(result.message)
        setConfirmItemId(null)
        setConfirmRevision(null)
        const latest = await rpc.listInbox()
        if (latest.ok) setItems([...latest.items].reverse())
      } else if (!result.ok && result.code === 'CONFLICT') {
        setItems((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, status: 'conflicted' as const, conflictMessage: result.message } : entry))
        setInboxError(result.message)
        setConfirmItemId(null)
        setConfirmRevision(null)
      } else if (!result.ok) {
        setInboxError(result.message)
      }
    } catch (error) {
      setInboxError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(item.id); return next })
    }
  }

  const saveDraft = async (item: InboxItem): Promise<void> => {
    setBusyIds((prev) => new Set(prev).add(item.id))
    setInboxError(null)
    try {
      const result = await rpc.updateInboxDraft(item.id, draftText)
      if (result.ok) {
        setItems((prev) => prev.map((entry) => entry.id === item.id ? result.item : entry))
        setEditingInboxId((current) => current === item.id ? null : current)
      } else {
        setInboxError(`${t('inboxDraftSaveFailed')}: ${result.message}`)
      }
    } catch (error) {
      setInboxError(`${t('inboxDraftSaveFailed')}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(item.id); return next })
    }
  }

  const rebaseConflict = async (item: InboxItem, operation?: 'append' | 'update'): Promise<void> => {
    setBusyIds((prev) => new Set(prev).add(item.id))
    setInboxError(null)
    try {
      const result = await rpc.rebaseInbox(item.id, operation)
      if (result.ok) {
        setItems((prev) => [result.item, ...prev])
        setSelectedInboxId(result.item.id)
        setInboxFilter('all')
        setEditingInboxId(null)
        setConflictDocument(null)
      } else {
        setInboxError(result.message)
      }
    } catch (error) {
      setInboxError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(item.id); return next })
    }
  }

  const compareConflict = async (item: InboxItem): Promise<void> => {
    setConflictLoading(true)
    setInboxError(null)
    try {
      const result = await rpc.read(item.sourceId, item.targetPath)
      if (result.ok) setConflictDocument(result)
      else setInboxError(result.message)
    } catch (error) {
      setInboxError(error instanceof Error ? error.message : String(error))
    } finally {
      setConflictLoading(false)
    }
  }

  const dismissItem = async (item: InboxItem): Promise<void> => {
    setBusyIds((prev) => new Set(prev).add(item.id))
    setInboxError(null)
    try {
      const result = await rpc.dismissInbox(item.id)
      if (result.ok) {
        setItems((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, status: 'dismissed' as const } : entry))
      } else setInboxError(result.message)
    } catch (error) {
      setInboxError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(item.id); return next })
    }
  }

  const pendingCount = items.filter((item) => item.status === 'pending').length
  const filteredInboxItems = items.filter((item) => inboxFilter === 'all' || item.status === inboxFilter)
  const selectedInboxItem = filteredInboxItems.find((item) => item.id === selectedInboxId) ?? filteredInboxItems[0]
  const selectedInboxSourceExists = selectedInboxItem !== undefined && sources.some((source) => source.id === selectedInboxItem.sourceId)
  const confirmingItem = items.find((item) => item.id === confirmItemId && item.status === 'pending')
  const confirmationStale = confirmingItem !== undefined && confirmRevision !== confirmingItem.revision
  const confirmingSource = sources.find((source) => source.id === confirmSourceId)
  const pendingForConfirmSource = confirmingSource ? items.filter((item) => item.sourceId === confirmingSource.id && item.status === 'pending').length : 0

  const openLinkedDocument = async (relativePath: string, fragment?: string): Promise<void> => {
    if (!previewDocument) return
    const source = sources.find((entry) => entry.id === previewDocument.sourceId)
    if (!source) return
    await readAndPreviewDocument(source, relativePath, fragment)
  }

  return (
    <div ref={panelRootRef} className="knowledge-panel" style={s.root}>
      <style>{`
        .knowledge-panel{container-type:inline-size;container-name:knowledgePanel}
        .knowledge-sidebar>div:first-child{display:none}
        .knowledge-sidebar>div:last-child{margin-left:auto!important;margin-top:0!important;padding:0!important;border:0!important}
        .knowledge-file-row{min-width:0;flex-wrap:wrap}
        @container knowledgePanel (max-width:520px){
          .knowledge-browse-toolbar{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;gap:6px!important;padding:8px!important}
          .knowledge-browse-toolbar select{min-width:0!important;max-width:none!important}
          .knowledge-browse-toolbar>span{display:none}
          .knowledge-browse-toolbar button{white-space:nowrap;padding:5px 8px!important}
          .knowledge-file-row{gap:5px!important;padding:8px!important}
          .knowledge-file-row>div{flex:1 1 100%!important}
          .knowledge-file-row button{padding:4px 7px!important;font-size:11px!important}
          .knowledge-search-row{flex-wrap:wrap}
          .knowledge-search-row input{flex-basis:100%}
        }
      `}</style>
      <div style={s.header}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{t('panelLabel')}</span>
        <div style={{ flex: 1 }} />
        <button style={s.button()} disabled={savingDocument} onClick={() => switchTab('sources')}>{t('sourcesLabel')}</button>
      </div>
      <div className="knowledge-workspace" style={s.workspace}>
        <aside className="knowledge-sidebar" style={s.sidebar}>
          <div className="knowledge-sidebar-label" style={s.sidebarLabel}>工作区</div>
          <button style={s.sidebarNav(tab === 'search')} disabled={savingDocument} onClick={() => switchTab('search')}>{t('searchResults')}</button>
          <button style={s.sidebarNav(tab === 'browse' || tab === 'preview')} disabled={savingDocument} onClick={() => switchTab('browse')}>{t('browseLabel')}</button>
          <button style={s.sidebarNav(tab === 'inbox')} disabled={savingDocument} onClick={() => switchTab('inbox')}>{t('inboxLabel')} {pendingCount > 0 ? `· ${pendingCount}` : ''}</button>
        </aside>
        <main style={{ minWidth: 0, minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>

      {tab === 'search' ? (
        <>
          <div className="knowledge-search-row" style={s.searchRow}>
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
                    {source ? <>
                      <button style={s.button()} onClick={() => void readAndPreviewDocument(source, hit.path)}>{t('openFile')}</button>
                      <button style={s.button()} onClick={() => openNativeFile(source, hit.path, hit.line)}>{t('openInDsh')}</button>
                    </> : null}
                  </div>
                  <div style={s.hitMeta}>{source?.name ?? hit.sourceId} · {hit.path}{hit.line === null ? '' : ` · ${t('matchLine')} ${hit.line}`}</div>
                  {hit.snippet ? <div style={s.hitSnippet}>{hit.snippet}</div> : null}
                  <button type="button" style={{ ...s.button(), marginTop: 5 }} onClick={() => void copyCitation(hit, source)}>{t('copyCitation')}</button>
                  {hit.tags.length > 0 ? (
                    <div style={s.tags}>{hit.tags.map((tag) => <span key={tag} style={s.tag}>#{tag}</span>)}</div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      ) : tab === 'preview' ? (
        <div style={s.previewScreen}>
          <div style={s.previewToolbar}>
            <button style={s.button()} disabled={savingDocument} onClick={() => switchTab(previewReturnTab)}>{t('previewBack')}</button>
            {previewDocument ? (
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{previewDocument.title}</div>
                <div style={s.hitMeta}>{previewDocument.sourceId} · {previewDocument.path}</div>
              </div>
            ) : null}
            {previewDocument ? <button type="button" style={s.button()} onClick={() => void copyPreviewPath()}>{t('copyPath')}</button> : null}
            {!editingDocument && previewDocument?.path ? <button type="button" style={s.button()} onClick={() => { setEditContent(previewDocument.content); setEditingDocument(true) }}>编辑笔记</button> : null}
            {editingDocument ? <button type="button" style={s.button()} disabled={savingDocument} onClick={() => {
              if ((editContent !== (previewDocument?.content ?? '') || newNoteTitle.trim() !== '') && !window.confirm('Discard unsaved note changes?')) return
              setEditingDocument(false)
              setEditContent(previewDocument?.content ?? '')
              setNewNoteTitle('')
              setNewNoteDirectoryPath('')
              if (previewDocument?.path === '') { setPreviewDocument(null); setTab(previewReturnTab) }
            }}>取消</button> : null}
            {editingDocument ? <button type="button" style={s.button('primary')} disabled={savingDocument} onClick={() => void saveDocument()}>{savingDocument ? '保存中…' : '保存'}</button> : null}
          </div>
          {copyFeedback ? <div role="status" style={s.hitMeta}>{copyFeedback}</div> : null}
          {openError ? <div style={s.empty} role="alert">{openError}</div> : null}
          {previewDocument?.tags.length ? (
            <div style={s.tags}>{previewDocument.tags.map((tag) => <span key={tag} style={s.tag}>#{tag}</span>)}</div>
          ) : null}
          <div style={{ ...s.body, padding: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {editingDocument ? <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, padding: 16 }}>
              <textarea aria-label="Markdown note content" value={editContent} readOnly={savingDocument} onChange={(event) => setEditContent(event.target.value)} autoFocus={previewDocument?.version !== ''} style={{ flex: 1, minHeight: 0, width: '100%', resize: 'none', border: '1px solid rgba(127,127,127,.2)', borderRadius: 8, padding: 16, background: 'transparent', color: 'inherit', font: '13px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace' }} />
            </div> : previewDocument ? <MarkdownView content={previewDocument.content} links={previewDocument.links} onNavigate={(path, fragment) => void openLinkedDocument(path, fragment)} /> : null}
          </div>
        </div>
      ) : tab === 'browse' ? (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          <div className="knowledge-browse-toolbar" style={s.browseToolbar}>
            <select
              style={s.select}
              value={browseSelection}
              onChange={(event) => { setBrowseSourceId(event.target.value); setBrowsePath('') }}
            >
              <option value="">{t('browseSelectSource')}</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select>
            <button style={s.button('primary')} onClick={startNewNote}>＋ {t('newNoteTitleDialog')}</button>
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
                    <div key={`doc:${document.path}`} className="knowledge-file-row" style={s.row}>
                      <span aria-hidden>▤</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{document.title}</div>
                        <div style={s.hitMeta}>{document.path}</div>
                      </div>
                      {canOpen && source ? <>
                        <button style={s.button()} onClick={() => void readAndPreviewDocument(source, document.path)}>{t('openFile')}</button>
                      </> : null}
                    </div>
                  )
                })}
              </>
            ) : null}
          </div>
        </div>
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
                  <div style={s.hitMeta}>{source.lastError ?? (busyIds.has(source.id) || source.indexedAt === null ? t('sourceReindexing') : `${source.fileCount} · ${new Date(source.indexedAt).toLocaleString()}`)}</div>
                  {source.lastError ? <div style={s.hitMeta}>{t('sourceErrorHelp')}</div> : null}
                  <div style={s.hitMeta}>{t('sourceSkipPolicy')}</div>
                </div>
                <button style={s.button()} disabled={busyIds.has(source.id)} onClick={() => void reindexSource(source)}>{t('sourceReindex')}</button>
                <button style={s.button('danger')} disabled={busyIds.has(source.id) || sourceRemovalLoading} onClick={() => void requestSourceRemoval(source)}>{t('settingsSourceRemove')}</button>
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
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }} aria-label="Inbox status filter">
            {(['all', 'pending', 'conflicted', 'applied', 'dismissed'] as const).map((status) => {
              const label = status === 'all' ? t('inboxFilterAll') : status === 'pending' ? t('inboxFilterPending') : t(`inbox${status[0]!.toUpperCase()}${status.slice(1)}` as KnowledgeKey)
              return <button key={status} type="button" aria-pressed={inboxFilter === status} style={s.button(inboxFilter === status ? 'primary' : 'plain')} onClick={() => setInboxFilter(status)}>{label}</button>
            })}
          </div>
          {items.length === 0 ? <div style={s.empty}>{t('inboxEmpty')}</div> : (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 0.34fr) minmax(0, 1fr)', gap: 12, minHeight: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: '100%', overflowY: 'auto' }} aria-label="Proposals">
                {filteredInboxItems.map((item) => (
                  <button key={item.id} type="button" aria-pressed={selectedInboxItem?.id === item.id} onClick={() => { setSelectedInboxId(item.id); setEditingInboxId(null); setConflictDocument(null) }} style={{ ...s.row, cursor: 'pointer', textAlign: 'left', background: selectedInboxItem?.id === item.id ? 'rgba(68,120,255,0.12)' : 'rgba(127,127,127,0.06)' }}>
                    <span style={s.badge(hitTone(item.kind))}>{item.kind}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                      <span style={s.hitMeta}>{item.sourceId} · {item.targetPath}</span>
                    </span>
                    <span style={s.badge(statusTone(item.status))}>{t(`inbox${item.status[0]!.toUpperCase()}${item.status.slice(1)}` as KnowledgeKey)}</span>
                  </button>
                ))}
                {filteredInboxItems.length === 0 ? <div style={s.empty}>{t('inboxEmpty')}</div> : null}
              </div>
              {selectedInboxItem ? (
                <section aria-label="Proposal review" style={{ minWidth: 0, overflowY: 'auto', padding: 12, border: '1px solid rgba(127,127,127,0.18)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <h2 style={{ margin: '0 0 5px', fontSize: 16 }}>{selectedInboxItem.title}</h2>
                      <div style={s.hitMeta}>{selectedInboxItem.sourceId} · {selectedInboxItem.targetPath} · {selectedInboxItem.kind} · {t('inboxAgent')}: {selectedInboxItem.agentId ?? t('inboxAgentUnknown')}{selectedInboxItem.rebasedFrom ? ` · ${t('inboxRebasedFrom')}: ${selectedInboxItem.rebasedFrom}` : ''} · {new Date(selectedInboxItem.createdAt).toLocaleString()}</div>
                    </div>
                    <span style={s.badge(statusTone(selectedInboxItem.status))}>{t(`inbox${selectedInboxItem.status[0]!.toUpperCase()}${selectedInboxItem.status.slice(1)}` as KnowledgeKey)}</span>
                  </div>
                  {selectedInboxItem.conflictMessage ? <div role="alert" style={{ ...s.hit, marginTop: 10, borderColor: 'rgba(210,70,70,0.4)' }}>{selectedInboxItem.conflictMessage}</div> : null}
                  {selectedInboxItem.status === 'pending' && !selectedInboxSourceExists ? <div role="alert" style={{ ...s.hit, marginTop: 10, borderColor: 'rgba(210,70,70,0.4)' }}>{t('sourceRemovePending')}</div> : null}
                  {selectedInboxItem.status === 'conflicted' && selectedInboxSourceExists ? <button type="button" style={{ ...s.button(), marginTop: 8 }} disabled={conflictLoading} onClick={() => void compareConflict(selectedInboxItem)}>{conflictLoading ? '…' : t('inboxCompareCurrent')}</button> : null}
                  {selectedInboxItem.status === 'conflicted' && conflictDocument?.sourceId === selectedInboxItem.sourceId && conflictDocument.path === selectedInboxItem.targetPath ? (
                    <div style={{ marginTop: 12 }}>
                      <h3 style={{ margin: '0 0 6px', fontSize: 12 }}>{t('inboxCurrentFile')}</h3>
                      <pre style={{ ...s.previewContent, maxHeight: 220, overflow: 'auto', border: '1px solid rgba(127,127,127,0.18)', borderRadius: 6 }}>{conflictDocument.content}</pre>
                      <h3 style={{ margin: '12px 0 6px', fontSize: 12 }}>{t('inboxBaselineDiff')} · current vs proposal</h3>
                      <pre style={{ ...s.previewContent, maxHeight: 220, overflow: 'auto', border: '1px solid rgba(127,127,127,0.18)', borderRadius: 6 }}>
                        {proposalDiff(conflictDocument.content, finalProposalContent(selectedInboxItem)).map((line, index) => (
                          <span key={`${index}:${line.kind}`} style={{ display: 'block', color: line.kind === 'added' ? '#4d8a61' : line.kind === 'removed' ? '#b05c5c' : 'inherit' }}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}{line.text || ' '}</span>
                        ))}
                      </pre>
                    </div>
                  ) : null}
                  {selectedInboxItem.status === 'conflicted' && selectedInboxSourceExists && conflictDocument?.sourceId === selectedInboxItem.sourceId && conflictDocument.path === selectedInboxItem.targetPath ? (
                    selectedInboxItem.kind === 'create' ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                        <span style={s.hitMeta}>{t('inboxCreateConflictChooseOperation')}</span>
                        <button type="button" style={s.button('primary')} disabled={busyIds.has(selectedInboxItem.id)} onClick={() => void rebaseConflict(selectedInboxItem, 'update')}>{t('inboxRebaseCreateUpdate')}</button>
                        <button type="button" style={s.button()} disabled={busyIds.has(selectedInboxItem.id)} onClick={() => void rebaseConflict(selectedInboxItem, 'append')}>{t('inboxRebaseCreateAppend')}</button>
                      </div>
                    ) : <button type="button" style={{ ...s.button('primary'), marginTop: 10 }} disabled={busyIds.has(selectedInboxItem.id)} onClick={() => void rebaseConflict(selectedInboxItem)}>{t('inboxRebase')}</button>
                  ) : null}
                  <div style={{ marginTop: 12 }}>
                    <h3 style={{ margin: '0 0 6px', fontSize: 12 }}>{t('inboxFinalContent')}</h3>
                    {editingInboxId === selectedInboxItem.id ? (
                      <textarea aria-label="Draft content" value={draftText} disabled={busyIds.has(selectedInboxItem.id)} maxLength={200_000} onChange={(event) => setDraftText(event.target.value)} style={{ ...s.input, display: 'block', width: '100%', minHeight: 110, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
                    ) : null}
                    <pre style={{ ...s.previewContent, maxHeight: 220, overflow: 'auto', border: '1px solid rgba(127,127,127,0.18)', borderRadius: 6 }}>{finalProposalContent(selectedInboxItem, editingInboxId === selectedInboxItem.id ? draftText : selectedInboxItem.body)}</pre>
                  </div>
                  {selectedInboxItem.kind !== 'create' ? (
                    <div style={{ marginTop: 12 }}>
                      <h3 style={{ margin: '0 0 6px', fontSize: 12 }}>{t('inboxBaselineDiff')}</h3>
                      <pre style={{ ...s.previewContent, maxHeight: 220, overflow: 'auto', border: '1px solid rgba(127,127,127,0.18)', borderRadius: 6 }}>
                        {proposalDiff(selectedInboxItem.baselineContent ?? '', finalProposalContent(selectedInboxItem, editingInboxId === selectedInboxItem.id ? draftText : selectedInboxItem.body)).map((line, index) => (
                          <span key={`${index}:${line.kind}`} style={{ display: 'block', color: line.kind === 'added' ? '#4d8a61' : line.kind === 'removed' ? '#b05c5c' : 'inherit', background: line.kind === 'added' ? 'rgba(77,138,97,0.08)' : line.kind === 'removed' ? 'rgba(176,92,92,0.08)' : 'transparent' }}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}{line.text || ' '}</span>
                        ))}
                      </pre>
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                    {selectedInboxItem.status === 'pending' && editingInboxId !== selectedInboxItem.id ? <button type="button" style={s.button()} onClick={() => { setDraftText(selectedInboxItem.body); setEditingInboxId(selectedInboxItem.id) }}>{t('inboxEditDraft')}</button> : null}
                    {editingInboxId === selectedInboxItem.id ? <>
                      <button type="button" style={s.button('primary')} disabled={busyIds.has(selectedInboxItem.id)} onClick={() => void saveDraft(selectedInboxItem)}>{t('inboxSaveDraft')}</button>
                      <button type="button" style={s.button()} onClick={() => { setEditingInboxId(null); setDraftText(selectedInboxItem.body) }}>{t('inboxCancelEdit')}</button>
                    </> : null}
                    {selectedInboxItem.status === 'pending' && selectedInboxSourceExists && editingInboxId !== selectedInboxItem.id ? <button type="button" style={s.button('primary')} disabled={busyIds.has(selectedInboxItem.id)} onClick={() => requestApplyItem(selectedInboxItem)}>{t('inboxApplyToFile')}</button> : null}
                    {['pending', 'conflicted'].includes(selectedInboxItem.status) ? <button type="button" style={s.button('danger')} disabled={busyIds.has(selectedInboxItem.id)} onClick={() => dismissItem(selectedInboxItem)}>{t('inboxDismiss')}</button> : null}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </div>
      )}

        </main>
      </div>

      {confirmingItem ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 18, background: 'rgba(20,24,30,0.45)' }}>
          <section role="dialog" aria-modal="true" aria-labelledby="proposal-confirm-title" style={{ maxWidth: 480, width: '100%', padding: 20, borderRadius: 10, background: 'var(--dsh-color-background, #fff)', color: 'var(--dsh-color-text, #222)', boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}>
            <h2 id="proposal-confirm-title" style={{ margin: '0 0 8px', fontSize: 16 }}>{t('inboxConfirmTitle')}</h2>
            <p>{t('inboxConfirmBody')}</p>
            <p><strong>{confirmingItem.sourceId} · {confirmingItem.targetPath}</strong></p>
            <p style={s.hitMeta}>{t('inboxRevision')}: {confirmingItem.revision}</p>
            <h3 style={{ margin: '8px 0 4px', fontSize: 12 }}>{t('inboxFinalContent')}</h3>
            <pre style={{ ...s.previewContent, maxHeight: 180, overflow: 'auto', border: '1px solid rgba(127,127,127,0.18)', borderRadius: 6 }}>{finalProposalContent(confirmingItem)}</pre>
            {confirmationStale ? <div role="alert" style={s.empty}>{t('inboxConfirmationStale')}</div> : null}
            <div style={{ display: 'flex', justifyContent: 'end', gap: 8 }}>
              <button type="button" style={s.button()} onClick={() => { setConfirmItemId(null); setConfirmRevision(null) }}>{t('inboxCancelEdit')}</button>
              <button type="button" style={s.button('primary')} disabled={busyIds.has(confirmingItem.id) || confirmationStale} onClick={() => void confirmApplyItem(confirmingItem)}>{t('inboxConfirmApply')}</button>
            </div>
          </section>
        </div>
      ) : null}

      {confirmingSource ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', padding: 18, background: 'rgba(20,24,30,0.45)' }}>
          <section role="dialog" aria-modal="true" aria-labelledby="source-remove-confirm-title" style={{ maxWidth: 480, width: '100%', padding: 20, borderRadius: 10, background: 'var(--dsh-color-background, #fff)', color: 'var(--dsh-color-text, #222)', boxShadow: '0 12px 40px rgba(0,0,0,0.2)' }}>
            <h2 id="source-remove-confirm-title" style={{ margin: '0 0 8px', fontSize: 16 }}>{t('sourceRemoveConfirmTitle')}</h2>
            <p>{t('sourceRemoveConfirmBody')}</p>
            {pendingForConfirmSource > 0 ? <p role="alert">{t('sourceRemovePending')} ({pendingForConfirmSource})</p> : null}
            <p><strong>{confirmingSource.name} · {confirmingSource.path}</strong></p>
            {sourceFormError ? <div role="alert" style={s.hit}>{sourceFormError}</div> : null}
            <div style={{ display: 'flex', justifyContent: 'end', gap: 8 }}>
              <button type="button" style={s.button()} onClick={() => setConfirmSourceId(null)}>{t('inboxCancelEdit')}</button>
              <button type="button" style={s.button('danger')} disabled={busyIds.has(confirmingSource.id)} onClick={() => void removeSource(confirmingSource)}>{t('sourceRemoveConfirmAction')}</button>
            </div>
          </section>
        </div>
      ) : null}

      {newNoteDialogOpen && newNoteTarget ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'grid', placeItems: 'center', padding: 18, background: 'rgba(20,24,30,0.42)', backdropFilter: 'blur(3px)' }}>
          <form role="dialog" aria-modal="true" aria-labelledby="new-note-title-dialog" onSubmit={confirmNewNoteDialog} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); cancelNewNoteDialog(); return }
            if (event.key !== 'Tab') return
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)'))
            const first = controls[0]
            const last = controls.at(-1)
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
          }} style={{ maxWidth: 420, width: '100%', padding: 22, borderRadius: 12, background: 'var(--dsh-color-background, #fff)', color: 'var(--dsh-color-text, #222)', boxShadow: '0 16px 48px rgba(0,0,0,0.22)', border: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
            <h2 id="new-note-title-dialog" style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 650 }}>{t('newNoteTitleDialog')}</h2>
            <p style={{ margin: '0 0 16px', ...s.hitMeta }}>{newNoteTarget.sourceId}{newNoteTarget.directoryPath ? ` · ${newNoteTarget.directoryPath}` : ''}</p>
            <label htmlFor="new-note-title-input" style={{ display: 'block', marginBottom: 7, fontSize: 12, fontWeight: 600 }}>{t('newNoteTitleLabel')}</label>
            <input id="new-note-title-input" autoFocus style={{ ...s.input, boxSizing: 'border-box', width: '100%', padding: '9px 11px', borderRadius: 8 }} placeholder={t('newNoteTitlePlaceholder')} value={newNoteTitle} onChange={(event) => { setNewNoteTitle(event.target.value); setNewNoteDialogError(null) }} />
            {newNoteDialogError ? <div role="alert" style={{ ...s.empty, padding: '9px 0', textAlign: 'left' }}>{newNoteDialogError}</div> : null}
            <div style={{ display: 'flex', justifyContent: 'end', gap: 8, marginTop: 20 }}>
              <button type="button" style={s.button()} onClick={cancelNewNoteDialog}>{t('inboxCancelEdit')}</button>
              <button type="submit" style={s.button('primary')}>{t('newNoteContinue')}</button>
            </div>
          </form>
        </div>
      ) : null}

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
