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
| 11 | Inbox JSON persistence supports add/update/missing IDs and drops resolved entries before pending entries when capped. | `host.test.mjs` — inbox | integration | PASS |

## RED/GREEN evidence

- RED: `node --experimental-strip-types --test test/*.test.mjs` first failed the tag boundary assertion: the parser returned `knowledge.` for `#knowledge.`. After adding field-scope assertions, it also proved that `field: 'title'` incorrectly matched a body-only term.
- Root causes: the tag regex allowed terminal punctuation; FTS SQL did not constrain MATCH to the selected column, and link scope was routed to body search.
- GREEN: tag boundaries were tightened, field-qualified FTS queries and link-table search were implemented, and the suite passed (11/11). Tests also cover watcher-driven link refresh, failed-scan preservation, and temp-filesystem symlink/traversal containment.

## Validation executed

- `pnpm typecheck` — PASS.
- `pnpm test` — PASS, 11 tests; Node reports its expected experimental `node:sqlite` warning.
- `pnpm build` — PASS; emitted the DSH client bundle and Host/shared JS + declarations.

## Coverage and known gaps

No coverage instrumentation or percentage was run. These tests do not exercise live Cordis injection, a running DSH Desktop, sandbox transitions, watcher-error fallback behavior, resource navigation, the React UI, or RPC transport end-to-end. The watcher event test runs only on darwin. Source containment is checked through realpath/lstat and the rc.5 local stable target identity, but the path-based Host FS contract does not provide a directory-handle no-follow transaction; a malicious concurrent path swap remains a documented residual risk. Those remain manual/integration acceptance items; local build success is not Desktop runtime verification.
