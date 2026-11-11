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
  | 'newNoteTitleDialog'
  | 'newNoteTitleLabel'
  | 'newNoteTitlePlaceholder'
  | 'newNoteTitleInvalid'
  | 'newNoteTitleTooLong'
  | 'newNoteContinue'
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
  | 'inboxFilterAll'
  | 'inboxFilterPending'
  | 'inboxFinalContent'
  | 'inboxBaselineDiff'
  | 'inboxEditDraft'
  | 'inboxSaveDraft'
  | 'inboxCancelEdit'
  | 'inboxApplyToFile'
  | 'inboxConfirmTitle'
  | 'inboxConfirmBody'
  | 'inboxConfirmApply'
  | 'inboxDraftSaveFailed'
  | 'inboxCompareCurrent'
  | 'inboxCurrentFile'
  | 'inboxRevision'
  | 'inboxConfirmationStale'
  | 'inboxRebase'
  | 'inboxCreateConflictChooseOperation'
  | 'inboxRebaseCreateUpdate'
  | 'inboxRebaseCreateAppend'
  | 'inboxRebasedFrom'
  | 'inboxAgent'
  | 'inboxAgentUnknown'
  | 'sourceRemoveConfirmTitle'
  | 'sourceRemoveConfirmBody'
  | 'sourceRemoveConfirmAction'
  | 'sourceRemovePending'
  | 'copyPath'
  | 'copiedPath'
  | 'copyPathFailed'
  | 'copyCitation'
  | 'copiedCitation'
  | 'copyCitationFailed'
  | 'matchLine'
  | 'nativeOpenUnavailable'
  | 'openInDsh'
  | 'sourceSkipPolicy'
  | 'sourceErrorHelp'
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
  newNoteTitleDialog: '新建笔记',
  newNoteTitleLabel: '标题',
  newNoteTitlePlaceholder: '输入笔记标题',
  newNoteTitleInvalid: '请输入有效标题，且不能包含斜杠。',
  newNoteTitleTooLong: '当前目录下的文件路径过长，请缩短标题或返回上级目录。',
  newNoteContinue: '继续编辑',
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
  inboxFilterAll: '全部',
  inboxFilterPending: '待审核',
  inboxFinalContent: '最终内容预览',
  inboxBaselineDiff: '与基线差异',
  inboxEditDraft: '编辑草案',
  inboxSaveDraft: '保存草案',
  inboxCancelEdit: '取消编辑',
  inboxApplyToFile: '应用到文件',
  inboxConfirmTitle: '确认应用提案',
  inboxConfirmBody: '请确认目标路径和将写入的内容。Host 会再次检查权限与文件版本。',
  inboxConfirmApply: '确认应用到文件',
  inboxDraftSaveFailed: '草案保存失败',
  inboxCompareCurrent: '读取当前文件并比较',
  inboxCurrentFile: '当前文件内容',
  inboxRevision: '提案修订号',
  inboxConfirmationStale: '提案内容在确认期间发生变化。请关闭确认框，重新检查并再次确认。',
  inboxRebase: '以当前文件为基线新建提案',
  inboxCreateConflictChooseOperation: '创建目标已存在，请选择后续提案类型：',
  inboxRebaseCreateUpdate: '以当前文件为基线提出替换',
  inboxRebaseCreateAppend: '以当前文件为基线提出追加',
  inboxRebasedFrom: '基于冲突提案',
  inboxAgent: 'Agent',
  inboxAgentUnknown: '未知 Agent',
  sourceRemoveConfirmTitle: '确认移除知识源',
  sourceRemoveConfirmBody: '只会移除插件配置与索引，不会删除磁盘上的源文件。',
  sourceRemoveConfirmAction: '确认移除来源',
  sourceRemovePending: '该来源有待审核提案。移除后提案仍保留在收件箱，但将无法应用；建议先处理或丢弃。',
  copyPath: '复制相对路径',
  copiedPath: '路径已复制',
  copyPathFailed: '无法访问剪贴板，请手动复制路径',
  copyCitation: '复制引用',
  copiedCitation: '引用已复制',
  copyCitationFailed: '无法访问剪贴板，引用复制失败',
  matchLine: '匹配行',
  nativeOpenUnavailable: 'DSH 原生文件导航当前不可用，请打开一个会话后重试。',
  openInDsh: '在 DSH 中打开原文',
  sourceSkipPolicy: '索引 Markdown/TXT；忽略隐藏、版本控制和构建目录，以及配置的排除路径。',
  sourceErrorHelp: '检查路径仍可访问且 DSH 有读取权限；修复后点「重新索引」。',
  openFile: '打开',
  tagsLabel: '标签',
  linksLabel: '出链',
  backlinksLabel: '反链',
  settingsTitle: '知识工作台',
  settingsDescription: '知识源请在「知识」页面管理。所有文件写入均需人工审阅，并由 Host 复核权限与文件版本。',
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
  newNoteTitleDialog: 'New note',
  newNoteTitleLabel: 'Title',
  newNoteTitlePlaceholder: 'Enter a note title',
  newNoteTitleInvalid: 'Enter a valid title without slash characters.',
  newNoteTitleTooLong: 'The file path is too long. Shorten the title or return to a parent folder.',
  newNoteContinue: 'Continue editing',
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
  inboxFilterAll: 'All',
  inboxFilterPending: 'Pending review',
  inboxFinalContent: 'Final content preview',
  inboxBaselineDiff: 'Diff from baseline',
  inboxEditDraft: 'Edit draft',
  inboxSaveDraft: 'Save draft',
  inboxCancelEdit: 'Cancel edit',
  inboxApplyToFile: 'Apply to file',
  inboxConfirmTitle: 'Confirm proposal application',
  inboxConfirmBody: 'Confirm the target path and content. The Host will re-check permissions and the file version.',
  inboxConfirmApply: 'Confirm apply to file',
  inboxDraftSaveFailed: 'Could not save the draft',
  inboxCompareCurrent: 'Load current file for comparison',
  inboxCurrentFile: 'Current file content',
  inboxRevision: 'Draft revision',
  inboxConfirmationStale: 'The draft changed while confirmation was open. Close this dialog, review the latest draft, and confirm again.',
  inboxRebase: 'Create a proposal from current baseline',
  inboxCreateConflictChooseOperation: 'The create target now exists. Choose the follow-up proposal type:',
  inboxRebaseCreateUpdate: 'Propose replacing from current file',
  inboxRebaseCreateAppend: 'Propose appending to current file',
  inboxRebasedFrom: 'Rebased from conflict',
  inboxAgent: 'Agent ID',
  inboxAgentUnknown: 'Unknown Agent',
  sourceRemoveConfirmTitle: 'Remove knowledge source?',
  sourceRemoveConfirmBody: 'This removes the plugin configuration and index only. Files on disk will not be deleted.',
  sourceRemoveConfirmAction: 'Confirm remove source',
  sourceRemovePending: 'This source has pending proposals. They will remain in Inbox but cannot be applied after removal; resolve or dismiss them first.',
  copyPath: 'Copy relative path',
  copiedPath: 'Path copied',
  copyPathFailed: 'Clipboard unavailable; copy the path manually',
  copyCitation: 'Copy citation',
  copiedCitation: 'Citation copied',
  copyCitationFailed: 'Could not access the clipboard',
  matchLine: 'Line',
  nativeOpenUnavailable: 'Native DSH file navigation is unavailable. Open a session and try again.',
  openInDsh: 'Open original in DSH',
  sourceSkipPolicy: 'Indexes Markdown/TXT; skips hidden, version-control, and build folders, plus configured exclusions.',
  sourceErrorHelp: 'Check that the path exists and DSH can read it, then choose Reindex.',
  openFile: 'Open',
  tagsLabel: 'Tags',
  linksLabel: 'Links',
  backlinksLabel: 'Backlinks',
  settingsTitle: 'Knowledge Workbench',
  settingsDescription: 'Manage knowledge sources in the Knowledge page. File writes always require review and Host permission/version checks.',
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
}

export const dictionaries = {
  zh: zhCN,
  en: enUS,
} as const
