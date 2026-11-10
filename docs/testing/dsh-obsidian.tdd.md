# dsh-obsidian MVP test evidence

## Source and scope

Derived from `docs/dsh-obsidian-design-v1.md` and the rc.5 compatibility audit. This report records Node-level coverage for the current host primitives, not a DSH Desktop end-to-end run.

## Journeys covered

- A user can parse note metadata, headings, tags, and Wikilinks into indexable content.
- A user can find indexed documents through field-scoped FTS5 search and link-target search, and inspect link relationships.
- A user can restrict indexed files by include/exclude rules while common hidden/build folders remain ignored.
- A user can read/write only ordinary files contained by a configured source root; traversal and symlink entries are rejected.
- A user can open a file with URI-safe encoding and add differently named sources even when their slugs collide.
- A user can preserve proposals in the inbox, update their status, and keep the configured item cap.

## Test specification

| # | Guarantee | Test | Type | Result |
|---|---|---|---|---|
| 1 | Frontmatter, headings, Wikilinks and tags are extracted; code-fence links/tags are not parsed as metadata. | `plugins/obsidian/test/host.test.mjs` — markdown parser | unit | PASS |
| 2 | The first heading wins as title; local links resolve only against known paths; external/traversal-like targets do not resolve. | `host.test.mjs` — digest and link resolution | unit | PASS |
| 3 | Search terms are quoted and FTS punctuation is sanitized; title/body scopes are distinct and link-target search returns matching referrers. | `host.test.mjs` — FTS query and SQLite index | integration | PASS |
| 4 | SQLite index inserts and retrieves docs, returns FTS highlights, tracks outgoing/back links, and deletes documents from search. | `host.test.mjs` — SQLite index | integration | PASS |
| 5 | A watcher change event reindexes changed outgoing links and re-resolves links when a target file is created. | `host.test.mjs` — deterministic watcher event integration | integration | PASS |
| 6 | A failed full scan retains the previous index and records a runtime error instead of reporting an empty source. | `host.test.mjs` — failed scan integration | integration | PASS |
| 7 | Configured-source path resolution rejects traversal, symlink leaves, and targets outside the root; safe existing and create-leaf paths resolve. | `host.test.mjs` — source path resolution | integration | PASS |
| 8 | Scanner applies include/exclude rules, ignores hidden/generated directories, converts paths, and rejects outside-root paths. | `host.test.mjs` — scanner | integration | PASS |
| 9 | Source IDs remain unique when names normalize to the same slug. | `host.test.mjs` — source IDs | unit | PASS |
| 10 | Resource URIs percent-encode session IDs and path segments while preserving path separators. | `host.test.mjs` — resource address | unit | PASS |
| 11 | DSH Agent tool registrations pass rc.5 schema validation after `defineTool` compiles author schemas. | `host.test.mjs` — tool registration | integration | PASS |
| 12 | Host config unwraps rc.5 `.volatile()` wrappers before using source arrays/settings. | `host.test.mjs` — Host settings reader | integration | PASS |
| 13 | Inbox JSON persistence supports add/update/missing IDs and drops resolved entries before pending entries when capped. | `host.test.mjs` — inbox | integration | PASS |
| 14 | Directory browse returns only immediate child folders and note files for root/nested paths. | `host.test.mjs` — SQLite directory listing | integration | PASS |
| 15 | Typert browse and knowledge RPC descriptors do not require an active Session lookup. | `client-registration.test.mjs` — RPC contract | unit | PASS |
| 16 | Client injects `remote.knowledge` before creating RPC callers and registers settings in the bundle detail slot. | `client-registration.test.mjs` — Client wiring | unit | PASS |
| 17 | Desktop picker result, cancel behavior and unavailable-picker fallback are handled. | `directory-picker.test.mjs` — picker adapter | unit | PASS |
| 18 | First launch creates the nested plugin data directory before SQLite opens. | `host.test.mjs` — fresh database initialization | integration | PASS |
| 19 | Knowledge panel renders its search idle state and Browse entry without requiring ConfigForms in the panel context. | `panel-render.test.mjs` — client render smoke test | integration | PASS |

## RED/GREEN evidence

- The rc.5 tool registry reproduced `unsupported JSON schema: schema.type must be one of object/array/string/number/integer/boolean/null` when the plugin passed `{ type: 'json' }` directly. `defineTool` now compiles it to a supported schema.
- Parsing the installed rc.5 Config produced `Volatile<T>` references (`.get()`), not plain arrays; the old Host apply path then failed at `.map()`. `settingsFromConfig` now unwraps those references, and the Host listens for volatile source updates.
- A fresh nested SQLite location reproduced `unable to open database file`; `KnowledgeIndex.open` now creates the parent directory first.
- The settings-slot regression test first failed because the Plugin Manager detail page reads `plugins.bundle.config`, not `plugins.item`. The settings card now registers under the bundle key.
- The Client wiring test now verifies that `remote.knowledge` is injected after `$mount` and before RPC callers are created; the earlier code accessed the namespace without `ctx.inject`, producing the reported `cannot get property "remote.knowledge" without inject` error.
- Root causes: tool definitions bypassed the rc.5 `defineTool` compiler; Host apply treated `Volatile<T>` Config fields as plain values; the plugin opened SQLite before creating its parent folder; settings were registered in the wrong slot; profile-level RPCs unnecessarily required a Session lookup; and Client RPC namespace access lacked its injection.
- GREEN: these paths are fixed, search failures are surfaced, and an indexed-directory browser is implemented. The complete suite passes (21/21); tests cover directory listings, scope-free RPC descriptors, Client namespace injection, bundle settings registration, and panel rendering in addition to prior Host behavior.

## Validation executed

- `pnpm typecheck` — PASS.
- `pnpm test` — PASS, 21 tests; Node reports its expected experimental `node:sqlite` warning.
- `pnpm build` — PASS; emitted the DSH client bundle and Host/shared JS + declarations.

## Coverage and known gaps

No coverage instrumentation or percentage was run. These tests do not exercise live Cordis injection, a running DSH Desktop, sandbox transitions, watcher-error fallback behavior, interactive React click flows, or RPC transport end-to-end. They smoke-render the initial panel and verify the browse descriptor/tab wiring; native chooser and Desktop RPC interaction still require a running DSH Desktop. The watcher flow uses a synthetic watcher event; OS-specific watcher delivery and watcher-error fallback remain unverified. Source containment is checked through realpath/lstat and the rc.5 local stable target identity, but the path-based Host FS contract does not provide a directory-handle no-follow transaction; a malicious concurrent path swap remains a documented residual risk. Those remain manual/integration acceptance items; local build success is not Desktop runtime verification.

## Knowledge-page source management and Gateway envelope regression

### Journey

- A user opens the Knowledge page, adds a folder as a knowledge source, sees it in Browse/Search, opens document content inside Knowledge without a Session sidebar or DSH filesystem read, and can remove the source later; source configuration persists outside the Plugins settings card.

### RED/GREEN evidence

- `knowledge-page source management persists a source and rejects duplicate paths` first failed because `KnowledgeService.addSource` did not exist; it now passes and verifies persistence across service reload and removal.
- `KnowledgePanelView opens the page-local source manager and adds a folder` verifies the page form invokes the add RPC and Browse refreshes after indexing completes. Before the indexing-state dependency was added, the browse result stayed stale after the source became indexed.
- `unwraps the installed DSH Gateway envelope before returning knowledge results` reproduced the listing regression: RC.5 Gateway success is `{ ok: true, value }`, while the plugin treated that outer object as the source result. The test failed with `value` present but no top-level `sources`; RPC callers now unwrap the envelope and map transport failures to `IO`.
- The Host source-management test now invokes the service through `Context.extend(...).get('knowledge')`, matching the Gateway's context-bound Service view. Before binding the `@Remote` methods, it reproduced the screenshot error `Cannot read private member #shuttingDown from an object whose class did not declare it`; the service now binds all exported Remote methods to the original instance, and add/list/remove pass through the proxy test.
- `reads source documents for the Knowledge preview without a DSH fs service` reproduces the old Host dependency on `ctx.fs`; the preview read now uses the plugin's bounded, source-contained Node read path.
- `opens a document inside the Knowledge page without a Session or sidebar file system` verifies the Open action displays the file content in a Knowledge-owned preview and succeeds with no Session, layout, or sidebar services in the Client context. This replaces the previous session navigation attempt, which visibly collapsed the user's sidebar.

### Validation executed

- `pnpm --filter dsh-obsidian test` — PASS, 27 tests.
- `pnpm --filter dsh-obsidian build` — PASS; rebuilt Host/shared JS and the Client bundle.
- `git diff --check` — PASS after the final source changes.

### Remaining verification

The tests cover RPC-envelope decoding, Host Gateway proxy calls, source add/remove/persistence and cancellation, folder validation, source-contained Node reads, the Knowledge-page UI, browse refresh after indexing, and inline document preview without Session or sidebar services. They do not replace a live DSH Desktop verification: the updated package still needs to be reloaded in the user's Desktop. No Desktop profile changes, installation, commits, or pushes were made.

## Agent proposal tool (2026-11-03)

### Journey

- As an Agent, I can submit a create/append/update draft into the configured knowledge source's inbox so the user can review it, without directly modifying source files.

### RED/GREEN evidence

- RED: the existing tool-registration test failed because only `knowledge_search` and `knowledge_read` were registered; new proposal-tool tests also failed because no `knowledge_propose` tool existed.
- RED: after registration, malformed input still reached the service; a test reproduced this by passing an empty title and an unexpected field.
- GREEN: `knowledge_propose` is registered through DSH `defineTool`, its required fields and operation enum compile to supported JSON Schema, and `ProposeInputSchema` rejects malformed arguments before the service is called. Valid requests delegate to the existing source/path-contained `KnowledgeService.propose` flow, which only creates a pending inbox item; the tool response omits draft body content. Service validation failures are returned as failures, not success.
- A real-service integration test now calls the tool against `KnowledgeService` with a configured temporary source: an in-source create becomes pending, a symlink pointing outside the source is rejected before `ctx.fs.resolve`, an unknown source is rejected, the inbox contains only the accepted draft, and `writeText` is never called. This closes the review-identified gap left by the mocked service-error forwarding test.
- The tool description and README state that applying the proposal remains a user action in the inbox UI; this tool does not call the write path.

### Validation executed

- `pnpm --filter dsh-obsidian test` — PASS, 31 tests (including proposal registration, success, service failure, malformed-input, and real-service containment cases).
- `pnpm --filter dsh-obsidian typecheck` — PASS.
- `pnpm --filter dsh-obsidian build` — PASS.

### Remaining verification

These are Node-level registration, real KnowledgeService, and mocked-service tests, not a live Agent turn through the installed DSH Desktop tool registry. Verify the newly built tool after reloading the linked plugin in Desktop. No Desktop profile changes, installation, commits, or pushes were made.

## v1.1 reviewed P0 slice (2026-11-03)

### Scope and journeys

Derived from `/Users/zhizhi/Downloads/dsh-obsidian-v1.1-%E9%9C%80%E6%B1%82%E4%B8%8E%E5%8E%9F%E5%9E%8B/dsh-obsidian-requirements-v1.1.md`. This change implements a first vertical P0 slice, not the entire PRD:

- As a reader, I can read supported Markdown structure inside the Knowledge panel, follow resolved Wikilinks internally, copy a relative path, and not execute source HTML or unsafe link protocols.
- As a search user, I can type a query and get debounced results from the latest query without stale responses replacing them.
- As a reviewer, I can inspect a proposal's complete body, baseline/final preview and Diff, see the originating DSH Agent ID, edit/save its draft, and only write after confirming the target.
- As a reviewer, I see path/version/permission conflicts instead of silently overwriting or losing the proposal, can load the current target for comparison, and simultaneous proposals for one target are serialized.
- As a user, I can request source reindexing and must confirm source removal; the confirmation explains that original files remain on disk.

### RED/GREEN evidence and guarantees

- RED: new Host tests failed because `baselineContent` was absent and applying an item with a missing `baseVersion` incorrectly succeeded. The Markdown DOM test failed because the reader had no rendered heading. The first inbox UI test run stopped at a selector mismatch (`Inbox` vs `Inbox (1)`), so that output was not counted as behavioral RED; after fixing the selector, the full review flow was exercised and passed.
- GREEN: `host.test.mjs` now verifies baseline capture, draft-only update persistence, a changing baseline rejected during capture, stale/missing base rejection, same-target concurrent application, edit-vs-apply serialization, permission/read-only structured errors, safe Inbox migration, pending-item retention at capacity, service-restart source/Inbox recovery and Markdown reindexing, disk-file preservation when a source is removed, source-add persistence failure mapped to a structured error without in-memory mutation, originating Agent ID persistence from the DSH tool execution context, cancellation propagation to `knowledge_propose`, and create-conflict status retention for explicit append/update rebase.
- GREEN: `panel-render.test.mjs` verifies headings, tables, fences, blockquotes, lists, tags, copy-path behavior, safe image placeholders, raw HTML staying inert text, javascript links not becoming anchors, and resolved Wikilink navigation—including heading-fragment scrolling—using the existing read RPC.
- GREEN: `inbox-review.test.mjs` verifies the search input debounces to only the latest query; Host `searchSequence` guards against older in-flight responses taking over.
- GREEN: `inbox-review.test.mjs` verifies create/update/append final previews, saved edits, no write before confirmation, apply after confirmation, explicit source-removal confirmation, manual reindex status refresh, current-target comparison, explicit append/replace choices for conflicted create proposals, and creating a new rebased proposal while retaining the conflicted original.
- Review fixes: append preview/diff now uses the same whitespace/newline semantics as Host writes; draft updates share the per-target lock with apply/dismiss, and the editor is disabled during save; stale document reads are discarded and Wikilink navigation preserves the Browse return tab; Inbox migration is serialized and pending proposals are never silently evicted; new proposal growth is budgeted at 8,000,000 bytes while all Inbox reads/writes have a 256,000,000-byte legacy-compatible hard bound; same-process InboxStore instances share a per-file mutation queue; a successful file write is reported as applied even if recording Inbox status fails, with a visible status warning; removing a source warns and conflicts retained pending proposals; failed Inbox/source-store removal steps restore prior pending statuses when possible and report incomplete rollback explicitly.
- Follow-up security fixes: proposal baselines and apply-time append reads use rc.5 `ctx.fs.readBytes(..., maxBytes)` with a 4 MiB cap; preview and index reads use chunked no-follow bounded readers. The scanner validates entries against its source root; index permission errors propagate as runtime health failures rather than deleting indexed docs. Source roots are pinned by realpath + device/inode in `sources.json`, checked on read/propose/apply and runtime sync; proposal creation and removal share a settings queue. `EACCES`/`EPERM` pass through path resolution and map to `PERMISSION_DENIED`; apply also uses `ctx.fs.contains` immediately before the guarded write. On POSIX, plugin data directories are chmodded to `0700` and Inbox/source files plus the SQLite main DB to `0600`; data writes use unique exclusive/no-follow staging files and reject symlink storage files. Windows relies on inherited profile ACLs and was not runtime-verified.
- Host returns `OUTSIDE_SOURCE`, `PERMISSION_DENIED`, and `READ_ONLY`/`SANDBOX_DENIED` as machine-readable failures. `READ_ONLY` mapping follows the installed `dsh-fs-sandbox` error message (`read-only mode`); the write still goes through `ctx.fs.writeText` with guarded intent. A successful file write attempts immediate reindex and returns a recoverable `syncError` if indexing fails.
- The ineffective `keepDraftOnConflict` control was removed from the plugin-facing settings UI and runtime settings projection. Legacy unknown settings may still be carried through the installed settings parser, but are not consumed by the Host.

| # | Guarantee | Test | Type | Result |
|---|---|---|---|---|
| 1 | Standard Markdown blocks are rendered as React text/elements; hostile HTML and non-HTTP(S)/mailto links cannot create executable markup/navigation. | `plugins/obsidian/test/panel-render.test.mjs` — Knowledge preview | DOM integration | PASS |
| 2 | A resolved Wikilink calls the bounded source read; document tags and copy-relative-path action are visible in the Knowledge-owned preview. | `panel-render.test.mjs` — internal link and path actions | DOM integration | PASS |
| 3 | Search typing is debounced; only the latest query is sent, and a slower old response cannot replace newer results. | `plugins/obsidian/test/inbox-review.test.mjs` — search debounce/stale response | DOM integration | PASS |
| 4 | Append/update proposals capture the target content/version; changes during capture, missing versions, and stale versions cannot apply. | `plugins/obsidian/test/host.test.mjs` — baseline guards | integration | PASS |
| 5 | Same-target proposals serialize; only one can apply from the captured version. | `host.test.mjs` — concurrent proposals | integration | PASS |
| 6 | Draft edits persist without changing baseline; create/append/update final content and Diff can be inspected before apply. | `plugins/obsidian/test/inbox-review.test.mjs` — inbox review | DOM integration | PASS |
| 7 | Applying requires a second explicit confirmation; permission/conflict failures do not mark the item applied. | `inbox-review.test.mjs`, `host.test.mjs` | integration | PASS |
| 8 | Source removal requires a confirmation and communicates that disk files are retained. | `inbox-review.test.mjs` — source removal | DOM integration | PASS |
| 9 | Legacy pending append proposals without a captured baseline are retained but conflicted, not silently applied. | `host.test.mjs` — InboxStore migration | integration | PASS |
| 10 | An edit racing with apply cannot leave an applied Inbox body different from the body written. | `host.test.mjs` — edit/apply serialization | integration | PASS |
| 11 | Legacy migration and concurrent add retain both records; Inbox cap refuses to evict pending items. | `host.test.mjs` — InboxStore migration/cap | integration | PASS |
| 12 | A conflicted proposal can load its current target, compare the diff, and create a new pending proposal with that baseline while retaining the conflicted original. | `inbox-review.test.mjs`, `host.test.mjs` — rebase flow | integration | PASS |
| 13 | Aggregate Inbox JSON size is bounded; overflow rejects new proposals instead of growing storage without limit. | `host.test.mjs` — aggregate baseline cap | integration | PASS |
| 14 | A successful file write is never misreported as a failed write when persisting the Inbox status fails; the caller receives a recovery warning. | `host.test.mjs` — status persistence failure | integration | PASS |
| 15 | Saving proposal A cannot close or discard an unsaved editor for proposal B; source removal warns about pending proposals that will remain unappliable. | `inbox-review.test.mjs` — concurrent editor/source warning | DOM integration | PASS |
| 16 | Oversized baseline metadata is rejected before content reads; baseline bytes are bounded by the rc.5 `readBytes` API. | `host.test.mjs` — oversized append target | integration | PASS |
| 17 | Inbox update/read/write enforce the finite storage bound without evicting pending records; the 8 MB add budget does not lock out valid legacy stores above that budget. | `host.test.mjs` — Inbox cap and legacy compatibility | integration | PASS |
| 18 | OS `EPERM`/`EACCES` during baseline read/write maps to `PERMISSION_DENIED`. | `host.test.mjs` — baseline/write permission cases | integration | PASS |
| 19 | Proposal creation serializes with source removal; apply rechecks provider containment before guarded write. | `host.test.mjs` — source lifecycle and containment recheck | integration | PASS |
| 20 | Replacing a configured root with a symlink to another directory is rejected on read/propose; newly added sources persist dev/inode identity. | `host.test.mjs` — source-root pinning/source management | integration | PASS |
| 21 | Multiple InboxStore instances in the same process serialize writes to one data directory. | `host.test.mjs` — shared InboxStore queue | integration | PASS |
| 22 | `readSource` rejects an oversized file from metadata before reading content. | `host.test.mjs` — oversized source read | integration | PASS |
| 23 | Permission errors from `realpath`/`lstat` propagate to the service and map to `PERMISSION_DENIED`. | `host.test.mjs` — locked source | integration | PASS |
| 24 | `knowledge_propose` stores the Agent ID provided by the installed DSH `ToolRunContext` on the Inbox item. | `host.test.mjs` — Agent attribution | integration | PASS |
| 25 | Rebaselining a conflicted append/update creates a new item with the latest bounded snapshot and links it to the retained conflict. | `host.test.mjs` — safe rebase | integration | PASS |
| 26 | Manual reindex calls the Host RPC and refreshes the source count/status shown in the panel. | `inbox-review.test.mjs` — reindex action | DOM integration | PASS |
| 27 | The file-handle reader detects growth after its initial size check while reading at most the byte cap plus one byte. | `plugins/obsidian/test/bounded-read.test.mjs` — bounded read helper | unit | PASS |
| 28 | Index reads do not follow symlink leaves; size limits and OS permission errors propagate to callers. | `plugins/obsidian/test/read-file.test.mjs` — index file reader | integration | PASS |
| 29 | Incremental index permission errors preserve prior docs and expose `lastError` instead of reporting success. | `host.test.mjs` — index permission handling | integration | PASS |
| 30 | The installed `ToolRunContext.signal` reaches `knowledge_propose`; an already-cancelled call does not create an Inbox item. | `host.test.mjs` — Agent cancellation | integration | PASS |
| 31 | Root replacement and cancellation during rebase cannot persist a new baseline; the old conflicted proposal remains. | `host.test.mjs` — rebase race/cancellation | integration | PASS |
| 32 | Legacy configured sources acquire and persist a device/inode identity during startup migration. | `host.test.mjs` — legacy source root pinning | integration | PASS |
| 33 | A source-store save failure during removal keeps the configured source and restores pending proposals. | `host.test.mjs` — source-store failure compensation | integration | PASS |
| 34 | A later Inbox conflict-write failure restores proposals already changed by the same removal attempt. | `host.test.mjs` — Inbox write failure compensation | integration | PASS |
| 35 | Apply confirmation carries the reviewed Inbox revision; Host rejects stale revisions before writing and the UI reloads the latest draft. | `host.test.mjs`, `inbox-review.test.mjs` — stale confirmation | integration | PASS |
| 36 | POSIX plugin data directory, Inbox/source files, and SQLite main database are hardened to private modes, including pre-existing permissive paths. | `host.test.mjs` — private storage modes | integration | PASS |
| 37 | A symlinked Inbox data file is rejected rather than chmodded or read through to its target. | `host.test.mjs` — symlinked Inbox storage | integration | PASS |
| 38 | An apply queued behind another target mutation rechecks its expected revision under the lock and never writes twice. | `host.test.mjs` — apply revision lock race | integration | PASS |
| 39 | A symlinked plugin data directory is rejected before chmod or file access reaches its target. | `host.test.mjs` — storage directory symlink | integration | PASS |
| 40 | Directory create/remove watcher events full-sync nested notes and remove stale descendants. | `host.test.mjs` — watcher subtree events | integration | PASS |
| 41 | Reconstructed Host service reloads persisted sources/Inbox drafts and startup indexing observes changed Markdown. | `host.test.mjs` — service restart recovery | integration | PASS |
| 42 | Source-store failure during add returns a structured permission/storage error without adding the source in memory or on disk. | `host.test.mjs` — add persistence failure | integration | PASS |
| 43 | A Wikilink fragment uses rendered heading text, scrolls to that anchor, and duplicate/generated IDs remain unique. | `panel-render.test.mjs` — heading-fragment navigation | DOM integration | PASS |
| 44 | Heading-fragment scrolling stays within the Knowledge panel instance that initiated navigation. | `panel-render.test.mjs` — two-panel navigation isolation | DOM integration | PASS |
| 45 | A create conflict remains conflicted and the reviewer can create a fresh append or update proposal with the current-file baseline. | `host.test.mjs`, `inbox-review.test.mjs` — create-conflict conversion | integration | PASS |
| 46 | A create target appearing after initial stat but before write is persisted as conflicted and never written. | `host.test.mjs` — pre-write create race | integration | PASS |
| 47 | A create conflict after target arrival supports explicit append/update conversion while preserving the original proposal. | `host.test.mjs`, `inbox-review.test.mjs` — create conversion choices | integration | PASS |

### Validation executed

- RED observed on the new missing-baseline, missing-version and Markdown rendering tests before their corresponding fixes.
- `pnpm test` — PASS, 92 tests. The Node experimental `node:sqlite` warning remains expected.
- `pnpm typecheck` — PASS.
- `pnpm build` — PASS; DSH client bundle emitted.
- `git diff --check` — PASS.

### Coverage and remaining P0 verification

No coverage percentage was generated; the package has no coverage script. Tests are Node/React DOM integration tests, not DSH Desktop E2E. This slice does not complete all v1.1 P0 acceptance: the originating Agent ID is recorded, but no friendly-name mapping is available in the current tool context; add-source runtime-initialization failure injection, the complete multi-OS/permission matrix, actual DSH plugin restart/reindex recovery, and live DSH Desktop flows still need follow-up. A reconstructed Host service's persisted-source/Inbox load and startup reindex are covered by a Node integration test. When a create target appears before apply, the proposal becomes conflicted and can be converted—only by explicit reviewer choice—into a fresh append or update proposal.

The source-root device/inode identity is persisted and rechecked. Legacy sources without an identity are pinned to the root observed during this version’s first launch; any rebinding that occurred before that migration cannot be reconstructed. Windows does not provide the POSIX `O_NOFOLLOW` flag used by index reads here; path/file-identity rechecks are best-effort and the Windows matrix was not run. rc.5 `FsTarget` is a path identity and `writeText` has no configured-source-root atomic guard; a local symlink/path swap in the final check-to-write window remains a conditional residual. rc.5’s version guard is under an in-process lock, so an unrelated external editor process can still race between version check and atomic publication. `applyInbox` remains a Client Remote without a Host-verifiable user-gesture/approval capability; it is bound to the reviewed Inbox revision, and Agent tools do not expose it, but an untrusted caller with Remote access can still supply the current revision without proving a gesture. InboxStore coordinates multiple instances in the same process; cross-process locking is not implemented. POSIX private-storage modes and no-follow handles protect against other UIDs after initialization, but the sequence still uses path-based reads/renames after descriptor checks (for example Inbox `createReadStream` and atomic rename). A concurrent process under the same UID can swap the data-directory/file path between check and use; eliminating that requires directory-handle/openat-style operations, which are not used here. Closing the remaining host/path races needs stronger DSH filesystem capabilities or a new explicit trust contract; this change does not bypass `ctx.fs`/sandbox. No Desktop installation/profile change was made; no development commit or push was made after baseline commit `3cf01b1`.

### Search references and native return path

The search citation DOM check asserts source, relative path, hit line, and copied snippet. The native open action returns from the global panel to the Conversation, opens an authorized `dsh-resource://file/session/<sessionId>//<absolute-path>` address, and forwards the hit line through rc.5 `sidebarRight.openResource(..., { params: { line } })`; the address and APIs are verified against installed rc.5 source. This remains DOM verification: the Knowledge panel did not become visible through the current Desktop accessibility bridge, and ScreenCaptureKit returned an error, so the native open action has not been exercised in a running DSH session for this build.

The Host FTS test verifies that matching text after frontmatter and headings reports its original source line; a source-root restoration test verifies manual reindex recreates a missing runtime; an Inbox DOM test verifies a failed dismissal is visible and leaves the proposal pending. These are Node/DOM checks, not live Desktop acceptance.
