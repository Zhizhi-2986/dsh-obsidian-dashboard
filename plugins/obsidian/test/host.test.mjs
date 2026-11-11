import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { promises as fsPromises } from 'node:fs'
import { KnowledgeService } from '../lib/host/knowledge-service.js'
import { registerKnowledgeTools } from '../src/host/tools.ts'
import { settingsFromConfig } from '../src/host/config.ts'
import { ObsidianConfig, defaults } from '../src/shared/settings-contract.ts'
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, stat as statPath, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNote, digestNote, resolveLinkTarget } from '../src/host/markdown.ts'
import { KnowledgeIndex, toFtsQuery } from '../src/host/indexer.ts'
import { KnowledgeSourceRuntime } from '../src/host/knowledge-source.ts'
import { resolveContainedPath } from '../src/host/source-path.ts'
import { scanSource, fileStemOf, toSourceRel } from '../src/host/scanner.ts'
import { InboxStore } from '../src/host/inbox-store.ts'
import { uniqueSourceId } from '../src/client/source-id.ts'
import { MAX_INBOX_ITEMS } from '../src/shared/rpc-contract.ts'

function textBytes(text) {
  return new TextEncoder().encode(text)
}

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-obsidian-test-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('manual save uses agentless policy and honors the allowed knowledge directory', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), '# Before')
    const canonicalSource = await realpath(sourcePath)
    const policy = { mode: 'workspace-write', workspaceRoot: join(root, 'other-workspace'), additionalWritableRoots: [canonicalSource] }
    let isAllowed = false
    let actualPolicy
    const context = new Context()
    context.sandboxPolicy = { resolve: (request) => { assert.equal(request, undefined); return isAllowed ? policy : { ...policy, additionalWritableRoots: [] } } }
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: 'v1' } },
      async writeText(target, content, intent, signal, writePolicy) {
        assert.equal(intent.kind, 'replaceIfVersion')
        assert.equal(String(intent.version), 'v1')
        actualPolicy = writePolicy
        if (![writePolicy.workspaceRoot, ...writePolicy.additionalWritableRoots].some((rootPath) => target.targetKey.startsWith(`${rootPath}/`))) throw Object.assign(new Error('outside workspace'), { code: 'FS_SANDBOX_DENIED' })
        await writeFile(target.targetKey, content)
        return { version: 'v2' }
      },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const input = { sourceId: 'vault', path: 'note.md', content: '# After', expectedVersion: 'v1', expectedContent: '# Before' }
      const outside = await service.saveDocument(input)
      assert.equal(outside.code, 'SANDBOX_DENIED')
      assert.equal(await readFile(join(sourcePath, 'note.md'), 'utf8'), '# Before')
      isAllowed = true
      const saved = await service.saveDocument(input)
      assert.equal(saved.ok, true)
      assert.equal(actualPolicy, policy)
      assert.equal(await readFile(join(sourcePath, 'note.md'), 'utf8'), '# After')
    } finally {
      await service.shutdown()
    }
  })
})

test('manual save accepts metadata-only version changes but rejects changed note content', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    let currentContent = 'baseline'
    let currentVersion = 'v2'
    let writeIntent
    const policy = { mode: 'workspace-write', workspaceRoot: root, additionalWritableRoots: [] }
    const context = new Context()
    context.sandboxPolicy = { resolve: () => policy }
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: currentVersion, size: Buffer.byteLength(currentContent) } },
      async readBytes() { return textBytes(currentContent) },
      async writeText(_target, content, intent) {
        writeIntent = intent
        currentContent = content
        currentVersion = 'v3'
        return { version: currentVersion }
      },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const saved = await service.saveDocument({ sourceId: 'vault', path: 'note.md', content: 'edited', expectedVersion: 'v1', expectedContent: 'baseline' })
      assert.equal(saved.ok, true)
      assert.equal(String(writeIntent.version), 'v2')

      currentVersion = 'v4'
      currentContent = 'external edit'
      const conflicted = await service.saveDocument({ sourceId: 'vault', path: 'note.md', content: 'my edit', expectedVersion: 'v3', expectedContent: 'edited' })
      assert.equal(conflicted.ok, false)
      if (!conflicted.ok) assert.equal(conflicted.code, 'CONFLICT')
      assert.equal(currentContent, 'external edit')
    } finally {
      await service.shutdown()
    }
  })
})

test('host settings reader unwraps the Volatile values returned by rc.5 Config', () => {
  const parsed = ObsidianConfig['~standard'].validate({ inbox: { keepDraftOnConflict: false } })
  assert.equal('issues' in parsed, false)
  assert.equal(typeof parsed.value.knowledgeSources.get, 'function')
  const settings = settingsFromConfig(parsed.value)
  assert.equal('inbox' in settings, false, 'obsolete keep-draft setting is not consumed by the Host')
  assert.deepEqual(settings, defaults())
})

test('existing plugin data directories and sensitive files are made private', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (root) => {
    const dataDir = join(root, 'plugin-data')
    const sourceFile = join(dataDir, 'sources.json')
    const inboxFile = join(dataDir, 'inbox.json')
    await mkdir(dataDir, { recursive: true, mode: 0o777 })
    await chmod(dataDir, 0o777)
    await writeFile(sourceFile, '[]')
    await writeFile(inboxFile, '[]')
    await chmod(sourceFile, 0o666)
    await chmod(inboxFile, 0o666)
    const service = new KnowledgeService(new Context(), defaults(), dataDir)
    try {
      await service.listSources()
      await service.listInboxItems()
    } finally {
      await service.shutdown()
    }
    assert.equal((await statPath(dataDir)).mode & 0o777, 0o700)
    for (const file of [sourceFile, inboxFile, join(dataDir, 'knowledge.db')]) {
      assert.equal((await statPath(file)).mode & 0o777, 0o600, `${file} should be private`)
    }
    for (const suffix of ['-wal', '-shm']) {
      try {
        assert.equal((await statPath(`${join(dataDir, 'knowledge.db')}${suffix}`)).mode & 0o777, 0o600)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  })
})

test('a symlinked plugin data directory is rejected without changing its target permissions', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (root) => {
    const realDataDir = join(root, 'real-data')
    const dataDir = join(root, 'plugin-data')
    await mkdir(realDataDir, { mode: 0o777 })
    await chmod(realDataDir, 0o777)
    await symlink(realDataDir, dataDir)
    await assert.rejects(new InboxStore(dataDir).list(), { code: 'FS_INVALID_STORAGE_DIRECTORY' })
    assert.equal((await statPath(realDataDir)).mode & 0o777, 0o777)

    const absentTarget = join(root, 'must-not-be-created')
    const missingLink = join(root, 'missing-plugin-data')
    await symlink(absentTarget, missingLink)
    await assert.rejects(new InboxStore(missingLink).list(), { code: 'FS_INVALID_STORAGE_DIRECTORY' })
    await assert.rejects(statPath(absentTarget), { code: 'ENOENT' })
  })
})

test('legacy configured sources acquire a persisted root identity during startup migration', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'legacy-vault')
    const dataDir = join(root, 'plugin-data')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), '# Legacy')
    const service = new KnowledgeService(new Context(), {
      ...defaults(), knowledgeSources: [{ id: 'legacy', name: 'Legacy', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, dataDir)
    try {
      const listed = await service.listSources()
      assert.equal(listed.ok, true)
      const saved = JSON.parse(await readFile(join(dataDir, 'sources.json'), 'utf8'))
      const actual = await statPath(await realpath(sourcePath))
      assert.equal(saved[0].rootIdentity.dev, String(actual.dev))
      assert.equal(saved[0].rootIdentity.ino, String(actual.ino))
    } finally {
      await service.shutdown()
    }
  })
})

test('service restart reloads sources, persisted Inbox drafts, and reindexes changed Markdown', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const dataDir = join(root, 'plugin-data')
    const notePath = join(sourcePath, 'note.md')
    await mkdir(sourcePath)
    await writeFile(notePath, '# Before restart')
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return undefined },
    }
    const first = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, dataDir)
    const draft = { kind: 'create', title: 'Persisted proposal', sourceId: 'vault', targetPath: 'new.md', body: '# Persisted' }
    try {
      assert.equal((await first.indexSource('vault')).ok, true)
      const proposed = await first.propose('vault', draft)
      assert.equal(proposed.ok, true)
    } finally {
      await first.shutdown()
    }

    await writeFile(notePath, '# After restart\n\nRestartFreshMarker')
    const second = new KnowledgeService(new Context(), defaults(), dataDir)
    try {
      const sources = await second.listSources()
      assert.equal(sources.ok, true)
      if (sources.ok) assert.equal(sources.sources[0].id, 'vault')
      let indexed = false
      let lastSearch
      for (let attempt = 0; attempt < 80; attempt += 1) {
        lastSearch = await second.searchSources('RestartFreshMarker', { sourceId: 'vault', field: 'all', limit: 5 })
        if (lastSearch.ok && lastSearch.hits.length > 0) { indexed = true; break }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.equal(indexed, true, JSON.stringify(lastSearch))
      const inbox = await second.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.deepEqual(inbox.items.map(({ title, status, revision }) => ({ title, status, revision })), [
        { title: 'Persisted proposal', status: 'pending', revision: 1 },
      ])
    } finally {
      await second.shutdown()
    }
  })
})

test('knowledge-page source management persists a source and rejects duplicate paths', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const sourceFile = join(sourcePath, 'keep.md')
    const dataDir = join(root, 'plugin-data')
    await mkdir(sourcePath)
    await writeFile(sourceFile, 'keep source file')
    const ctx = new Context()
    const service = new KnowledgeService(ctx, defaults(), dataDir)
    const remoteView = ctx.extend({ invocation: { namespace: 'knowledge', method: 'addSource' } }).get('knowledge')
    try {
      const cancelled = new AbortController()
      cancelled.abort()
      await assert.rejects(remoteView.addSource({ name: 'Cancelled', path: sourcePath, kind: 'folder' }, cancelled.signal), { name: 'AbortError' })

      const added = await remoteView.addSource({ name: 'Obsidian Vault', path: sourcePath, kind: 'folder' })
      assert.equal(added.ok, true)
      if (!added.ok) return
      assert.equal(added.source.name, 'Obsidian Vault')
      const storedSources = JSON.parse(await readFile(join(dataDir, 'sources.json'), 'utf8'))
      assert.equal(typeof storedSources[0].rootIdentity.dev, 'string')
      assert.equal(typeof storedSources[0].rootIdentity.ino, 'string')

      const duplicate = await remoteView.addSource({ name: 'Second name', path: sourcePath, kind: 'folder' })
      assert.equal(duplicate.ok, false)
      if (!duplicate.ok) assert.equal(duplicate.code, 'ALREADY_EXISTS')

      const sources = await remoteView.listSources()
      assert.equal(sources.ok, true)
      if (sources.ok) assert.deepEqual(sources.sources.map(({ id, name }) => ({ id, name })), [{ id: added.source.id, name: 'Obsidian Vault' }])
    } finally {
      await service.shutdown()
    }

    const reloadedContext = new Context()
    const reloaded = new KnowledgeService(reloadedContext, defaults(), dataDir)
    const reloadedRemoteView = reloadedContext.extend({ invocation: { namespace: 'knowledge', method: 'listSources' } }).get('knowledge')
    try {
      const sources = await reloadedRemoteView.listSources()
      assert.equal(sources.ok, true)
      if (sources.ok) assert.equal(sources.sources[0]?.name, 'Obsidian Vault')
      if (sources.ok && sources.sources[0]) {
        const removed = await reloadedRemoteView.removeSource(sources.sources[0].id)
        assert.equal(removed.ok, true)
        const afterRemove = await reloadedRemoteView.listSources()
        assert.equal(afterRemove.ok, true)
        if (afterRemove.ok) assert.deepEqual(afterRemove.sources, [])
      }
      assert.equal(await readFile(sourceFile, 'utf8'), 'keep source file', 'removing a source must not delete disk files')
    } finally {
      await reloaded.shutdown()
    }
  })
})

test('source-store failure during add returns IO and leaves sources unchanged', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const dataDir = join(root, 'plugin-data')
    const sourceStoreFile = join(dataDir, 'sources.json')
    await mkdir(sourcePath)
    const service = new KnowledgeService(new Context(), defaults(), dataDir)
    const originalRename = fsPromises.rename
    try {
      await service.listSources()
      fsPromises.rename = async function (from, to) {
        if (to === sourceStoreFile) throw Object.assign(new Error('EACCES: injected source-store failure'), { code: 'EACCES' })
        return originalRename.call(this, from, to)
      }
      const added = await service.addKnowledgeSource({ name: 'Vault', path: sourcePath, kind: 'folder' })
      assert.equal(added.ok, false)
      if (!added.ok) assert.equal(added.code, 'PERMISSION_DENIED')
      assert.deepEqual(service.listSourceInfos(), [])
      assert.deepEqual(JSON.parse(await readFile(sourceStoreFile, 'utf8')), [])
    } finally {
      fsPromises.rename = originalRename
      await service.shutdown()
    }
  })
})

test('proposal creation and source removal serialize; removal conflicts retained pending drafts', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    let finishRead
    let markReadStarted
    const readStarted = new Promise((resolve) => { markReadStarted = resolve })
    const delayedRead = new Promise((resolve) => { finishRead = resolve })
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: 'v1', size: 8 } },
      async readBytes() { markReadStarted(); return await delayedRead },
      async readText() { return 'baseline' },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const creating = service.propose('vault', { kind: 'update', title: 'Update', sourceId: 'vault', targetPath: 'note.md', body: 'proposal' })
      await readStarted
      const removing = service.removeKnowledgeSource('vault')
      finishRead(textBytes('baseline'))
      const created = await creating
      const removed = await removing
      assert.equal(created.ok, true)
      assert.equal(removed.ok, true)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) {
        assert.equal(inbox.items[0].status, 'conflicted')
        assert.match(inbox.items[0].conflictMessage, /source was removed/)
      }
      assert.deepEqual(service.listSourceInfos(), [])
    } finally {
      finishRead?.(textBytes('baseline'))
      await service.shutdown()
    }
  })
})

test('source-store failure during removal leaves the configured source and drafts unchanged', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const dataDir = join(root, 'plugin-data')
    await mkdir(sourcePath)
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return undefined },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, dataDir)
    const sourceStoreFile = join(dataDir, 'sources.json')
    const originalRename = fsPromises.rename
    try {
      await service.listSources()
      const proposal = await service.propose('vault', { kind: 'create', title: 'Keep draft', sourceId: 'vault', targetPath: 'new.md', body: '# Draft' })
      assert.equal(proposal.ok, true)
      fsPromises.rename = async function (from, to) {
        if (to === sourceStoreFile) throw Object.assign(new Error('injected source-store rename failure'), { code: 'EACCES' })
        return originalRename.call(this, from, to)
      }

      const removed = await service.removeKnowledgeSource('vault')
      assert.equal(removed.ok, false)
      const sources = await service.listSources()
      assert.equal(sources.ok, true)
      if (sources.ok) assert.equal(sources.sources.length, 1)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.equal(inbox.items[0]?.status, 'pending')
    } finally {
      fsPromises.rename = originalRename
      await service.shutdown()
    }
  })
})

test('a failed later Inbox conflict write restores earlier drafts before aborting source removal', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const dataDir = join(root, 'plugin-data')
    await mkdir(sourcePath)
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return undefined },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, dataDir)
    const inboxFile = join(dataDir, 'inbox.json')
    const originalRename = fsPromises.rename
    let conflictWrites = 0
    try {
      await service.listSources()
      await service.propose('vault', { kind: 'create', title: 'First', sourceId: 'vault', targetPath: 'first.md', body: '# First' })
      await service.propose('vault', { kind: 'create', title: 'Second', sourceId: 'vault', targetPath: 'second.md', body: '# Second' })
      fsPromises.rename = async function (from, to) {
        if (to === inboxFile) {
          conflictWrites += 1
          if (conflictWrites === 2) throw Object.assign(new Error('injected inbox rename failure'), { code: 'EACCES' })
        }
        return originalRename.call(this, from, to)
      }
      const removed = await service.removeKnowledgeSource('vault')
      assert.equal(removed.ok, false)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.deepEqual(inbox.items.map((entry) => entry.status), ['pending', 'pending'])
      assert.equal(service.listSourceInfos().length, 1)
    } finally {
      fsPromises.rename = originalRename
      await service.shutdown()
    }
  })
})

test('knowledge-page source management rejects invalid or missing folders', async () => {
  await withTempDir(async (root) => {
    const dataDir = join(root, 'plugin-data')
    const regularFile = join(root, 'note.md')
    await writeFile(regularFile, '# note')
    const service = new KnowledgeService(new Context(), defaults(), dataDir)
    try {
      const relative = await service.addSource({ name: 'Relative', path: 'vault', kind: 'folder' })
      assert.equal(relative.ok, false)
      if (!relative.ok) assert.equal(relative.code, 'INVALID')

      const file = await service.addSource({ name: 'Not a folder', path: regularFile, kind: 'folder' })
      assert.equal(file.ok, false)
      if (!file.ok) assert.equal(file.code, 'INVALID')

      const missing = await service.addSource({ name: 'Missing', path: join(root, 'missing'), kind: 'folder' })
      assert.equal(missing.ok, false)
      if (!missing.ok) assert.equal(missing.code, 'NOT_FOUND')
    } finally {
      await service.shutdown()
    }
  })
})

test('markdown parser extracts frontmatter, headings, wikilinks, tags, and plain text', () => {
  const note = parseNote(`---\ntitle: "Frontmatter title"\ntags: [one, two]\n---\n# Heading title\nBody with [[Other note|alias]] and #knowledge.\n\`\`\`\n#ignored [[ignored]]\n\`\`\``)
  assert.equal(note.frontmatter.values.get('title'), 'Frontmatter title')
  assert.deepEqual(note.headings, ['Heading title'])
  assert.deepEqual(note.links, [{ raw: 'Other note|alias', target: 'Other note', alias: 'alias' }])
  assert.deepEqual(note.tags, ['knowledge'])
  assert.match(note.text, /Body with.*and/)
  assert.equal(note.text.slice(0, note.text.indexOf('Body with')).split('\n').length, 6)
  assert.equal(note.links.some((link) => link.target === 'ignored'), false)
})

test('markdown digest prefers first heading and resolves wikilink targets safely', () => {
  const digest = digestNote('---\ntitle: Frontmatter\n---\n# Heading\nText', 'fallback')
  assert.equal(digest.title, 'Heading')
  const known = new Set(['folder/note.md', 'literal'])
  assert.equal(resolveLinkTarget('folder/note#section', known), 'folder/note.md')
  assert.equal(resolveLinkTarget('literal', known), 'literal')
  assert.equal(resolveLinkTarget('https://example.com', known), null)
  assert.equal(resolveLinkTarget('../outside', known), null)
})

test('FTS query quotes terms and strips FTS punctuation', () => {
  assert.equal(toFtsQuery('alpha beta'), '"alpha" OR "beta"')
  assert.equal(toFtsQuery('"foo"* (bar)'), '"foo" OR "bar"')
  assert.equal(toFtsQuery('  ***  '), '')
})

test('SQLite index initializes a fresh plugin data directory', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'plugins', 'dsh-obsidian', 'knowledge.db')
    const index = KnowledgeIndex.open(file)
    try {
      index.upsertDoc('vault', 'note.md', 'Note', [], 'content', 1)
      assert.equal(index.countDocs('vault'), 1)
    } finally {
      index.close()
    }
  })
})

test('SQLite index round-trips docs, searches with highlights, tracks links, and deletes', () => {
  const index = KnowledgeIndex.open(':memory:')
  try {
    index.upsertDoc('vault', 'a.md', 'Alpha note', ['topic'], 'First line.\nA careful searchable sentence.', 123)
    index.upsertDoc('vault', 'b.md', 'Beta note', [], 'Another sentence linking nowhere.', 456)
    assert.equal(index.countDocs('vault'), 2)
    assert.deepEqual(index.getDoc('vault', 'a.md'), {
      sourceId: 'vault', relPath: 'a.md', title: 'Alpha note', tags: ['topic'], mtimeMs: 123,
    })
    assert.deepEqual(index.knownPaths('vault'), new Set(['a.md', 'b.md']))
    assert.equal(index.search('vault', 'title', 'searchable', 10).length, 0)
    assert.equal(index.search('vault', 'title', 'Alpha', 10).length, 1)
    index.setLinks('vault', 'a.md', [{ raw: 'remote-target', target: 'remote-target', alias: null }], new Set())
    assert.equal(index.search('vault', 'links', 'remote-target', 10)[0].path, 'a.md')
    const hits = index.search('vault', 'body', 'searchable', 10)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].path, 'a.md')
    assert.equal(hits[0].line, 2)
    const sourceMarkdown = parseNote('---\ntitle: Example\n---\n# Example\nFirst line\nneedle').text
    index.upsertDoc('vault', 'frontmatter.md', 'Example', [], sourceMarkdown, 789)
    assert.equal(index.search('vault', 'body', 'needle', 10)[0].line, 6)
    assert.match(hits[0].snippet, /⟦searchable⟧/)
    index.setLinks('vault', 'a.md', [{ raw: 'b', target: 'b', alias: null }], new Set(['b.md']))
    assert.equal(index.backLinks('vault', 'b.md')[0].resolvedPath, 'a.md')
    assert.equal(index.outLinks('vault', 'a.md')[0].resolvedPath, 'b.md')
    index.deleteDoc('vault', 'a.md')
    assert.equal(index.getDoc('vault', 'a.md'), null)
    assert.equal(index.search('vault', 'body', 'searchable', 10).length, 0)
  } finally {
    index.close()
  }
})

test('SQLite index lists immediate folders and notes for directory browsing', () => {
  const index = KnowledgeIndex.open(':memory:')
  try {
    index.upsertDoc('vault', 'root.md', 'Root note', [], 'root', 1)
    index.upsertDoc('vault', 'notes/a.md', 'A note', ['a'], 'a', 2)
    index.upsertDoc('vault', 'notes/nested/b.md', 'B note', [], 'b', 3)
    assert.deepEqual(index.listDirectory('vault', ''), {
      directories: ['notes'],
      documents: [{ sourceId: 'vault', path: 'root.md', title: 'Root note', tags: [], updatedAt: 1 }],
    })
    assert.deepEqual(index.listDirectory('vault', 'notes'), {
      directories: ['nested'],
      documents: [{ sourceId: 'vault', path: 'notes/a.md', title: 'A note', tags: ['a'], updatedAt: 2 }],
    })
  } finally {
    index.close()
  }
})

test('watch change events refresh links after edits and target creation', async () => {
  await withTempDir(async (root) => {
    const sourceDir = join(root, 'source')
    await mkdir(sourceDir)
    await writeFile(join(sourceDir, 'a.md'), 'See [[B]].')
    await writeFile(join(sourceDir, 'B.md'), '# B')
    const index = KnowledgeIndex.open(':memory:')
    const watcherHandlers = new Map()
    const watcher = {
      on(event, handler) { watcherHandlers.set(event, handler); return this },
      emit(event, ...args) { watcherHandlers.get(event)?.(...args) },
      close() {},
    }
    const runtime = new KnowledgeSourceRuntime({
      id: 'vault', name: 'Vault', path: sourceDir, kind: 'vault', include: [], exclude: [],
    }, index, () => watcher)
    try {
      await runtime.sync()
      assert.equal(index.backLinks('vault', 'B.md').length, 1)
      runtime.startWatch()
      const editedNote = join(sourceDir, 'a.md')
      await writeFile(editedNote, 'See [[C]].')
      const now = new Date()
      await utimes(editedNote, now, new Date(now.getTime() + 2_000))
      watcher.emit('change', 'change', 'a.md')
      assert.equal(await waitFor(() => index.backLinks('vault', 'B.md').length === 0), true)
      await writeFile(join(sourceDir, 'C.md'), '# C')
      watcher.emit('change', 'rename', 'C.md')
      assert.equal(await waitFor(() => index.outLinks('vault', 'a.md')[0]?.resolvedPath === 'C.md'), true)
    } finally {
      await runtime.stop()
      index.close()
    }
  })
})

test('directory watcher events full-sync newly created and removed subtrees', async () => {
  await withTempDir(async (root) => {
    const sourceDir = join(root, 'source')
    await mkdir(sourceDir)
    await writeFile(join(sourceDir, 'root.md'), '# Root')
    const index = KnowledgeIndex.open(':memory:')
    const handlers = new Map()
    const watcher = {
      on(event, handler) { handlers.set(event, handler); return this },
      emit(event, ...args) { handlers.get(event)?.(...args) },
      close() {},
    }
    const runtime = new KnowledgeSourceRuntime({ id: 'vault', name: 'Vault', path: sourceDir, kind: 'folder', include: [], exclude: [] }, index, () => watcher)
    try {
      await runtime.sync()
      runtime.startWatch()
      const subtree = join(sourceDir, 'nested')
      await mkdir(subtree)
      await writeFile(join(subtree, 'child.md'), '# Child')
      watcher.emit('change', 'rename', 'nested')
      assert.equal(await waitFor(() => index.getDoc('vault', 'nested/child.md') !== null, 2_000), true)
      await rm(subtree, { recursive: true, force: true })
      watcher.emit('change', 'rename', 'nested')
      assert.equal(await waitFor(() => index.getDoc('vault', 'nested/child.md') === null, 2_000), true)
      assert.equal(runtime.state.lastError, null)
    } finally {
      await runtime.stop()
      index.close()
    }
  })
})

const WATCHER_TEST_TIMEOUT_MS = 2_000

async function waitFor(predicate, timeoutMs = WATCHER_TEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

test('failed full scans preserve the previous index and expose lastError', async () => {
  await withTempDir(async (root) => {
    const sourceDir = join(root, 'source')
    await mkdir(sourceDir)
    await writeFile(join(sourceDir, 'keep.md'), '# Keep')
    const index = KnowledgeIndex.open(':memory:')
    const runtime = new KnowledgeSourceRuntime({
      id: 'vault', name: 'Vault', path: sourceDir, kind: 'vault', include: [], exclude: [],
    }, index)
    try {
      await runtime.sync()
      assert.equal(index.countDocs('vault'), 1)
      await rm(sourceDir, { recursive: true, force: true })
      await assert.rejects(runtime.sync())
      assert.equal(index.countDocs('vault'), 1)
      assert.notEqual(runtime.state.lastError, null)
    } finally {
      await runtime.stop()
      index.close()
    }
  })
})

test('source path resolution rejects traversal and symlinks escaping the configured root', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'source')
    const outside = join(dir, 'outside.md')
    await mkdir(root)
    await writeFile(join(root, 'inside.md'), 'inside')
    await writeFile(outside, 'outside')
    await (await import('node:fs/promises')).symlink(outside, join(root, 'link.md'))
    assert.equal(await resolveContainedPath(root, 'inside.md'), await realpath(join(root, 'inside.md')))
    assert.equal(await resolveContainedPath(root, 'new.md'), join(await realpath(root), 'new.md'))
    assert.equal(await resolveContainedPath(root, '../outside.md'), null)
    assert.equal(await resolveContainedPath(root, 'link.md'), null)
  })
})

test('permission errors from source path resolution remain PERMISSION_DENIED', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'locked-vault')
    const dataDir = join(root, 'plugin-data')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'private')
    await chmod(sourcePath, 0)
    const service = new KnowledgeService(new Context(), {
      ...defaults(), knowledgeSources: [{ id: 'locked', name: 'Locked', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, dataDir)
    try {
      const result = await service.readSource('locked', 'note.md')
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'PERMISSION_DENIED')
    } finally {
      await service.shutdown()
      await chmod(sourcePath, 0o700)
    }
  })
})

test('manual reindex recreates a source runtime after its root path is restored', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const parkedPath = join(root, 'vault-parked')
    const dataDir = join(root, 'plugin-data')
    await mkdir(sourcePath)
    const canonicalSourcePath = await realpath(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), '# Recoverable note')
    const identity = await statPath(sourcePath)
    const source = {
      id: 'vault', name: 'Vault', path: canonicalSourcePath, kind: 'folder', include: [], exclude: [],
      rootIdentity: { dev: String(identity.dev), ino: String(identity.ino) },
    }
    await rename(sourcePath, parkedPath)
    const service = new KnowledgeService(new Context(), { ...defaults(), knowledgeSources: [source] }, dataDir)
    try {
      const unavailable = await service.listSources()
      assert.equal(unavailable.ok, true)
      if (unavailable.ok) assert.ok(unavailable.sources[0]?.lastError)
      await rename(parkedPath, sourcePath)
      const indexed = await service.indexSource('vault')
      assert.equal(indexed.ok, true)
      if (indexed.ok) assert.equal(indexed.source.fileCount, 1)
    } finally {
      await service.shutdown()
    }
  })
})

test('a configured source root cannot be rebound to a replacement symlink', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const movedPath = join(root, 'vault-original')
    const replacementPath = join(root, 'replacement')
    await mkdir(sourcePath)
    await mkdir(replacementPath)
    await writeFile(join(sourcePath, 'note.md'), '# Original')
    await writeFile(join(replacementPath, 'note.md'), '# Replacement secret')
    const rootStat = await statPath(sourcePath)
    const service = new KnowledgeService(new Context(), {
      ...defaults(), knowledgeSources: [{
        id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [],
        rootIdentity: { dev: String(rootStat.dev), ino: String(rootStat.ino) },
      }],
    }, join(root, 'plugin-data'))
    try {
      await service.listSources()
      await rename(sourcePath, movedPath)
      await symlink(replacementPath, sourcePath)
      const read = await service.readSource('vault', 'note.md')
      assert.equal(read.ok, false)
      if (!read.ok) assert.equal(read.code, 'OUTSIDE_SOURCE')
      const proposal = await service.propose('vault', {
        kind: 'append', title: 'Unsafe append', sourceId: 'vault', targetPath: 'note.md', body: 'do not append',
      })
      assert.equal(proposal.ok, false)
      if (!proposal.ok) assert.equal(proposal.code, 'OUTSIDE_SOURCE')
    } finally {
      await service.shutdown()
    }
  })
})

test('index sync preserves an indexed note and exposes permission failures instead of deleting it', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const notePath = join(sourcePath, 'note.md')
    await mkdir(sourcePath)
    await writeFile(notePath, '# Indexed before permission change')
    const index = KnowledgeIndex.open(join(root, 'index.sqlite'))
    const runtime = new KnowledgeSourceRuntime({ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }, index)
    try {
      await runtime.sync()
      assert.ok(index.getDoc('vault', 'note.md'))
      const changedTime = new Date(Date.now() + 2000)
      await chmod(notePath, 0)
      await utimes(notePath, changedTime, changedTime)
      await assert.rejects(runtime.sync(), (error) => error.code === 'EACCES' || error.code === 'EPERM')
      assert.ok(index.getDoc('vault', 'note.md'), 'permission failure must not delete previously indexed content')
      assert.match(runtime.state.lastError ?? '', /permission|EACCES|EPERM/i)
    } finally {
      await chmod(notePath, 0o600)
      await runtime.stop()
    }
  })
})

test('scanner respects include/exclude patterns and always skips hidden and generated directories', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'notes'), { recursive: true })
    await mkdir(join(root, 'archive'), { recursive: true })
    await mkdir(join(root, '.obsidian'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'notes', 'keep.md'), '# keep')
    await writeFile(join(root, 'notes', 'skip.txt'), 'skip')
    await writeFile(join(root, 'archive', 'old.md'), '# old')
    await writeFile(join(root, '.obsidian', 'internal.md'), '# internal')
    await writeFile(join(root, 'node_modules', 'pkg', 'readme.md'), '# generated')

    const files = await scanSource(root, { include: ['notes'], exclude: ['notes/skip.txt'] })
    assert.deepEqual(files.map((file) => file.relPath), ['notes/keep.md'])
    assert.equal(fileStemOf('notes/keep.md'), 'keep')
    assert.equal(toSourceRel(root, join(root, 'notes', 'keep.md')), 'notes/keep.md')
    assert.equal(toSourceRel(root, join(root, '..', 'escape.md')), null)
  })
})

test('source ids are unique even when names normalize to the same slug', () => {
  assert.equal(uniqueSourceId('Research Notes', ['research-notes']), 'research-notes-2')
  assert.equal(uniqueSourceId('研究', ['研究']), '研究-2')
  assert.equal(uniqueSourceId('---', ['source']), 'source-2')
})

test('readSource rejects oversized files before allocating their contents', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'large.md'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61))
    const service = new KnowledgeService(new Context(), {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const result = await service.readSource('vault', 'large.md')
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'TOO_LARGE')
    } finally {
      await service.shutdown()
    }
  })
})

test('reads source documents for the Knowledge preview without a DSH fs service', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), '# Knowledge preview\nBody text')
    const config = {
      ...defaults(),
      knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }
    const service = new KnowledgeService(new Context(), config, join(root, 'plugin-data'))
    try {
      const document = await service.readSource('vault', 'note.md')
      assert.equal(document.ok, true)
      if (document.ok) assert.equal(document.content, '# Knowledge preview\nBody text')
    } finally {
      await service.shutdown()
    }
  })
})

test('agent tools register schemas compiled by the DSH tool factory', () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        assertSupportedJsonSchema(definition.output.schema)
        registered.push(definition)
      },
    },
  }
  assert.doesNotThrow(() => registerKnowledgeTools(ctx, {}))
  assert.deepEqual(registered.map((tool) => tool.name), ['knowledge_search', 'knowledge_read', 'knowledge_propose'])
  for (const tool of registered) {
    assert.equal(tool.parameters.type, 'object')
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters))
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema))
  }
  const proposal = registered.find(({ name }) => name === 'knowledge_propose')
  assert.deepEqual(proposal.parameters.required, ['kind', 'title', 'sourceId', 'targetPath', 'body'])
  assert.deepEqual(proposal.parameters.properties.kind.enum, ['create', 'append', 'update'])
})

test('knowledge_propose creates only a pending proposal and never writes the source', async () => {
  const calls = []
  const service = {
    async propose(sourceId, input) {
      calls.push({ sourceId, input })
      return {
        ok: true,
        item: { id: 'proposal-1', title: input.title, kind: input.kind, sourceId, targetPath: input.targetPath, status: 'pending' },
      }
    },
  }
  const registered = []
  registerKnowledgeTools({ tools: { register: (definition) => registered.push(definition) } }, service)
  const tool = registered.find(({ name }) => name === 'knowledge_propose')
  assert.ok(tool, 'knowledge_propose is registered')
  const draft = {
    kind: 'create', title: 'Indexing notes', sourceId: 'vault', targetPath: 'notes/indexing.md', body: '# Indexing notes\\nDraft body',
  }

  const result = await tool.execute(draft)

  assert.deepEqual(calls, [{ sourceId: 'vault', input: draft }])
  assert.deepEqual(result, {
    ok: true, itemId: 'proposal-1', title: 'Indexing notes', kind: 'create',
    sourceId: 'vault', targetPath: 'notes/indexing.md', status: 'pending',
  })
  assert.equal('body' in result, false)
})

test('knowledge_propose records the invoking Agent ID in the persisted Inbox item', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: 'v1', size: 8 } },
      async readBytes() { return textBytes('baseline') },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    const registered = []
    registerKnowledgeTools({ tools: { register: (definition) => registered.push(definition) } }, service)
    const tool = registered.find(({ name }) => name === 'knowledge_propose')
    try {
      const result = await tool.execute({
        kind: 'append', title: 'From Agent', sourceId: 'vault', targetPath: 'note.md', body: 'agent draft',
      }, { agent: { id: 'writer-agent' } })
      assert.equal(result.ok, true)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.equal(inbox.items[0].agentId, 'writer-agent')
      const cancelled = new AbortController()
      cancelled.abort()
      await assert.rejects(tool.execute({
        kind: 'append', title: 'Cancelled draft', sourceId: 'vault', targetPath: 'note.md', body: 'must not persist',
      }, { agent: { id: 'writer-agent' }, signal: cancelled.signal }), { name: 'AbortError' })
      const afterCancellation = await service.listInboxItems()
      assert.equal(afterCancellation.ok, true)
      if (afterCancellation.ok) assert.equal(afterCancellation.items.length, 1)
    } finally {
      await service.shutdown()
    }
  })
})

test('knowledge_propose returns service validation failures without claiming a draft was created', async () => {
  const registered = []
  const service = { async propose() { return { ok: false, code: 'OUTSIDE_SOURCE', message: 'target resolves outside the configured source' } } }
  registerKnowledgeTools({ tools: { register: (definition) => registered.push(definition) } }, service)
  const tool = registered.find(({ name }) => name === 'knowledge_propose')
  assert.ok(tool, 'knowledge_propose is registered')

  const result = await tool.execute({
    kind: 'create', title: 'Unsafe', sourceId: 'vault', targetPath: '../outside.md', body: 'No write',
  })

  assert.deepEqual(result, { ok: false, code: 'OUTSIDE_SOURCE', message: 'target resolves outside the configured source' })
})

test('knowledge_propose uses the real service to enforce source containment before inboxing a draft', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const dataDir = join(root, 'plugin-data')
    await mkdir(join(sourcePath, 'notes'), { recursive: true })
    const outsidePath = join(root, 'outside.md')
    await writeFile(outsidePath, 'outside source')
    await symlink(outsidePath, join(sourcePath, 'linked.md'))

    const resolvedPaths = []
    let writeCalls = 0
    const context = new Context()
    context.fs = {
      async resolve(targetPath) {
        resolvedPaths.push(targetPath)
        return { path: targetPath, targetKey: targetPath }
      },
      contains() { return true },
      async stat() { return undefined },
      async writeText() { writeCalls += 1; throw new Error('propose must not write') },
    }
    const service = new KnowledgeService(context, {
      ...defaults(),
      knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, dataDir)
    const registered = []
    registerKnowledgeTools({ tools: { register: (definition) => registered.push(definition) } }, service)
    const tool = registered.find(({ name }) => name === 'knowledge_propose')
    assert.ok(tool, 'knowledge_propose is registered')

    try {
      const accepted = await tool.execute({
        kind: 'create', title: 'Safe draft', sourceId: 'vault', targetPath: 'notes/safe.md', body: '# safe',
      })
      assert.equal(accepted.ok, true)
      if (accepted.ok) assert.equal(accepted.status, 'pending')

      const rejected = await tool.execute({
        kind: 'create', title: 'Escaping link', sourceId: 'vault', targetPath: 'linked.md', body: '# unsafe',
      })
      assert.deepEqual(rejected, { ok: false, code: 'OUTSIDE_SOURCE', message: 'target resolves outside the configured source' })

      const unknownSource = await tool.execute({
        kind: 'create', title: 'Unknown source', sourceId: 'missing', targetPath: 'notes/no.md', body: '# no',
      })
      assert.deepEqual(unknownSource, { ok: false, code: 'NOT_FOUND', message: 'unknown knowledge source' })

      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.deepEqual(inbox.items.map(({ title, targetPath, status }) => ({ title, targetPath, status })), [
        { title: 'Safe draft', targetPath: 'notes/safe.md', status: 'pending' },
      ])
      assert.deepEqual(resolvedPaths, [await realpath(sourcePath), join(await realpath(sourcePath), 'notes', 'safe.md')], 'only the source root and contained target reach DSH fs.resolve')
      assert.equal(writeCalls, 0)
    } finally {
      await service.shutdown()
    }
  })
})

test('knowledge_propose rejects malformed arguments before calling the service', async () => {
  let called = false
  const registered = []
  const service = { async propose() { called = true; return { ok: true, item: { id: 'unexpected' } } } }
  registerKnowledgeTools({ tools: { register: (definition) => registered.push(definition) } }, service)
  const tool = registered.find(({ name }) => name === 'knowledge_propose')
  assert.ok(tool, 'knowledge_propose is registered')

  const result = await tool.execute({
    kind: 'create', title: '', sourceId: 'vault', targetPath: 'notes/foo.md', body: 'draft', extra: 'ignored?',
  })

  assert.equal(called, false)
  assert.deepEqual(result, { ok: false, code: 'INVALID', message: 'invalid proposal input' })
})

test('Inbox refuses a symlinked storage file instead of chmodding or reading its target', async () => {
  await withTempDir(async (dir) => {
    const external = join(dir, 'external.json')
    const dataDir = join(dir, 'plugin-data')
    await mkdir(dataDir)
    await writeFile(external, '[]')
    await symlink(external, join(dataDir, 'inbox.json'))
    await assert.rejects(new InboxStore(dataDir).list(), { code: 'FS_INVALID_STORAGE_FILE' })
  })
})

test('inbox persists drafts, updates state, and trims resolved items before pending items', async () => {
  await withTempDir(async (dir) => {
    const inbox = new InboxStore(dir)
    const input = (n) => ({
      sourceId: 'vault', kind: 'create', title: `Proposal ${n}`, targetPath: `notes/${n}.md`, body: `# ${n}`,
    })
    const first = await inbox.add(input(0))
    assert.equal((await inbox.list())[0].id, first.id)
    assert.equal((await inbox.update(first.id, { status: 'dismissed' })).status, 'dismissed')
    assert.equal(await inbox.update('missing', { status: 'applied' }), null)

    for (let i = 1; i < MAX_INBOX_ITEMS + 1; i += 1) await inbox.add(input(i))
    const items = await inbox.list()
    assert.equal(items.length, MAX_INBOX_ITEMS)
    assert.equal(items.some((item) => item.id === first.id), false)
    assert.equal(items.at(-1).title, `Proposal ${MAX_INBOX_ITEMS}`)
  })
})

test('inbox refuses to discard pending proposals when its item cap is full', async () => {
  await withTempDir(async (dir) => {
    const legacy = Array.from({ length: MAX_INBOX_ITEMS }, (_, index) => ({
      id: `pending-${index}`, createdAt: index, kind: 'create', title: `Pending ${index}`, sourceId: 'vault', targetPath: `${index}.md`,
      body: 'draft', baselineContent: '', status: 'pending', baseVersion: null, conflictMessage: null,
    }))
    await writeFile(join(dir, 'inbox.json'), JSON.stringify(legacy))
    const inbox = new InboxStore(dir)
    const added = await inbox.add({ kind: 'create', title: 'Extra', sourceId: 'vault', targetPath: 'extra.md', body: 'extra' })
    assert.equal(added, null)
    const items = await inbox.list()
    assert.equal(items.length, MAX_INBOX_ITEMS)
    assert.equal(items[0].id, 'pending-0')
  })
})

test('Inbox update enforces serialized-size cap without replacing the last valid draft', async () => {
  await withTempDir(async (dir) => {
    const inbox = new InboxStore(dir, { maxStorageBytes: 8_000_000 })
    const input = { kind: 'append', title: 'Bounded', sourceId: 'vault', targetPath: 'note.md', body: 'small' }
    const created = await inbox.add(input, 'x'.repeat(4_100_000))
    assert.ok(created)
    await assert.rejects(inbox.update(created.id, { body: 'y'.repeat(4_100_000) }), { code: 'INBOX_TOO_LARGE' })
    const current = await inbox.list()
    assert.equal(current[0].body, 'small')
  })
})

test('legacy Inbox above the new proposal budget remains readable and updateable', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'inbox.json')
    const legacy = Array.from({ length: 42 }, (_, index) => ({
      id: `legacy-${index}`, createdAt: index, kind: 'create', title: `Legacy ${index}`, sourceId: 'vault', targetPath: `${index}.md`,
      body: 'x'.repeat(200_000), status: 'pending', baseVersion: null, conflictMessage: null,
    }))
    const serialized = JSON.stringify(legacy)
    assert.ok(Buffer.byteLength(serialized, 'utf8') > 8_000_000)
    await writeFile(file, serialized)
    const inbox = new InboxStore(dir)
    const items = await inbox.list()
    assert.equal(items.length, 42)
    assert.equal(items[0].status, 'pending')
    await inbox.update(items[0].id, { status: 'dismissed' })
    const updated = await inbox.list()
    assert.equal(updated.length, 42)
    assert.equal(updated[0].status, 'dismissed')
  })
})

test('Inbox serializes aggregate baseline size and rejects excess content', async () => {
  await withTempDir(async (dir) => {
    const inbox = new InboxStore(dir)
    const baseline = 'x'.repeat(4_100_000)
    const input = (n) => ({ kind: 'append', title: `Large ${n}`, sourceId: 'vault', targetPath: `large-${n}.md`, body: 'draft' })
    const first = await inbox.add(input(1), baseline)
    assert.ok(first)
    const second = await inbox.add(input(2), baseline)
    assert.equal(second, null)
    const items = await inbox.list()
    assert.equal(items.length, 1)
    assert.equal(items[0].id, first.id)
  })
})

test('multiple InboxStore instances sharing a data directory serialize their writes', async () => {
  await withTempDir(async (dir) => {
    const firstStore = new InboxStore(dir)
    const secondStore = new InboxStore(dir)
    await Promise.all([
      firstStore.add({ kind: 'create', title: 'First', sourceId: 'vault', targetPath: 'first.md', body: 'first' }),
      secondStore.add({ kind: 'create', title: 'Second', sourceId: 'vault', targetPath: 'second.md', body: 'second' }),
    ])
    const items = await firstStore.list()
    assert.deepEqual(items.map((item) => item.title).sort(), ['First', 'Second'])
  })
})

test('Inbox capacity pruning preserves all proposal records referenced by a rebase chain', async () => {
  await withTempDir(async (dir) => {
    const legacy = Array.from({ length: MAX_INBOX_ITEMS }, (_, index) => ({
      id: index === 0 ? 'conflicted-parent' : index === 1 ? 'old-resolved' : `pending-${index}`,
      createdAt: index, kind: 'append', title: `Proposal ${index}`, sourceId: 'vault', targetPath: `${index}.md`,
      agentId: null, rebasedFrom: null, body: 'draft', baselineContent: '',
      status: index === 0 ? 'conflicted' : index === 1 ? 'dismissed' : 'pending', baseVersion: 'v1', conflictMessage: null,
    }))
    await writeFile(join(dir, 'inbox.json'), JSON.stringify(legacy))
    const inbox = new InboxStore(dir)
    const rebased = await inbox.add({ kind: 'append', title: 'Rebased', sourceId: 'vault', targetPath: '0.md', body: 'draft' }, 'baseline', 'v2', null, 'conflicted-parent')
    assert.ok(rebased)
    const items = await inbox.list()
    assert.equal(items.length, MAX_INBOX_ITEMS)
    assert.ok(items.some((item) => item.id === 'conflicted-parent'))
    assert.equal(items.some((item) => item.id === 'old-resolved'), false)
    assert.equal(items.find((item) => item.id === rebased.id)?.rebasedFrom, 'conflicted-parent')
  })
})

test('legacy Inbox migration and a concurrent add retain both entries', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'inbox.json'), JSON.stringify([{
      id: 'legacy-create', createdAt: 1, kind: 'create', title: 'Legacy', sourceId: 'vault', targetPath: 'old.md',
      body: 'old', status: 'pending', baseVersion: null, conflictMessage: null,
    }]))
    const inbox = new InboxStore(dir)
    await Promise.all([
      inbox.list(),
      inbox.add({ kind: 'create', title: 'Concurrent', sourceId: 'vault', targetPath: 'new.md', body: 'new' }),
    ])
    const items = await inbox.list()
    assert.equal(items.length, 2)
    assert.deepEqual(items.map((item) => item.title), ['Legacy', 'Concurrent'])
  })
})

test('legacy pending append proposals are preserved but disabled when no review baseline exists', async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'inbox.json'), JSON.stringify([{
      id: 'legacy', createdAt: 1, kind: 'append', title: 'Legacy', sourceId: 'vault', targetPath: 'note.md',
      body: 'old draft', status: 'pending', baseVersion: 'old-version', conflictMessage: null,
    }]))
    const items = await new InboxStore(dir).list()
    assert.equal(items[0].status, 'conflicted')
    assert.equal(items[0].baselineContent, '')
    assert.equal(items[0].baseVersion, null)
    assert.match(items[0].conflictMessage, /predates review snapshots/)
  })
})

test('baseline read permission errors return PERMISSION_DENIED without creating a draft', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: 'v1', size: 8 } },
      async readBytes() { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const result = await service.propose('vault', { kind: 'append', title: 'Append', sourceId: 'vault', targetPath: 'note.md', body: 'draft' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'PERMISSION_DENIED')
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.deepEqual(inbox.items, [])
    } finally {
      await service.shutdown()
    }
  })
})

test('oversized append targets are rejected from stat metadata before content is read', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'huge.md'), 'placeholder')
    let readAttempts = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: 'large-v1', size: 4 * 1024 * 1024 + 1 } },
      async readBytes() { readAttempts += 1; throw new Error('oversized file must not be read') },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const result = await service.propose('vault', { kind: 'append', title: 'Append', sourceId: 'vault', targetPath: 'huge.md', body: 'draft' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'TOO_LARGE')
      assert.equal(readAttempts, 0)
    } finally {
      await service.shutdown()
    }
  })
})

test('append proposal captures its full baseline and permits draft-only edits', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const targetPath = join(sourcePath, 'note.md')
    await mkdir(sourcePath)
    await writeFile(targetPath, '# Baseline\\nExisting text')
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: 'version-1' } },
      async readBytes() { return textBytes('# Baseline\\nExisting text') },
      async readText() { return '# Baseline\\nExisting text' },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', {
        kind: 'append', title: 'Add details', sourceId: 'vault', targetPath: 'note.md', body: 'Draft text',
      })
      assert.equal(created.ok, true)
      if (!created.ok) return
      assert.equal(created.item.baseVersion, 'version-1')
      assert.equal(created.item.baselineContent, '# Baseline\\nExisting text')

      const updated = await service.updateInboxDraft(created.item.id, 'Revised text')
      assert.equal(updated.ok, true)
      if (updated.ok) {
        assert.equal(updated.item.body, 'Revised text')
        assert.equal(updated.item.baselineContent, '# Baseline\\nExisting text')
      }
      assert.equal(await readFile(targetPath, 'utf8'), '# Baseline\\nExisting text')
    } finally {
      await service.shutdown()
    }
  })
})

test('append proposal rejects a baseline that changes while being captured', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'content')
    let stats = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { stats += 1; return { type: 'file', version: stats === 1 ? 'v1' : 'v2' } },
      async readBytes() { return textBytes('content read between changing versions') },
      async readText() { return 'content read between changing versions' },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const result = await service.propose('vault', { kind: 'append', title: 'Append', sourceId: 'vault', targetPath: 'note.md', body: 'draft' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'CONFLICT')
      const items = await service.listInboxItems()
      assert.equal(items.ok, true)
      if (items.ok) assert.equal(items.items.length, 0)
    } finally {
      await service.shutdown()
    }
  })
})

test('parallel proposals for the same target serialize so only one write succeeds', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const targetPath = join(sourcePath, 'note.md')
    await mkdir(sourcePath)
    await writeFile(targetPath, 'original')
    let writes = 0
    let currentVersion = 'v1'
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: currentVersion } },
      async readBytes() { return textBytes('original') },
      async readText() { return 'original' },
      async writeText() {
        writes += 1
        await new Promise((resolve) => setTimeout(resolve, 15))
        currentVersion = 'v2'
        return { version: currentVersion }
      },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const first = await service.propose('vault', { kind: 'update', title: 'First', sourceId: 'vault', targetPath: 'note.md', body: 'first' })
      const second = await service.propose('vault', { kind: 'update', title: 'Second', sourceId: 'vault', targetPath: 'note.md', body: 'second' })
      assert.equal(first.ok, true)
      assert.equal(second.ok, true)
      if (!first.ok || !second.ok) return
      const results = await Promise.all([service.applyInboxItem(first.item.id, first.item.revision), service.applyInboxItem(second.item.id, second.item.revision)])
      assert.equal(results.filter((result) => result.ok).length, 1)
      assert.equal(writes, 1)
      const items = await service.listInboxItems()
      assert.equal(items.ok, true)
      if (items.ok) assert.equal(items.items.filter((item) => item.status === 'applied').length, 1)
    } finally {
      await service.shutdown()
    }
  })
})

test('editing a draft cannot race with applying a different body', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    let currentVersion = 'v1'
    let writtenContent = ''
    let signalWriteStarted
    const writeStarted = new Promise((resolve) => { signalWriteStarted = resolve })
    let releaseWrite
    const writeGate = new Promise((resolve) => { releaseWrite = resolve })
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: currentVersion } },
      async readBytes() { return textBytes('baseline') },
      async readText() { return 'baseline' },
      async writeText(_target, content) {
        writtenContent = content
        signalWriteStarted()
        await writeGate
        currentVersion = 'v2'
        return { version: currentVersion }
      },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'update', title: 'Update', sourceId: 'vault', targetPath: 'note.md', body: 'applied body' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const applying = service.applyInboxItem(created.item.id, created.item.revision)
      await writeStarted
      const editing = service.updateInboxDraftItem(created.item.id, 'different body')
      releaseWrite()
      const applied = await applying
      const updated = await editing
      assert.equal(applied.ok, true)
      assert.equal(writtenContent, 'applied body')
      assert.equal(updated.ok, false)
      if (!updated.ok) assert.equal(updated.code, 'CONFLICT')
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) {
        assert.equal(inbox.items[0].status, 'applied')
        assert.equal(inbox.items[0].body, 'applied body')
      }
    } finally {
      releaseWrite?.()
      await service.shutdown()
    }
  })
})

test('apply rechecks DSH filesystem containment immediately before writing', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    let containmentChecks = 0
    let writes = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { containmentChecks += 1; return containmentChecks < 3 },
      async stat() { return undefined },
      async writeText() { writes += 1; return { version: 'v1' } },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'create', title: 'New', sourceId: 'vault', targetPath: 'new.md', body: 'draft' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const result = await service.applyInboxItem(created.item.id, created.item.revision)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'OUTSIDE_SOURCE')
      assert.equal(writes, 0)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.equal(inbox.items[0].status, 'pending')
    } finally {
      await service.shutdown()
    }
  })
})

test('create target appearing during pre-write revalidation marks its proposal conflicted', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    let statCalls = 0
    let writes = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() {
        statCalls += 1
        return statCalls < 3 ? undefined : { type: 'file', version: 'external-v1' }
      },
      async writeText() { writes += 1; return { version: 'v2' } },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'create', title: 'New', sourceId: 'vault', targetPath: 'new.md', body: '# Draft' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const result = await service.applyInboxItem(created.item.id, created.item.revision)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'CONFLICT')
      assert.equal(writes, 0)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) {
        assert.equal(inbox.items[0].status, 'conflicted')
        assert.match(inbox.items[0].conflictMessage, /target file already exists/)
      }
    } finally {
      await service.shutdown()
    }
  })
})

test('write permission failure keeps the proposal pending and returns a machine-readable failure', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return undefined },
      async writeText() { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'create', title: 'New', sourceId: 'vault', targetPath: 'new.md', body: 'draft' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const result = await service.applyInboxItem(created.item.id, created.item.revision)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'PERMISSION_DENIED')
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.equal(inbox.items[0].status, 'pending')
    } finally {
      await service.shutdown()
    }
  })
})

test('file success is not misreported as a write failure when Inbox status persistence fails', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const dataDir = join(root, 'plugin-data')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    let writes = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: 'v1' } },
      async readBytes() { return textBytes('baseline') },
      async readText() { return 'baseline' },
      async writeText() { writes += 1; return { version: 'v2' } },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, dataDir)
    try {
      const created = await service.propose('vault', { kind: 'update', title: 'Update', sourceId: 'vault', targetPath: 'note.md', body: 'revised' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const inboxFile = join(dataDir, 'inbox.json')
      const originalRename = fsPromises.rename
      fsPromises.rename = async function (from, to) {
        if (to === inboxFile) throw Object.assign(new Error('EISDIR: injected Inbox status rename failure'), { code: 'EISDIR' })
        return originalRename.call(this, from, to)
      }
      let result
      try {
        result = await service.applyInboxItem(created.item.id, created.item.revision)
      } finally {
        fsPromises.rename = originalRename
      }
      assert.equal(result.ok, true)
      assert.equal(writes, 1)
      if (result.ok) assert.match(result.statusError ?? '', /EISDIR|directory/i)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.equal(inbox.items[0].status, 'pending')
    } finally {
      await service.shutdown()
    }
  })
})

test('a source-root rebind during rebase cannot capture replacement-root content', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const movedPath = join(root, 'vault-original')
    const replacementPath = join(root, 'replacement')
    await mkdir(sourcePath)
    await mkdir(replacementPath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    await writeFile(join(replacementPath, 'note.md'), 'replacement secret')
    let currentVersion = 'v1'
    let currentContent = 'baseline'
    let rebindOnRead = false
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: currentVersion, size: Buffer.byteLength(currentContent) } },
      async readBytes() {
        if (rebindOnRead) {
          await rename(sourcePath, movedPath)
          await symlink(replacementPath, sourcePath)
          return textBytes('replacement secret')
        }
        return textBytes(currentContent)
      },
      async readText() { return currentContent },
      async writeText() { return { version: 'v2' } },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'append', title: 'Append', sourceId: 'vault', targetPath: 'note.md', body: 'draft' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      currentVersion = 'v2'
      currentContent = 'external update'
      await service.applyInboxItem(created.item.id, created.item.revision)
      rebindOnRead = true
      const rebased = await service.rebaseInboxItem(created.item.id)
      assert.equal(rebased.ok, false)
      if (!rebased.ok) assert.equal(rebased.code, 'OUTSIDE_SOURCE')
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.equal(inbox.items.length, 1)
    } finally {
      await service.shutdown()
    }
  })
})

test('a rebase canceled after baseline capture does not persist a new proposal', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    let currentVersion = 'v1'
    let currentContent = 'baseline'
    let abortDuringRebase = false
    const controller = new AbortController()
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: currentVersion, size: Buffer.byteLength(currentContent) } },
      async readBytes() {
        if (abortDuringRebase) controller.abort()
        return textBytes(currentContent)
      },
      async readText() { return currentContent },
      async writeText() { return { version: 'v2' } },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'append', title: 'Append', sourceId: 'vault', targetPath: 'note.md', body: 'draft' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      currentVersion = 'v2'
      currentContent = 'external update'
      await service.applyInboxItem(created.item.id, created.item.revision)
      abortDuringRebase = true
      await assert.rejects(service.rebaseInboxItem(created.item.id, 'same', controller.signal), { name: 'AbortError' })
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.equal(inbox.items.length, 1)
    } finally {
      await service.shutdown()
    }
  })
})

test('apply rejects a stale confirmation revision after the draft changes', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    let writes = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return undefined },
      async writeText() { writes += 1; return { version: 'v2' } },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'create', title: 'Note', sourceId: 'vault', targetPath: 'note.md', body: '# Initial' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const confirmationRevision = created.item.revision ?? 1
      const changed = await service.updateInboxDraftItem(created.item.id, '# Changed after confirmation opened')
      assert.equal(changed.ok, true)
      const applied = await service.applyInboxItem(created.item.id, confirmationRevision)
      assert.equal(applied.ok, false)
      if (!applied.ok) assert.equal(applied.code, 'STALE_CONFIRMATION')
      assert.equal(writes, 0)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) {
        assert.equal(inbox.items[0].body, '# Changed after confirmation opened')
        assert.equal(inbox.items[0].status, 'pending')
      }
    } finally {
      await service.shutdown()
    }
  })
})

test('an apply waiting on the target lock rechecks the revision after the first apply changes it', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'baseline')
    let currentVersion = 'v1'
    let holdNextStat = false
    let releaseStat
    let markStatStarted
    const delayedStat = new Promise((resolve) => { releaseStat = resolve })
    const statStarted = new Promise((resolve) => { markStatStarted = resolve })
    let writes = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() {
        if (holdNextStat) {
          holdNextStat = false
          markStatStarted()
          await delayedStat
        }
        return { type: 'file', version: currentVersion, size: 8 }
      },
      async readBytes() { return textBytes('baseline') },
      async writeText() { writes += 1; currentVersion = 'v2'; return { version: currentVersion } },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'append', title: 'Append', sourceId: 'vault', targetPath: 'note.md', body: 'draft' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      holdNextStat = true
      const firstApply = service.applyInboxItem(created.item.id, created.item.revision)
      await statStarted
      const staleApply = service.applyInboxItem(created.item.id, created.item.revision)
      releaseStat()
      const first = await firstApply
      const stale = await staleApply
      assert.equal(first.ok, true)
      assert.equal(stale.ok, false)
      if (!stale.ok) assert.equal(stale.code, 'STALE_CONFIRMATION')
      assert.equal(writes, 1)
    } finally {
      releaseStat?.()
      await service.shutdown()
    }
  })
})

test('a create conflict can be converted into a fresh update proposal without replacing history', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    let currentVersion = 'v2'
    let currentContent = 'file appeared after the create proposal'
    let targetExists = false
    let writes = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return targetExists ? { type: 'file', version: currentVersion, size: Buffer.byteLength(currentContent) } : undefined },
      async readBytes() { return textBytes(currentContent) },
      async writeText() { writes += 1; return { version: 'v3' } },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'create', title: 'New note', sourceId: 'vault', targetPath: 'note.md', body: '# Proposed note\n\nFull new content' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      targetExists = true
      await writeFile(join(sourcePath, 'note.md'), currentContent)
      const conflict = await service.applyInboxItem(created.item.id, created.item.revision)
      assert.equal(conflict.ok, false)
      const originalInbox = await service.listInboxItems()
      assert.equal(originalInbox.ok, true)
      if (originalInbox.ok) assert.equal(originalInbox.items[0]?.status, 'conflicted')
      const converted = await service.rebaseInboxItem(created.item.id, 'update')
      assert.equal(converted.ok, true, JSON.stringify(converted))
      if (!converted.ok) return
      assert.equal(converted.item.kind, 'update')
      assert.equal(converted.item.body, created.item.body)
      assert.equal(converted.item.baselineContent, currentContent)
      assert.equal(converted.item.baseVersion, currentVersion)
      assert.equal(converted.item.rebasedFrom, created.item.id)
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.deepEqual(inbox.items.map((entry) => ({ id: entry.id, kind: entry.kind, status: entry.status })), [
        { id: created.item.id, kind: 'create', status: 'conflicted' },
        { id: converted.item.id, kind: 'update', status: 'pending' },
      ])
      assert.equal(writes, 0)
    } finally {
      await service.shutdown()
    }
  })
})

test('rebaselining a conflicted update creates a new pending version and preserves the conflicted original', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    await writeFile(join(sourcePath, 'note.md'), 'original')
    let currentVersion = 'v1'
    let currentContent = 'original'
    let writes = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: currentVersion, size: Buffer.byteLength(currentContent) } },
      async readBytes() { return textBytes(currentContent) },
      async readText() { return currentContent },
      async writeText() { writes += 1; throw new Error('rebase must not write') },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const original = await service.propose('vault', { kind: 'update', title: 'Update note', sourceId: 'vault', targetPath: 'note.md', body: 'proposed replacement' })
      assert.equal(original.ok, true)
      if (!original.ok) return
      currentVersion = 'v2'
      currentContent = 'external edit'
      const conflict = await service.applyInboxItem(original.item.id, original.item.revision)
      assert.equal(conflict.ok, false)
      const rebased = await service.rebaseInboxItem(original.item.id)
      assert.equal(rebased.ok, true)
      if (!rebased.ok) return
      assert.notEqual(rebased.item.id, original.item.id)
      assert.equal(rebased.item.rebasedFrom, original.item.id)
      assert.equal(rebased.item.status, 'pending')
      assert.equal(rebased.item.baseVersion, 'v2')
      assert.equal(rebased.item.baselineContent, 'external edit')
      assert.equal(rebased.item.body, 'proposed replacement')
      const items = await service.listInboxItems()
      assert.equal(items.ok, true)
      if (items.ok) assert.equal(items.items.find((item) => item.id === original.item.id)?.status, 'conflicted')
      assert.equal(writes, 0)
    } finally {
      await service.shutdown()
    }
  })
})

test('read-only sandbox denial is returned as READ_ONLY and leaves the proposal pending', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    await mkdir(sourcePath)
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return undefined },
      async writeText() { throw Object.assign(new Error('cannot write: file access denied under read-only mode'), { code: 'FS_SANDBOX_DENIED' }) },
    }
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, join(root, 'plugin-data'))
    try {
      const created = await service.propose('vault', { kind: 'create', title: 'New', sourceId: 'vault', targetPath: 'new.md', body: 'draft' })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const result = await service.applyInboxItem(created.item.id, created.item.revision)
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'READ_ONLY')
      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.equal(inbox.items[0].status, 'pending')
    } finally {
      await service.shutdown()
    }
  })
})

test('append proposal does not apply if its captured base version is missing', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const targetPath = join(sourcePath, 'note.md')
    await mkdir(sourcePath)
    await writeFile(targetPath, 'Externally changed')
    let writes = 0
    const context = new Context()
    context.fs = {
      async resolve(path) { return { targetKey: path } },
      contains() { return true },
      async stat() { return { type: 'file', version: 'current-version' } },
      async readBytes() { return textBytes('Externally changed') },
      async readText() { return 'Externally changed' },
      async writeText() { writes += 1; return { version: 'written' } },
    }
    const dataDir = join(root, 'plugin-data')
    const service = new KnowledgeService(context, {
      ...defaults(), knowledgeSources: [{ id: 'vault', name: 'Vault', path: sourcePath, kind: 'folder', include: [], exclude: [] }],
    }, dataDir)
    try {
      const created = await service.propose('vault', {
        kind: 'append', title: 'Append', sourceId: 'vault', targetPath: 'note.md', body: 'append text',
      })
      assert.equal(created.ok, true)
      if (!created.ok) return
      const inbox = new InboxStore(dataDir)
      await inbox.update(created.item.id, { baseVersion: null })
      const result = await service.applyInboxItem(created.item.id, created.item.revision)
      assert.equal(result.ok, false)
      assert.equal(writes, 0)
      const current = await inbox.list()
      assert.equal(current[0].status, 'pending')
    } finally {
      await service.shutdown()
    }
  })
})
