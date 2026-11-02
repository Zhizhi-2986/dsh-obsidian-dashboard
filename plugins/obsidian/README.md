# dsh-obsidian

DSH Desktop Cordis plugin providing a local knowledge workspace for Obsidian Vaults and ordinary project folders.

## Features

- Configurable knowledge sources with include/exclude paths.
- Local Markdown/text indexing with SQLite FTS5, Wikilinks, tags, backlinks, and source watching.
- Search/read Agent tools (read-only).
- Proposal inbox for explicit review before version-guarded writes through DSH `ctx.fs`.
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
