/** Locales for dsh-obsidian (zh-CN + en-US). */

export const NS = 'dsh-obsidian' as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-obsidian': KnowledgeKey
  }
}

export type KnowledgeKey =
  | 'panelLabel'
  | 'searchPlaceholder'
  | 'searchEmpty'
  | 'searchResults'
  | 'sourcesLabel'
  | 'sourcesEmpty'
  | 'sourceAdd'
  | 'sourceReindex'
  | 'sourceIndexedAt'
  | 'sourceReindexing'
  | 'inboxLabel'
  | 'inboxEmpty'
  | 'inboxApply'
  | 'inboxDismiss'
  | 'inboxPending'
  | 'inboxApplied'
  | 'inboxConflicted'
  | 'inboxDismissed'
  | 'inboxConflict'
  | 'openFile'
  | 'tagsLabel'
  | 'linksLabel'
  | 'backlinksLabel'
  | 'settingsTitle'
  | 'settingsDescription'
  | 'settingsSourceName'
  | 'settingsSourcePath'
  | 'settingsSourceKind'
  | 'settingsSourceKindVault'
  | 'settingsSourceKindFolder'
  | 'settingsSourceRemove'
  | 'settingsSourceAdd'
  | 'settingsNoSources'
  | 'settingsPickDirectory'
  | 'settingsInboxKeeDraft'
  | 'settingsInboxKeepDraftHint'

export const zhCN: Record<KnowledgeKey, string> = {
  panelLabel: '知识',
  searchPlaceholder: '搜索知识库…',
  searchEmpty: '没有匹配的笔记',
  searchResults: '检索结果',
  sourcesLabel: '知识源',
  sourcesEmpty: '尚未配置知识源',
  sourceAdd: '添加知识源',
  sourceReindex: '重新索引',
  sourceIndexedAt: '已索引 {count} 篇 · {time}',
  sourceReindexing: '索引中…',
  inboxLabel: '收件箱',
  inboxEmpty: '收件箱为空',
  inboxApply: '写入',
  inboxDismiss: '丢弃',
  inboxPending: '待审核',
  inboxApplied: '已写入',
  inboxConflicted: '冲突',
  inboxDismissed: '已丢弃',
  inboxConflict: '写入冲突，请重新核对目标文件',
  openFile: '打开',
  tagsLabel: '标签',
  linksLabel: '出链',
  backlinksLabel: '反链',
  settingsTitle: '知识工作台',
  settingsDescription: '配置 Obsidian Vault 与知识目录、收件箱行为。',
  settingsSourceName: '名称',
  settingsSourcePath: '路径',
  settingsSourceKind: '类型',
  settingsSourceKindVault: 'Vault',
  settingsSourceKindFolder: '目录',
  settingsSourceRemove: '移除',
  settingsSourceAdd: '添加知识源',
  settingsNoSources: '暂无知识源',
  settingsPickDirectory: '选择目录…',
  settingsInboxKeeDraft: '写入冲突时保留草稿',
  settingsInboxKeepDraftHint: '目标文件在提案后被修改时，将提案标记为冲突而非静默失败。',
}

export const enUS: Record<KnowledgeKey, string> = {
  panelLabel: 'Knowledge',
  searchPlaceholder: 'Search knowledge…',
  searchEmpty: 'No matching notes',
  searchResults: 'Results',
  sourcesLabel: 'Knowledge sources',
  sourcesEmpty: 'No knowledge sources configured',
  sourceAdd: 'Add knowledge source',
  sourceReindex: 'Reindex',
  sourceIndexedAt: '{count} notes · {time}',
  sourceReindexing: 'Indexing…',
  inboxLabel: 'Inbox',
  inboxEmpty: 'Inbox is empty',
  inboxApply: 'Apply',
  inboxDismiss: 'Dismiss',
  inboxPending: 'pending',
  inboxApplied: 'applied',
  inboxConflicted: 'conflict',
  inboxDismissed: 'dismissed',
  inboxConflict: 'Write conflicted; re-check the target file before retrying',
  openFile: 'Open',
  tagsLabel: 'Tags',
  linksLabel: 'Links',
  backlinksLabel: 'Backlinks',
  settingsTitle: 'Knowledge Workbench',
  settingsDescription: 'Configure Obsidian vaults and knowledge folders, plus inbox behavior.',
  settingsSourceName: 'Name',
  settingsSourcePath: 'Path',
  settingsSourceKind: 'Kind',
  settingsSourceKindVault: 'Vault',
  settingsSourceKindFolder: 'Folder',
  settingsSourceRemove: 'Remove',
  settingsSourceAdd: 'Add source',
  settingsNoSources: 'No sources yet',
  settingsPickDirectory: 'Pick directory…',
  settingsInboxKeeDraft: 'Keep draft on write conflict',
  settingsInboxKeepDraftHint: 'When the target changed after the proposal, mark the item conflicted instead of failing silently.',
}

export const dictionaries = {
  zh: zhCN,
  en: enUS,
} as const
