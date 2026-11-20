import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { Simulate } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { KnowledgePanelView } from '../lib/client/panel.js'

async function withPanel(rpc, run, context = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(dom.window.document.getElementById('root'))
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'en', revision: 0 }) },
    get: () => undefined,
    ...context,
  }
  try {
    await act(async () => { root.render(createElement(KnowledgePanelView, { ctx, rpc })); await new Promise((resolve) => setTimeout(resolve, 0)) })
    await run(dom.window.document)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    if (previous.window === undefined) delete globalThis.window
    else globalThis.window = previous.window
    if (previous.document === undefined) delete globalThis.document
    else globalThis.document = previous.document
    if (previous.navigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
    if (previous.actEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT
    else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment
  }
}

test('search result opens the note in Browse and returns to its source directory', async () => {
  let copied = ''
  const browsed = []
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async (query) => ({ ok: true, query, hits: [
      { sourceId: source.id, path: 'notes/guide one.md', title: 'Guide', tags: [], updatedAt: 1, snippet: 'matched passage', line: 42 },
    ], truncated: false }),
    read: async (sourceId, path) => ({ ok: true, sourceId, path, content: '# Original note\nFull content', version: 'v1', title: 'Guide', tags: [], links: [], backlinks: [], updatedAt: 1 }),
    browse: async (sourceId, directoryPath) => { browsed.push([sourceId, directoryPath]); return { ok: true, sourceId, directoryPath, directories: [], documents: [] } },
  }
  await withPanel(rpc, async (document) => {
    Object.defineProperty(document.defaultView.navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { copied = value } } })
    const input = document.querySelector('input')
    assert.ok(input)
    await act(async () => changeInput(document, input, 'matched'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)))
    assert.match(document.body.textContent, /Vault · notes\/guide one\.md · Line 42/)
    await act(async () => clickButton(document, 'Copy citation'))
    assert.match(copied, /Guide — Vault · notes\/guide one\.md:42/)
    assert.match(copied, /matched passage/)
    await act(async () => clickButton(document, 'Show original in Browse'))
    assert.match(document.body.textContent, /Full content/)
    await act(async () => clickButton(document, 'Back'))
    assert.deepEqual(browsed.at(-1), ['vault', 'notes'])
  })
})

test('search field selection is sent to the service', async () => {
  const calls = []
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async (query, options) => { calls.push({ query, options }); return { ok: true, query, hits: [], truncated: false } },
  }
  await withPanel(rpc, async (document) => {
    await act(async () => changeInput(document, document.querySelector('input'), 'topic'))
    const select = document.querySelector('select[aria-label="Search field"]')
    await act(async () => { select.value = 'title'; Simulate.change(select, { target: { value: 'title' } }) })
    await act(async () => clickButton(document, 'Search'))
    assert.equal(calls.at(-1).options.field, 'title')
  })
})

test('note preview loads source-relative images without requesting external images', async () => {
  const requested = []
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async (query) => ({ ok: true, query, hits: [{ sourceId: 'vault', path: 'notes/a.md', title: 'A note', tags: [], updatedAt: 1, snippet: null, line: null }], truncated: false }),
    read: async () => ({ ok: true, sourceId: 'vault', path: 'notes/a.md', content: '![Local](../images/a.png) ![Remote](https://example.com/a.png)', version: 'v1', title: 'A note', tags: [], links: [], backlinks: [], updatedAt: 1 }),
    readImage: async (sourceId, path) => { requested.push([sourceId, path]); return { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
  }
  await withPanel(rpc, async (document) => {
    await act(async () => changeInput(document, document.querySelector('input'), 'note'))
    await act(async () => clickButton(document, 'Search'))
    await act(async () => clickButton(document, 'A note'))
    assert.deepEqual(requested, [['vault', 'images/a.png']])
    assert.equal(document.querySelector('img')?.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=')
    assert.match(document.body.textContent, /Image unavailable: Remote/)
  })
})

test('note preview limits image reads and performs them one at a time', async () => {
  let calls = 0
  let active = 0
  let maxActive = 0
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async (query) => ({ ok: true, query, hits: [{ sourceId: 'vault', path: 'a.md', title: 'A note', tags: [], updatedAt: 1, snippet: null, line: null }], truncated: false }),
    read: async () => ({ ok: true, sourceId: 'vault', path: 'a.md', content: Array.from({ length: 17 }, (_, i) => `![${i}](image${i}.png)`).join('\n\n'), version: 'v1', title: 'A note', tags: [], links: [], backlinks: [], updatedAt: 1 }),
    readImage: async () => { calls++; active++; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 1)); active--; return { ok: true, dataUrl: 'data:image/png;base64,AA==' } },
  }
  await withPanel(rpc, async (document) => {
    await act(async () => changeInput(document, document.querySelector('input'), 'note'))
    await act(async () => clickButton(document, 'Search'))
    await act(async () => clickButton(document, 'A note'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 80)))
    assert.equal(calls, 16)
    assert.equal(maxActive, 1)
    assert.match(document.body.textContent, /Image preview limit reached/)
  })
})

test('Inbox dismissal errors are shown and leave the proposal pending', async () => {
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [item] }),
    dismissInbox: async () => ({ ok: false, code: 'IO', message: 'could not save Inbox' }),
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Inbox'))
    await act(async () => clickButton(document, 'Dismiss'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    assert.match(document.body.textContent, /could not save Inbox/)
    assert.match(document.body.textContent, /pending/)
  })
})

const source = { id: 'vault', name: 'Vault', path: '/vault', kind: 'vault', indexedAt: 1, fileCount: 1, lastError: null }
const item = {
  id: 'proposal-1', createdAt: 1, revision: 1, kind: 'append', title: 'Append proposal', sourceId: 'vault', targetPath: 'notes/guide.md', agentId: 'writer-agent',
  body: 'New draft paragraph', baselineContent: '# Existing guide\n\nOriginal paragraph', status: 'pending', baseVersion: 'v1', conflictMessage: null,
}

function clickButton(document, label) {
  const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent.trim() === label || entry.textContent.trim().startsWith(`${label} `))
  assert.ok(button, `expected button: ${label}`)
  button.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }))
}

function changeInput(document, input, value) {
  const setter = Object.getOwnPropertyDescriptor(document.defaultView.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  Simulate.change(input, { target: { value } })
}

function changeTextArea(document, value) {
  const textarea = document.querySelector('textarea')
  assert.ok(textarea, 'draft editor should be visible')
  const setter = Object.getOwnPropertyDescriptor(document.defaultView.HTMLTextAreaElement.prototype, 'value').set
  setter.call(textarea, value)
  Simulate.change(textarea, { target: { value } })
}

test('clicking a browse note row opens the note using a keyboard-accessible button', async () => {
  const reads = []
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    browse: async (sourceId) => ({ ok: true, sourceId, directoryPath: '', directories: [], documents: [{ sourceId, path: 'note.md', title: 'Note', tags: [], updatedAt: 1 }] }),
    read: async (sourceId, path) => { reads.push(path); return { ok: true, sourceId, path, content: '# Note content', version: 'v1', title: 'Note', tags: [], links: [], backlinks: [], updatedAt: 1 } },
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Browse'))
    const row = document.querySelector('.knowledge-file-row')
    assert.equal(row?.tagName, 'BUTTON')
    await act(async () => row.querySelector('span').dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(reads, ['note.md'])
    assert.match(document.body.textContent, /Note content/)
  })
})

test('manual save does not require a session and preserves the draft while saving', async () => {
  let savedInput
  let finishSave
  let content = '# Before'
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    browse: async (sourceId) => ({ ok: true, sourceId, directoryPath: '', directories: [], documents: [{ sourceId, path: 'note.md', title: 'Note', tags: [], updatedAt: 1 }] }),
    read: async (sourceId, path) => ({ ok: true, sourceId, path, content, version: 'v1', title: 'Note', tags: [], links: [], backlinks: [], updatedAt: 1 }),
    saveDocument: async (input) => {
      savedInput = input
      return await new Promise((resolve) => { finishSave = () => { content = input.content; resolve({ ok: true, version: 'v2', syncError: null }) } })
    },
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Browse'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await act(async () => document.querySelector('.knowledge-file-row').click())
    await act(async () => clickButton(document, '编辑笔记'))
    await act(async () => changeTextArea(document, '# After'))
    await act(async () => clickButton(document, '保存'))
    assert.equal(document.querySelector('textarea').readOnly, true)
    assert.equal([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '取消').disabled, true)
    await act(async () => { finishSave(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal('sessionId' in savedInput, false)
    assert.equal(savedInput.content, '# After')
    assert.equal(document.querySelector('textarea'), null)
  }, {
    sidebarRight: { mounted: { getSnapshot: () => undefined } },
  })
})

test('a successful save keeps its new version when refreshing the preview throws', async () => {
  let readCount = 0
  const saves = []
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    browse: async (sourceId) => ({ ok: true, sourceId, directoryPath: '', directories: [], documents: [{ sourceId, path: 'note.md', title: 'Note', tags: [], updatedAt: 1 }] }),
    read: async (sourceId, path) => {
      readCount += 1
      if (readCount === 2) throw new Error('refresh unavailable')
      return { ok: true, sourceId, path, content: readCount === 1 ? '# Before' : '# Second', version: readCount === 1 ? 'v1' : 'v3', title: 'Note', tags: [], links: [], backlinks: [], updatedAt: 1 }
    },
    saveDocument: async (input) => { saves.push(input); return { ok: true, version: saves.length === 1 ? 'v2' : 'v3', syncError: null } },
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Browse'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await act(async () => document.querySelector('.knowledge-file-row').click())
    await act(async () => clickButton(document, '编辑笔记'))
    await act(async () => changeTextArea(document, '# First'))
    await act(async () => { clickButton(document, '保存'); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(Boolean(document.querySelector('textarea')), false, 'a completed write returns to preview even when refresh fails')
    assert.match(document.body.textContent, /refresh unavailable/)
    await act(async () => clickButton(document, '编辑笔记'))
    await act(async () => changeTextArea(document, '# Second'))
    await act(async () => { clickButton(document, '保存'); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(saves[1].expectedVersion, 'v2')
    assert.equal(saves[1].expectedContent, '# First')
  })
})

test('source manager exposes a manual reindex action and refreshes the displayed status', async () => {
  const indexedSources = []
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    indexSource: async (sourceId) => {
      indexedSources.push(sourceId)
      return { ok: true, source: { ...source, indexedAt: 2, fileCount: 4 } }
    },
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Knowledge sources'))
    await act(async () => { clickButton(document, 'Reindex'); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.deepEqual(indexedSources, ['vault'])
    assert.match(document.body.textContent, /4 notes ·/)
  })
})

test('search input is debounced and sends only the latest query', async () => {
  const queries = []
  const rpc = {
    listSources: async () => ({ ok: true, sources: [] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async (query) => { queries.push(query); return { ok: true, query, hits: [], truncated: false } },
  }
  await withPanel(rpc, async (document) => {
    const input = document.querySelector('input')
    assert.ok(input)
    await act(async () => {
      changeInput(document, input, 'stale query')
      await new Promise((resolve) => setTimeout(resolve, 40))
      changeInput(document, input, 'latest query')
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)))
    assert.deepEqual(queries, ['latest query'])
  })
})

test('a slower old search response cannot overwrite results for a newer query', async () => {
  let resolveOld
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async (query) => query === 'older query'
      ? await new Promise((resolve) => { resolveOld = resolve })
      : { ok: true, query, hits: [{ sourceId: source.id, path: 'new.md', title: 'Latest result', tags: [], updatedAt: 1, snippet: null, line: null }], truncated: false },
  }
  await withPanel(rpc, async (document) => {
    const input = document.querySelector('input')
    assert.ok(input)
    await act(async () => changeInput(document, input, 'older query'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 330)))
    assert.equal(typeof resolveOld, 'function')
    await act(async () => changeInput(document, input, 'newer query'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 330)))
    assert.match(document.body.textContent, /Latest result/)
    await act(async () => resolveOld({ ok: true, query: 'older query', hits: [{ sourceId: source.id, path: 'old.md', title: 'Stale result', tags: [], updatedAt: 1, snippet: null, line: null }], truncated: false }))
    assert.doesNotMatch(document.body.textContent, /Stale result/)
  })
})

test('removing a knowledge source requires confirmation and explains files remain on disk', async () => {
  let removals = 0
  let availableSources = [source]
  const rpc = {
    listSources: async () => ({ ok: true, sources: availableSources }),
    removeSource: async () => { removals += 1; availableSources = []; return { ok: true } },
    listInbox: async () => ({ ok: true, items: [item] }),
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Knowledge sources'))
    await act(async () => clickButton(document, 'Remove'))
    assert.equal(removals, 0)
    assert.match(document.body.textContent, /Files on disk will not be deleted/i)
    assert.match(document.body.textContent, /pending proposals/i)
    assert.match(document.body.textContent, /vault/)
    await act(async () => { clickButton(document, 'Confirm remove source'); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(removals, 1)
    await act(async () => clickButton(document, 'Inbox'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    assert.match(document.body.textContent, /source was removed/)
    assert.equal([...document.querySelectorAll('button')].some((button) => button.textContent === 'Load current file for comparison'), false)
  })
})

test('Wikilink navigation stays in Browse and updates the inline note preview', async () => {
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    browse: async (sourceId) => ({ ok: true, sourceId, directoryPath: '', directories: [], documents: [
      { sourceId, path: 'notes/start.md', title: 'Start', tags: [], updatedAt: 1 },
    ] }),
    read: async (sourceId, path) => ({ ok: true, sourceId, path, content: path.endsWith('start.md') ? '# Start\\n\\n[[next|Next note]]' : '# Next', version: 'v1', title: path, tags: [], links: path.endsWith('start.md') ? [{ target: 'next', alias: 'Next note', resolvedPath: 'notes/next.md' }] : [], backlinks: [], updatedAt: 1 }),
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Browse'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const open = document.querySelector('.knowledge-file-row')
    assert.ok(open)
    await act(async () => open.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const wiki = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Next note')
    assert.ok(wiki)
    await act(async () => wiki.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    assert.match(document.body.textContent, /notes\/next\.md/)
  })
})

test('a slower earlier document read cannot replace the most recently selected note', async () => {
  let resolveFirst
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async (query) => ({ ok: true, query, hits: [
      { sourceId: source.id, path: 'notes/a.md', title: 'A note', tags: [], updatedAt: 1, snippet: null, line: null },
      { sourceId: source.id, path: 'notes/b.md', title: 'B note', tags: [], updatedAt: 1, snippet: null, line: null },
    ], truncated: false }),
    read: async (_sourceId, path) => path.endsWith('a.md')
      ? await new Promise((resolve) => { resolveFirst = resolve })
      : { ok: true, sourceId: source.id, path, content: '# B document', version: 'v2', title: 'B document', tags: [], links: [], backlinks: [], updatedAt: 2 },
  }
  await withPanel(rpc, async (document) => {
    const input = document.querySelector('input')
    assert.ok(input)
    await act(async () => changeInput(document, input, 'notes'))
    const searchButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Search')
    assert.ok(searchButton)
    await act(async () => { searchButton.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const openButtons = [...document.querySelectorAll('button')].filter((button) => ['A note', 'B note'].includes(button.textContent))
    assert.equal(openButtons.length, 2)
    await act(async () => openButtons[0].dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true })))
    assert.equal(typeof resolveFirst, 'function')
    await act(async () => openButtons[1].dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    assert.equal(document.querySelector('h1')?.textContent, 'B document')
    await act(async () => resolveFirst({ ok: true, sourceId: source.id, path: 'notes/a.md', content: '# A document', version: 'v1', title: 'A document', tags: [], links: [], backlinks: [], updatedAt: 1 }))
    assert.equal(document.querySelector('h1')?.textContent, 'B document')
  })
})

test('conflicted proposals can load the current target, compare, and create a fresh-baseline proposal', async () => {
  const conflicted = { ...item, status: 'conflicted', conflictMessage: 'file changed after proposal' }
  let rebasedFrom
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [conflicted] }),
    read: async (sourceId, path) => ({ ok: true, sourceId, path, content: '# Current external version', version: 'v2', title: 'Current', tags: [], links: [], backlinks: [], updatedAt: 2 }),
    rebaseInbox: async (id) => {
      rebasedFrom = id
      return { ok: true, item: { ...conflicted, id: 'proposal-rebased', status: 'pending', baselineContent: '# Current external version', baseVersion: 'v2', rebasedFrom: id, conflictMessage: null } }
    },
    dismissInbox: async () => ({ ok: true }),
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Inbox'))
    await act(async () => clickButton(document, 'Load current file for comparison'))
    assert.match(document.body.textContent, /Current file content/)
    assert.match(document.body.textContent, /Current external version/)
    assert.match(document.body.textContent, /current vs proposal/)
    await act(async () => clickButton(document, 'Create a proposal from current baseline'))
    assert.equal(rebasedFrom, conflicted.id)
    assert.match(document.body.textContent, /Rebased from conflict/)
    assert.match(document.body.textContent, /pending/)
  })
})

test('create and update proposals show their complete final content preview', async () => {
  for (const kind of ['create', 'update']) {
    const proposal = { ...item, id: `proposal-${kind}`, kind, body: 'Complete final body', baselineContent: kind === 'update' ? 'Previous file content' : '' }
    const rpc = {
      listSources: async () => ({ ok: true, sources: [source] }),
      listInbox: async () => ({ ok: true, items: [proposal] }),
      dismissInbox: async () => ({ ok: true }),
    }
    await withPanel(rpc, async (document) => {
      await act(async () => clickButton(document, 'Inbox'))
      const finalContent = document.querySelector('[aria-label="Proposal review"] pre')
      assert.ok(finalContent)
      assert.equal(finalContent.textContent, 'Complete final body')
      assert.equal(document.body.textContent.includes('Diff from baseline'), kind === 'update')
    })
  }
})

test('saving one proposal does not close another proposal editor', async () => {
  const first = { ...item, id: 'first', title: 'First proposal' }
  const second = { ...item, id: 'second', title: 'Second proposal', body: 'Second initial body' }
  let resolveFirstSave
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [second, first] }),
    updateInboxDraft: async (id, body) => id === first.id
      ? await new Promise((resolve) => { resolveFirstSave = () => resolve({ ok: true, item: { ...first, body } }) })
      : { ok: true, item: { ...second, body } },
    applyInbox: async () => ({ ok: true, itemId: first.id, version: 'v2', statusError: null, syncError: null }),
    dismissInbox: async () => ({ ok: true }),
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Inbox'))
    await act(async () => clickButton(document, 'Edit draft'))
    await act(async () => { changeTextArea(document, 'First updated'); clickButton(document, 'Save draft') })
    const secondProposal = [...document.querySelectorAll('[aria-label="Proposals"] button')].find((button) => button.textContent.includes('Second proposal'))
    assert.ok(secondProposal)
    await act(async () => secondProposal.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true })))
    await act(async () => clickButton(document, 'Edit draft'))
    await act(async () => changeTextArea(document, 'Unsaved second edit'))
    await act(async () => { resolveFirstSave(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    const editor = document.querySelector('textarea')
    assert.equal(editor?.value, 'Unsaved second edit')
  })
})

test('conflicted create proposals offer explicit append or replace rebases after comparison', async () => {
  const conflicted = { ...item, kind: 'create', status: 'conflicted', baselineContent: '', conflictMessage: 'target already exists' }
  let requestedOperation
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [conflicted] }),
    read: async (sourceId, path) => ({ ok: true, sourceId, path, content: '# Current external version', version: 'v2', title: 'Current', tags: [], links: [], backlinks: [], updatedAt: 2 }),
    rebaseInbox: async (_id, operation) => {
      requestedOperation = operation
      return { ok: true, item: { ...conflicted, id: 'converted-proposal', kind: operation, status: 'pending', baselineContent: '# Current external version', baseVersion: 'v2', rebasedFrom: conflicted.id, conflictMessage: null, revision: 1 } }
    },
    dismissInbox: async () => ({ ok: true }),
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Inbox'))
    await act(async () => clickButton(document, 'Load current file for comparison'))
    assert.match(document.body.textContent, /Current external version/)
    await act(async () => clickButton(document, 'Propose appending to current file'))
    assert.equal(requestedOperation, 'append')
    assert.match(document.body.textContent, /Rebased from conflict/)
    assert.match(document.body.textContent, /pending/)
  })
})

test('inbox shows full draft, final content and baseline diff before an explicit apply confirmation', async () => {
  let applied = 0
  let appliedRevision
  let draftUpdate
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [item] }),
    updateInboxDraft: async (id, body) => { draftUpdate = { id, body }; return { ok: true, item: { ...item, body, revision: item.revision + 1 } } },
    applyInbox: async (_id, expectedRevision) => { applied += 1; appliedRevision = expectedRevision; return { ok: true, itemId: item.id, version: 'v2' } },
    dismissInbox: async () => ({ ok: true }),
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Inbox'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    assert.match(document.body.textContent, /New draft paragraph/)
    assert.match(document.body.textContent, /Original paragraph/)
    assert.match(document.body.textContent, /Final content/i)
    assert.match(document.body.textContent, /Diff/i)
    assert.match(document.body.textContent, /Agent ID: writer-agent/)
    const finalContent = document.querySelector('[aria-label="Proposal review"] pre')
    assert.ok(finalContent)
    assert.equal(finalContent.textContent, '# Existing guide\n\nOriginal paragraph\n\nNew draft paragraph\n')

    await act(async () => clickButton(document, 'Edit draft'))
    await act(async () => changeTextArea(document, 'Edited draft'))
    await act(async () => { clickButton(document, 'Save draft'); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.deepEqual(draftUpdate, { id: item.id, body: 'Edited draft' })
    assert.match(document.body.textContent, /Edited draft/)

    await act(async () => clickButton(document, 'Apply to file'))
    assert.equal(applied, 0, 'opening confirmation must not write')
    assert.match(document.body.textContent, /notes\/guide\.md/)
    assert.match(document.body.textContent, /Draft revision: 2/)
    assert.match(document.body.textContent, /Edited draft/)
    await act(async () => { clickButton(document, 'Confirm apply to file'); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(applied, 1)
    assert.equal(appliedRevision, 2)
    assert.match(document.body.textContent, /Applied/i)
  })
})

test('stale apply confirmation reloads the latest draft without marking it conflicted', async () => {
  let listCalls = 0
  let appliedRevision
  const latest = { ...item, revision: 2, body: 'External edit while confirmation was open' }
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [listCalls++ === 0 ? item : latest] }),
    applyInbox: async (_id, revision) => {
      appliedRevision = revision
      return { ok: false, code: 'STALE_CONFIRMATION', message: 'proposal changed after confirmation; review it again' }
    },
    dismissInbox: async () => ({ ok: true }),
  }
  await withPanel(rpc, async (document) => {
    await act(async () => clickButton(document, 'Inbox'))
    await act(async () => clickButton(document, 'Apply to file'))
    assert.match(document.body.textContent, /Draft revision: 1/)
    await act(async () => { clickButton(document, 'Confirm apply to file'); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(appliedRevision, 1)
    assert.match(document.body.textContent, /proposal changed after confirmation/)
    assert.match(document.body.textContent, /External edit while confirmation was open/)
    await act(async () => clickButton(document, 'Apply to file'))
    assert.match(document.body.textContent, /Draft revision: 2/)
    await act(async () => clickButton(document, 'Cancel'))
  })
})
