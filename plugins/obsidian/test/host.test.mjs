import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { KnowledgeService } from '../lib/host/knowledge-service.js'
import { registerKnowledgeTools } from '../src/host/tools.ts'
import { settingsFromConfig } from '../src/host/config.ts'
import { ObsidianConfig, defaults } from '../src/shared/settings-contract.ts'
import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
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

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-obsidian-test-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('host settings reader unwraps the Volatile values returned by rc.5 Config', () => {
  const parsed = ObsidianConfig['~standard'].validate({})
  assert.equal('issues' in parsed, false)
  assert.equal(typeof parsed.value.knowledgeSources.get, 'function')
  assert.deepEqual(settingsFromConfig(parsed.value), defaults())
})

test('knowledge-page source management persists a source and rejects duplicate paths', async () => {
  await withTempDir(async (root) => {
    const sourcePath = join(root, 'vault')
    const dataDir = join(root, 'plugin-data')
    await mkdir(sourcePath)
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
    } finally {
      await reloaded.shutdown()
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
    index.upsertDoc('vault', 'a.md', 'Alpha note', ['topic'], 'A careful searchable sentence.', 123)
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

test('recursive watcher refreshes links after edits and target creation', { skip: process.platform !== 'darwin' }, async () => {
  await withTempDir(async (root) => {
    const sourceDir = join(root, 'source')
    await mkdir(sourceDir)
    await writeFile(join(sourceDir, 'a.md'), 'See [[B]].')
    await writeFile(join(sourceDir, 'B.md'), '# B')
    const index = KnowledgeIndex.open(':memory:')
    const runtime = new KnowledgeSourceRuntime({
      id: 'vault', name: 'Vault', path: sourceDir, kind: 'vault', include: [], exclude: [],
    }, index)
    try {
      await runtime.sync()
      assert.equal(index.backLinks('vault', 'B.md').length, 1)
      runtime.startWatch()
      const editedNote = join(sourceDir, 'a.md')
      await writeFile(editedNote, 'See [[C]].')
      const now = new Date()
      await utimes(editedNote, now, new Date(now.getTime() + 2_000))
      assert.equal(await waitFor(() => index.backLinks('vault', 'B.md').length === 0), true)
      await writeFile(join(sourceDir, 'C.md'), '# C')
      assert.equal(await waitFor(() => index.outLinks('vault', 'a.md')[0]?.resolvedPath === 'C.md'), true)
    } finally {
      await runtime.stop()
      index.close()
    }
  })
})

async function waitFor(predicate, timeoutMs = 4000) {
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

test('knowledge_propose returns service validation failures without claiming a draft was created', async () => {
  const registered = []
  const service = { async propose() { return { ok: false, code: 'INVALID', message: 'target resolves outside the configured source' } } }
  registerKnowledgeTools({ tools: { register: (definition) => registered.push(definition) } }, service)
  const tool = registered.find(({ name }) => name === 'knowledge_propose')
  assert.ok(tool, 'knowledge_propose is registered')

  const result = await tool.execute({
    kind: 'create', title: 'Unsafe', sourceId: 'vault', targetPath: '../outside.md', body: 'No write',
  })

  assert.deepEqual(result, { ok: false, code: 'INVALID', message: 'target resolves outside the configured source' })
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
        return { path: targetPath }
      },
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
      assert.deepEqual(rejected, { ok: false, code: 'INVALID', message: 'target resolves outside the configured source' })

      const unknownSource = await tool.execute({
        kind: 'create', title: 'Unknown source', sourceId: 'missing', targetPath: 'notes/no.md', body: '# no',
      })
      assert.deepEqual(unknownSource, { ok: false, code: 'NOT_FOUND', message: 'unknown knowledge source' })

      const inbox = await service.listInboxItems()
      assert.equal(inbox.ok, true)
      if (inbox.ok) assert.deepEqual(inbox.items.map(({ title, targetPath, status }) => ({ title, targetPath, status })), [
        { title: 'Safe draft', targetPath: 'notes/safe.md', status: 'pending' },
      ])
      assert.equal(resolvedPaths.length, 1, 'only the contained target reaches DSH fs.resolve')
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
