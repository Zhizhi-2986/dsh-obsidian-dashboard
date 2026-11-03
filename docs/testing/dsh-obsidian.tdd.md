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
| 5 | Recursive file watching refreshes changed outgoing links and re-resolves links when a target file is created. | `host.test.mjs` — watcher integration (darwin) | integration | PASS |
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

No coverage instrumentation or percentage was run. These tests do not exercise live Cordis injection, a running DSH Desktop, sandbox transitions, watcher-error fallback behavior, interactive React click flows, or RPC transport end-to-end. They smoke-render the initial panel and verify the browse descriptor/tab wiring; native chooser and Desktop RPC interaction still require a running DSH Desktop. The watcher event test runs only on darwin. Source containment is checked through realpath/lstat and the rc.5 local stable target identity, but the path-based Host FS contract does not provide a directory-handle no-follow transaction; a malicious concurrent path swap remains a documented residual risk. Those remain manual/integration acceptance items; local build success is not Desktop runtime verification.

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
