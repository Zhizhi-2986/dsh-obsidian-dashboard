import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNote, digestNote, resolveLinkTarget } from '../src/host/markdown.ts'
import { KnowledgeIndex, toFtsQuery } from '../src/host/indexer.ts'
import { KnowledgeSourceRuntime } from '../src/host/knowledge-source.ts'
import { resolveContainedPath } from '../src/host/source-path.ts'
import { scanSource, fileStemOf, toSourceRel } from '../src/host/scanner.ts'
import { InboxStore } from '../src/host/inbox-store.ts'
import { sessionFileAddress } from '../src/client/resource-address.ts'
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
      await writeFile(join(sourceDir, 'a.md'), 'See [[C]].')
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

test('resource addresses percent-encode session ids and every path segment', () => {
  assert.equal(
    sessionFileAddress('session id', 'notes/a #b:c.md'),
    'dsh-resource://file/session/session%20id/notes/a%20%23b:c.md',
  )
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
