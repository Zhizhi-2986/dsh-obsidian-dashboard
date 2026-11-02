# dsh-obsidian · 宿主能力兼容性审计（阶段 0）

> 目标宿主：**DSH Desktop 2.0.18 nightly（mac-arm64）**，运行时 **`@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.5`**
> 审计对象：实际安装的解包源码 `/tmp/dsh-src/dsh/node_modules/@deepseek-ai/*`（构建产物 JS + README + package.json）与 `dsh-cordis-client-runner` 内置 slot 契约目录
> 参考实现：`dsh-plugins` 仓库 `plugins/workspace-files`（dsh-workspace-enhanced 0.0.3，实机验证过宿主写入链路）
> 评审口径：`Supported` / `Adapter Needed` / `Unsupported`
> 发布日期：2026-11-02

## 0. 环境与版本锁定

| 项 | 值 | 证据 |
|---|---|---|
| Desktop 版本 | 2.0.18 nightly，mac-arm64 | `app-update.yml`（channel: nightly, feeds/mac-arm64/） |
| 运行时 | `@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.5` | 解包 `dsh/package.json`（`"version": "0.2.1-rc.5"`） |
| npm registry | `@deepseek-ai/dsh@0.2.1-rc.5` 与配套包已发布 | `npm view @deepseek-ai/dsh version` → `0.2.1-rc.5` |
| 构建环境 | node v22.23.2 / pnpm 10.33.4（宿主 runtime 提示 node 24.21.0 / pnpm 11.28.5，见 runtime/versions.json；差异可接受） | 本机实测 |
| Git 身份 | `zhizhi-2986 <yliu2986@gmail.com>`（GitHub），仓库级覆盖全局「南京-刘阳」 | `git config user.*` |

## 1. 关键结论速览

| 设计文档 §6.1 声称 | 结论 | 证据 |
|---|---|---|
| `sidebar.panellist` 左侧面板注册 | **Supported**（list slot，root scope） | ui-sidebar `client.js` 渲染 `sidebar.panellist`；注册契约见 §2 |
| root `main` keyed slot | **Supported**（keyed slot，root scope，`conversation` 为保留 key） | ui-layout `client.js:119` `renderSlot("main", {}, { entryKey: activePanelId ?? "conversation" })`；契约见 §2 |
| 与「对话/Git/上下文」同级 | **Adapter Needed**：官方机制是 sidebar 面板行（Plugins/Automation 同款）；Desktop 顶部 strip 的注入点在 rc.5 源码中无证据，不宣称支持 | §2.4 |
| `ctx.sidebarRight` / openResource | **Supported**（client 服务 `sidebarRight.openResource(address, options)`） | ui-sidebar-right `client.js:2234`；§4 |
| `ctx.sidebarRightTabs` | **Adapter Needed**：`openTabs` 有成员快照但无激活/导航修订事件（dsh-enhanced 实测），近期/激活推断不可靠 | §4 |
| `files` 内置 tab | 存在且保留（不替换）；`sidebar.right.tab.files.actions` 是公开附加动作区 | §4 |
| `ctx.documentPreviews` | **Adapter Needed**：原生 Preview 按 `sidebar.right.tab.document` keyed slot 分发；插件不注册 renderer，直接复用原生预览 | §4 |
| `ctx.workspaceFiles` | **Adapter Needed**：`dsh-api-workspace-files` 封装 Session 工作区内的读/写/搜索；外部 Vault 需直接走 `ctx.fs` | §5 |
| `ctx.fs` readText/writeText | **Supported**：`ctx.fs` 服务真实存在（resolve/readText/listDir/watch/writeText/editText），版本守卫可选，`FS_STALE_VERSION` 等类型化错误 | §5 |
| DSH 插件工具/命令注册 | **Supported**：`ctx.tools.register(defineTool({...}))`（`@deepseek-ai/dsh-tools`），JSON schema 风格参数 | §6 |
| Client–Host RPC | **Supported**：typert protocol + `ctx.remote.$mount`（dsh-workspace-enhanced 实机验证） | §6 |
| 插件设置持久化 | **Supported**：`ctx.configForms`（ConfigForm，Host 共享 profile，revision fence） | §6 |

## 2. 插件工程约定与「知识」入口（审计 A）

### 2.1 插件形态

- DSH 插件 = **Cordis 插件**：入口模块导出 `name` / `inject`（服务清单）/ `apply(ctx)`；client 半区在 `package.json` 声明 `dsh.client`（`inject` 服务清单 + `platform: "web"`），renderer 按插件 `exports["./client"]` 加载。
- 分发：`dsh.bundle.manifest` + `cordis.patch.yml`（`- insert: [{ id, name }]`），安装命令 `dsh plugin --profile <profile> add <package-or-local-path>`；本地开发可把 patch 的 `name` 写成绝对路径直接加载 `src/index.ts`。
- 参考：`dsh-plugins` 仓库 hello-plugin / workspace-files；版本配套全部锁定 `0.2.1-rc.5`。

### 2.2 面板注册机制（知识入口的官方路径）

`dsh-cordis-client-runner` 内置 slot 目录（`packages/client/ui-cordis` 的凭证，rc.5 实机含 103 个 slot 契约）给出权威契约：

**`sidebar.panellist`**（kind=list, scope=root）
> "Global panel icons. Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata."
> 现有占用者：`client-ui-plugin-manager PluginsPanelIcon`、`client-ui-schedule TaskManagerIcon`

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'my-entry', order: 100, label: 'My entry' },
  () => React.createElement('div', null, 'hello'),
))
```

**`main`**（kind=keyed, scope=root）
> "Central panel selected by sidebar entry id. The reserved `conversation` key hosts the Conversation; **other keys receive no Session binding**."
> standardProps：`useResource` / `useWorkspaces` / `useSessions` / `usePanelInfo` 等 hooks。

```js
// ui-layout 按 activePanelId 分发；无激活时回退 "conversation"
renderSlot("main", {}, { entryKey: usePanelInfo((info) => info.activePanelId) ?? "conversation" })
```

**结论：`知识` = `sidebar.panellist` 注册 `id: "knowledge"` 图标行 + `main` 注册 `key: "knowledge"` 面板组件。** 与 Plugins（order 0）、Automation tasks（order 10）同机制；`order` 决定行序。

### 2.3「知识」面板的形态约束

- **无 Session 绑定**：`main` 非 conversation key 不接收 Session 上下文 —— 知识面板必须自行（或经 RPC）管理当前会话/工作区身份，与 workspace-files 的 `uiSession` 注入模式一致。
- 选中态由 layout store 管理：`usePanelInfo`（`activePanelId`）、`selectPanel(id)`；面板行 label 由列表元数据解析（支持 locale）。
- 面板内容建议遵守喇叭口径：知识面板 = 检索/列表/收件箱；文件打开一律 `sidebarRight.openResource` 交给原生文件 Tab（复用既有 Tab 聚焦）。

### 2.4 风险与未证实项

- **顶部 tab strip（对话/行情/Git/上下文）的注入机制在 rc.5 源码中未找到公开 slot**：`conversation` 为 main 的保留 key（无 panellist 行），行情/Git 等行的注册位置（`apps/desktop` 或 `dsh-client-ui-entry-customization` 的 More 菜单）未能定位到公开契约。因此「知识」作为 **sidebar 面板行 + main 面板** 是已证实路径；若产品要求与现有顶部 tab 完全同条，需实机装上跑一次确认视觉形态（列入实机验证清单）。
- 插件市场/More 菜单（`sidebar.panellist.actions`）可加条目（entry-customization 先例），但非主入口。

## 3. 右侧文件区与资源导航（审计 B）

**`sidebarRight`**（ui-sidebar-right，client 服务，inject: `sidebarRight`）真实导出导航控制：
- `openResource(address, options?)`（client.js:2234）与 `openResourceIn(sessionId, address, options?)` —— 打开/聚焦资源的唯一公开入口。
- 资源地址（session-scoped file）：`dsh-resource://file/session/<sessionId>/<path>`，workspace-files 的 `workspace-address.ts` 提供完整 encode/parse（含编码、绝对路径按 cwd 裁剪）。
- `openTabs` 有成员快照（可枚举已开 Tab），但**无激活 Tab / 导航修订事件**（dsh-enhanced 实机验证结论）→ “最近访问”不基于 Tab 成员推断。
- `sidebar.right.tab.files.actions`（list, session）：原生文件树动作区，workspace-files 在此附加 Quick Open/Favorites/Create File。
- `sidebar.right.tab.document`（keyed, session）：原生文档 Tab body 分发（Markdown/Code/Plain Text 等 key）；插件可覆盖 body（dsh-enhanced 做法），dsh-obsidian **不覆盖**，直接复用原生预览。
- 目录选择器：`dsh-client-ui-directory-picker-browse` / `-native` 存在（slot 目录未见专用契约），实机可用性标记待验证（列入实机清单）。

## 4. 文件系统 / 授权 / 版本守卫（审计 C）

**`ctx.fs` 服务（`@deepseek-ai/dsh-fs`，README 为权威契约）**：
- 原语：`resolve(path,{cwd})→FsTarget(targetKey/displayPath)`、`stat`、`readText` / `streamText` / `readBytes(maxBytes)`、`listDir`（单层）、`watch(target, changed, signal)`（文件/目录单层变更通知）、`writeText` / `editText`（原子，可选版本守卫）。
- 错误为类型化 `FsError` 稳定码：`FS_NOT_FOUND` / `FS_STALE_VERSION` / `FS_AMBIGUOUS_EDIT` / `FS_TOO_LARGE` / `FS_NOT_TEXT` / `FS_SANDBOX_DENIED` / `FS_PERMISSION_DENIED`。
- **版本守卫**（review-before-write 的宿主支撑）：read 返回 `FsVersion`，write/edit 传可选 guard；版本不符 → `FS_STALE_VERSION`。dsh-workspace-enhanced 的 `createIfAbsent` / `replaceIfVersion` 即基于此封装（254 行 fs-service.ts）。
- **沙箱（`@deepseek-ai/dsh-fs-sandbox` + `dsh-sandbox-policy`）**：按 session sandbox mode 限制 **mutation**（read-only 全拒；workspace-write 仅 workspace root + 平台临时区；danger-full-access 不限制）；**读取/列举/只读 watch 不受限制**（"Reads, listings, metadata, and read-only watches work exactly as with fs-local"）。
- **对「工作区外 Vault」的结论**：读可行；用户提案写入在 `workspace-write` 模式下会被沙箱拒绝。当前实现将拒绝映射为 `SANDBOX_DENIED` 并提示切换工作区/提高授权；不会绕过 `ctx.fs` 写入守卫（`src/host/knowledge-service.ts`）。
- **源目录边界**：RPC 路径先做 lexical normalization，再解析 source root / parent / leaf 的真实路径；拒绝 traversal 与 symlink leaf，并确认 rc.5 `dsh-fs-local` 的稳定 target identity 等于已校验的 canonical path。stat/read/write 使用同一个已解析 `FsTarget`（`src/host/source-path.ts`、`src/host/knowledge-service.ts`）。
- **变更同步（K-10）**：当前索引运行时通过 `node:fs.watch` 递归监听（darwin），启动失败或后续 watcher error 时降级为 30 秒轮询；变更经防抖后增量同步并刷新链接图（`src/host/knowledge-source.ts`）。这不是 `ctx.fs.watch` 的调用链。完整扫描若遇 root 缺失或 I/O 错误会保留旧索引并记录错误，而不是把不完整目录当成空源。
- **全文索引**：宿主无内置 FTS；当前实现使用 Node 22 `node:sqlite` 的 FTS5（`src/host/indexer.ts`），数据库放在插件数据目录。插件数据文件（索引、收件箱）以 `node:fs` 管理；知识源提案写入仍走 `ctx.fs`。
- **目录选择器**：本次基线未找到可用的公开 picker client 服务；当前设置卡采用手动输入路径。

## 5. Agent 工具 / RPC / 设置（审计 D）

**Agent 工具注册（`@deepseek-ai/dsh-tools` + `ctx.tools`）**：
```js
ctx.tools.register(defineTool({
  name: '...', description: '...',
  parameters: { /* JSON schema 风格字段 */ },
  output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: '...' }] },
  execute(args, exec) { ... },   // exec.signal / exec.agent 可用
  presentCall: (args) => ({ card: 'generic', kind: 'read', title: '...' }),
}))
```
- 先例：`dsh-tool-cordis`（只读 inspector 工具）。
- 当前插件注册的工具为 `knowledge_search` / `knowledge_read`（`src/host/tools.ts`），均为只读；收件箱提案经 Client RPC + UI 审阅，不注册 `knowledge_capture` 或可直接覆盖知识库的 Agent 工具。

**Client–Host RPC**：typert protocol（`@deepseek-ai/dsh-typert-protocol`）。Host `KnowledgeService` 提供列源、索引、搜索、读文档、提案/列举/应用/忽略收件箱 RPC；Client 通过 `ctx.remote.$mount(TYPERT_REMOTE)` 挂载，并在每个调用上携带 `workspaceFileScope` lookup 参数（`src/host/knowledge-service.ts`、`src/client/remote.ts`）。

**设置持久化**：`ctx.configForms.get<ObsidianSettings>(NS)` 获取 ConfigForm；配置字段以 `.volatile()` 声明。设置卡注册在 `plugins.item` slot，且使用 `configForms.whileServed([NS], ...)` 绑定设置命名空间服务周期（`src/client/index.tsx`）。

## 6. 风险清单与实施建议

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 顶部 tab strip 注入机制无源码证据 | HIGH | 首期以 sidebar 面板行 + main 面板交付（已证实）；实机装上后复核视觉要求 |
| R2 | 工作区外 Vault 写入被沙箱拒绝 | HIGH | 写入目标限定授权工作区内；外部 Vault 引导“切换/添加工作区”；写入前检查+失败提示 |
| R3 | `node:fs.watch({ recursive: true })` 的平台支持与大量变更处理 | MED | 当前 darwin 递归 watch + 30 秒轮询降级 + 500ms 防抖；需在目标 Desktop 实机验证 |
| R4 | 宿主无内置 FTS；SQLite FTS5 数据库需可重建 | MED | 使用 Node `node:sqlite` FTS5，索引存插件数据目录；源文件为真值 |
| R5 | main 面板无 Session 绑定 | MED | 面板内显式取当前会话/work区（经 RPC 或 client 服务） |
| R6 | openTabs 无激活事件 → 最近浏览不可靠 | LOW | “最近”按用户交互记录（插件本地）实现 |
| R7 | rc.2→rc.5 行为漂移 | MED | 全部依赖锁 0.2.1-rc.5；实机安装 + 验收用例 AC-01…AC-18 |
| R8 | 路径 API 无目录句柄级 no-follow 原子操作；恶意并发替换路径仍可能形成极窄 TOCTOU 窗口 | MED | 拒绝 symlink、校验 canonical root/target identity；不要把来源目录开放给不可信并发写入者，后续如宿主提供 handle-based API 再升级 |

## 7. 阶段 1 边界（依审计收敛）

- **入口**：`sidebar.panellist`（id `knowledge`）+ `main` keyed panel（key `knowledge`）。
- **知识源（当前实现）**：设置卡手动录入目录路径；Host 用 `node:fs` 扫描和读取文件，支持 include/exclude 与常见忽略目录；无 picker client 服务，未实现目录选择器。
- **打开文件（当前实现）**：工作区内文件通过 `sidebarRight.openResource(dsh-resource://file/session/...)` 交给原生资源视图；工作区外 Vault 文件不伪造 session 资源地址。
- **写入（当前实现）**：收件箱审阅后通过 `ctx.fs.writeText` + 版本守卫写入，失败保留/标记提案状态；不绕过 sandbox。差异预览尚未实现。
- **Agent（当前实现）**：仅注册只读检索/读取工具；提案写入只能由 UI 收件箱审核流发起。
- **实机验证清单（尚未执行）**：panellist 行与会话切换、openResource 聚焦既有 Tab、外部 Vault 读/写 sandbox 行为、文件变更同步、深浅色/窄栏（AC-17）、禁用 dsh-enhanced 场景（AC-01）。

## 8. 结论

**宿主 API 可行性：源码审计成立；插件实现状态：MVP 已构建并通过当前 Node 测试/typecheck。** 审计确认 `sidebar.panellist` + `main` keyed slot、`sidebarRight.openResource`、`ctx.fs`（含版本守卫）、typert RPC、Agent `ctx.tools`、ConfigForm 设置均存在于 rc.5 宿主契约。仍需在运行中的 DSH Desktop 2.0.18 实机验证插件加载、面板交互、沙箱行为与文件监听；源码审计和本地构建不等于实机验收。
