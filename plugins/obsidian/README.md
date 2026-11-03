# dsh-obsidian

DSH Desktop Cordis plugin providing a local knowledge workspace for Obsidian Vaults and ordinary project folders.

## Features

- Configurable knowledge sources with include/exclude paths and Desktop native folder selection.
- Local Markdown/text indexing with SQLite FTS5, Wikilinks, tags, backlinks, and source watching.
- A directory-browsing view for folders and indexed notes, alongside full-text search.
- Agent tools for search, read, and submitting proposals to the knowledge inbox; proposals create pending drafts only and never write source files directly.
- Proposal inbox for explicit human review before version-guarded writes through DSH `ctx.fs`.
- Native DSH resource navigation for files inside the active workspace.

## Build and test

Requires Node.js 22+ and pnpm 10+.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The Node test suite exercises host parsing, indexing, scanning, path-boundary validation, resource URI encoding, source ID generation, and inbox persistence. It does not replace verification inside a running DSH Desktop instance.

## Development install

Build the package, then add the local plugin path to a DSH Desktop profile using the supported `dsh plugin --profile <profile> add <path>` command. Review the host compatibility audit and sandbox behavior before applying proposals to an external Vault.
