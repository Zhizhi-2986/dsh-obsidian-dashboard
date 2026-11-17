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

## Release package

The npm package is named `dsh-obsidian-dashboard`. From the repository root, run:

```sh
pnpm --filter dsh-obsidian-dashboard pack
```

The `prepack` script builds the plugin and creates `plugins/obsidian/dsh-obsidian-dashboard-<version>.tgz`. For an npm release, publish this archive with `npm publish plugins/obsidian/dsh-obsidian-dashboard-<version>.tgz` after verifying the package name and version on npm. For a GitHub Release, attach the same archive to the tag corresponding to the package version, then set the plugin directory entry's `tarball` to `https://github.com/Zhizhi-2986/dsh-obsidian-dashboard/releases/download/<tag>/dsh-obsidian-dashboard-<version>.tgz`.

## Development install

Build the package, then add the local plugin path to a DSH Desktop profile using the supported `dsh plugin --profile <profile> add <path>` command. Review the host compatibility audit and sandbox behavior before applying proposals to an external Vault.
