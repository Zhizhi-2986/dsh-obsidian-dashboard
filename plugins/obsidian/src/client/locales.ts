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
  | 'searchIdle'
  | 'searchFailed'
  | 'searchResults'
  | 'browseLabel'
  | 'browseEmpty'
  | 'browseSelectSource'
  | 'browseLoading'
  | 'browseUp'
  | 'browseFailed'
  | 'previewLabel'
  | 'previewBack'
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
  | 'settingsPickerFailed'
  | 'settingsPathHint'
  | 'settingsInboxKeeDraft'
  | 'settingsInboxKeepDraftHint'

export const zhCN: Record<KnowledgeKey, string> = {
  panelLabel: '知识',
  searchPlaceholder: '搜索知识库…',
  searchEmpty: '没有匹配的笔记',
  searchIdle: '输入关键词搜索，或切换到「浏览」查看笔记目录。',
  searchFailed: '搜索失败',
  searchResults: '检索结果',
  browseLabel: '浏览',
  browseEmpty: '此目录下没有已索引的笔记或子目录',
  browseSelectSource: '选择知识源进行浏览',
  browseLoading: '正在读取目录…',
  browseUp: '上级目录',
  browseFailed: '读取目录失败',
  previewLabel: '预览',
  previewBack: '返回',
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
  settingsDescription: '知识源请在「知识」页面管理；此处仅配置收件箱行为。',
  settingsSourceName: '名称',
  settingsSourcePath: '路径',
  settingsSourceKind: '类型',
  settingsSourceKindVault: 'Vault',
  settingsSourceKindFolder: '目录',
  settingsSourceRemove: '移除',
  settingsSourceAdd: '添加知识源',
  settingsNoSources: '暂无知识源',
  settingsPickDirectory: '选择目录…',
  settingsPickerFailed: '无法打开目录选择器，请重试或手动输入完整路径。',
  settingsPathHint: '请选择文件夹，或手动输入文件夹的完整路径。',
  settingsInboxKeeDraft: '写入冲突时保留草稿',
  settingsInboxKeepDraftHint: '目标文件在提案后被修改时，将提案标记为冲突而非静默失败。',
}

export const enUS: Record<KnowledgeKey, string> = {
  panelLabel: 'Knowledge',
  searchPlaceholder: 'Search knowledge…',
  searchEmpty: 'No matching notes',
  searchIdle: 'Enter a keyword to search, or switch to Browse to explore note folders.',
  searchFailed: 'Search failed',
  searchResults: 'Results',
  browseLabel: 'Browse',
  browseEmpty: 'No indexed notes or subfolders here',
  browseSelectSource: 'Choose a source to browse',
  browseLoading: 'Loading folder…',
  browseUp: 'Parent folder',
  browseFailed: 'Could not read this folder',
  previewLabel: 'Preview',
  previewBack: 'Back',
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
  settingsDescription: 'Manage knowledge sources in the Knowledge page; inbox behavior is configured here.',
  settingsSourceName: 'Name',
  settingsSourcePath: 'Path',
  settingsSourceKind: 'Kind',
  settingsSourceKindVault: 'Vault',
  settingsSourceKindFolder: 'Folder',
  settingsSourceRemove: 'Remove',
  settingsSourceAdd: 'Add source',
  settingsNoSources: 'No sources yet',
  settingsPickDirectory: 'Choose folder…',
  settingsPickerFailed: 'Could not open the folder chooser. Try again or enter the full path manually.',
  settingsPathHint: 'Choose a folder or enter its full path manually.',
  settingsInboxKeeDraft: 'Keep draft on write conflict',
  settingsInboxKeepDraftHint: 'When the target changed after the proposal, mark the item conflicted instead of failing silently.',
}

export const dictionaries = {
  zh: zhCN,
  en: enUS,
} as const
