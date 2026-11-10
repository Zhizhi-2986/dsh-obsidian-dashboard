# dsh-obsidian · DSH 原生知识工作台

**dsh-obsidian 是 DSH 的原生知识工作台：把本地文件组织成可检索、可引用、可审阅并可复用的知识，让 Agent 的工作成果成为长期资产。**

面向 **DSH Desktop** 的独立插件，当前 MVP 提供：

- 新增「知识」侧栏入口与主面板，提供搜索、目录浏览和收件箱，**不替换**「文件」页面。
- 双知识源：可通过 DSH 原生目录选择器选择现有 **Obsidian Vault**，也可手动输入普通知识目录。
- 本地全文索引与检索：正文、标题、标签与 Wikilink 目标字段搜索；可按知识源目录逐层浏览已索引笔记，并解析出链/反链元数据。
- 搜索结果显示来源、相对路径和匹配行，可复制带上下文的引用，并通过 DSH 原生资源导航打开原文；知识源显示索引时间、文档数、错误和忽略规则。
- **知识收件箱（Review-before-write）**：提案经 UI 审阅、查看基线差异并确认后应用或忽略；写入使用版本守卫并遵从 DSH sandbox。
- 工作区内文件打开复用 DSH 原生资源导航，不另建文件 Tab；文件查看/编辑仍由 DSH 负责。
- 与 `dsh-enhanced` 相互独立：无它时仍可使用插件已实现的知识源、检索与收件箱能力。

## 兼容基线

| 项 | 值 |
|---|---|
| DSH Desktop | 2.0.18 nightly（mac-arm64 实机验证） |
| DSH 运行时 | `@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.5` |
| 插件形态 | Cordis 插件（`apply(ctx)` + `cordis.patch.yml` + `dsh.bundle`） |

宿主能力逐项审计结论见 [docs/dsh-api-compatibility.md](docs/dsh-api-compatibility.md)（阶段 0 交付物）；产品设计基线见 [docs/dsh-obsidian-design-v1.md](docs/dsh-obsidian-design-v1.md)。

## 当前实现

MVP 位于 `plugins/obsidian`，已包含：

- Cordis Host 插件入口与 `cordis.patch.yml`；Client 注册知识侧栏入口、主面板和插件详情页设置卡。
- Obsidian Vault / 普通目录知识源设置（Desktop 原生选择器或手动路径），递归扫描、忽略常见隐藏/构建目录、文件监听与增量同步。
- `node:sqlite` FTS5 本地索引、字段搜索、Wikilinks/标签解析、出链与反向链接数据；面板提供目录逐层浏览已索引笔记。
- 收件箱提案的持久化与 UI 审阅/应用/忽略；应用写入使用 `ctx.fs.writeText` 的 create-if-absent / replace-if-version 守卫。Agent 可调用 `knowledge_search` / `knowledge_read` 检索，也可用 `knowledge_propose` 创建待审核草案；Agent 工具不直接写入源文件，最终写入必须由用户在 UI 确认。
- 配置与索引分别存储：DSH ConfigForm 保存源设置；索引和收件箱 JSON 存在插件数据目录。Vault 写权限仍受 DSH sandbox 限制。

尚未完成或未验证：DSH Desktop 中原生选择器、搜索引用/原文导航、提案差异审阅与写入的完整实机验收。本轮本机构建和 92 项自动化测试通过；但本次 Desktop 无障碍树未能切换至知识面板，屏幕捕获也失败，因此没有将本轮代码视为已完成实机验收。构建与 DOM 测试不等于运行中的 Desktop 验证。

## 仓库结构

```text
dsh-obsidian-dashboard/
├── docs/                   # 设计基线与 rc.5 宿主能力审计
└── plugins/obsidian/        # dsh-obsidian 插件源码、测试与构建配置
    ├── src/client/          # React Client 面板、设置卡、RPC 镜像
    ├── src/host/             # 索引、扫描、文件监听、收件箱与宿主服务
    ├── src/shared/           # 设置与 RPC 契约
    └── test/                 # Node 内置测试
```

## 开发

要求 Node.js 22+（使用 `node:sqlite` 与原生 TypeScript strip-types 测试）及 pnpm 10+。在仓库根运行：

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

`plugins/obsidian/tsdown.config.ts` 将编译后的 Client 入口打包为 DSH Desktop `window.__ModuleLoader__` 插件工厂；Host 入口保留为 `lib/index.js`。

## 许可证

MIT
