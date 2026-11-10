import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { Simulate } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { KnowledgePanelView } from '../lib/client/panel.js'

test('KnowledgePanelView opens the page-local source manager and adds a folder', async () => {
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
  const sessionSnapshot = { byId: {} }
  const localeSnapshot = { active: 'en', revision: 0 }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionSnapshot } },
    get: () => undefined,
  }
  let sources = []
  let addedInput
  let listCalls = 0
  let browsedWhenReady = false
  const rpc = {
    listSources: async () => {
      listCalls += 1
      const visibleSources = listCalls >= 4 ? sources.map((source) => ({ ...source, indexedAt: Date.now() })) : sources
      return { ok: true, sources: visibleSources }
    },
    addSource: async (input) => {
      addedInput = input
      const source = { id: 'source-1', name: input.name, path: input.path, kind: input.kind, indexedAt: null, fileCount: 0, lastError: null }
      sources = [source]
      return { ok: true, source }
    },
    removeSource: async () => ({ ok: true }),
    listInbox: async () => ({ ok: true, items: [] }),
    browse: async (sourceId) => {
      browsedWhenReady = listCalls >= 4
      return { ok: true, sourceId, directoryPath: '', directories: [], documents: [] }
    },
  }
  try {
    await act(async () => root.render(createElement(KnowledgePanelView, { ctx, rpc })))
    const sourceTab = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Knowledge sources')
    assert.ok(sourceTab)
    await act(async () => sourceTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.match(dom.window.document.body.textContent, /Choose folder/)
    const inputs = dom.window.document.querySelectorAll('input')
    const setValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      setter.call(element, value)
      Simulate.change(element, { target: { value } })
    }
    await act(async () => {
      setValue(inputs[0], 'My Vault')
      setValue(inputs[1], '/tmp/my-vault')
    })
    const addButton = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Add source')
    assert.ok(addButton)
    await act(async () => addButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(addedInput, { name: 'My Vault', path: '/tmp/my-vault', kind: 'folder' })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)))
    assert.equal(browsedWhenReady, true, 'browse should wait for indexing before requesting the folder')
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
})

test('opens a document inside the Knowledge page without a Session or sidebar file system', async () => {
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
  let copiedPath = ''
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { copiedPath = value } } })
  const source = { id: 'vault', name: 'Vault', path: '/Users/zhizhi/Documents/Vault', kind: 'vault', indexedAt: 1, fileCount: 1, lastError: null }
  const localeSnapshot = { active: 'en', revision: 0 }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    get: () => undefined,
  }
  const readPaths = []
  const scrollTargets = []
  dom.window.HTMLElement.prototype.scrollIntoView = function () { scrollTargets.push(this.id) }
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async () => ({ ok: true, query: 'k8s', hits: [{ sourceId: source.id, path: 'PWD/k8s.md', title: 'k8s', tags: [], updatedAt: 1, snippet: 'Found on this line', line: 12 }], truncated: false }),
    read: async (sourceId, relPath) => {
      readPaths.push(relPath)
      return { ok: true, sourceId, path: relPath, content: `# k8s
Content stays in Knowledge.

## Installation [guide](https://docs.example.test/installation)

## Foo

## Foo

## Foo-1

<script>globalThis.pwned = true</script>

[unsafe](javascript:alert(1))

[[next#installation-guide|Next note]]

| Key | Value |
| --- | --- |
| a | b |

\`\`\`js
const value = 1
\`\`\`

> quote text

- list item

![diagram](file:///private/secret.png)`, version: '1', title: 'k8s', tags: ['guide'], links: [{ target: 'next#installation-guide', alias: 'Next note', resolvedPath: 'notes/next.md' }], backlinks: [], updatedAt: 1 }
    },
  }
  try {
    await act(async () => root.render(createElement(KnowledgePanelView, { ctx, rpc })))
    const input = dom.window.document.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(input, 'k8s')
      Simulate.change(input, { target: { value: 'k8s' } })
    })
    const searchButton = [...dom.window.document.querySelectorAll('button')].filter((button) => button.textContent === 'Results').at(-1)
    await act(async () => searchButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    const citationButton = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Copy citation')
    assert.ok(citationButton)
    await act(async () => { citationButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.match(copiedPath, /> k8s — Vault · PWD\/k8s\.md:12/)
    assert.match(copiedPath, /> Found on this line/)
    assert.match(copiedPath, /\[Open original in DSH\]\(<\/Users\/zhizhi\/Documents\/Vault\/PWD\/k8s\.md#L12>\)/)
    const openButton = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Open')
    assert.ok(openButton)
    await act(async () => openButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    assert.match(dom.window.document.body.textContent, /Content stays in Knowledge/)
    assert.ok(dom.window.document.querySelector('h1'), 'Markdown headings should render as headings')
    const h2Ids = [...dom.window.document.querySelectorAll('h2')].map((heading) => heading.id)
    assert.deepEqual(h2Ids, ['installation-guide', 'foo', 'foo-1', 'foo-1-1'])
    assert.equal(new Set(h2Ids).size, h2Ids.length, 'generated heading anchors should be unique')
    assert.ok(dom.window.document.querySelector('table'), 'Markdown tables should render as tables')
    assert.ok(dom.window.document.querySelector('pre code'), 'fenced code should remain a code block')
    assert.ok(dom.window.document.querySelector('blockquote'), 'Markdown blockquotes should render')
    assert.ok(dom.window.document.querySelector('ul li'), 'Markdown lists should render')
    assert.equal(dom.window.document.querySelector('img'), null, 'local images must remain non-loading placeholders')
    assert.equal(dom.window.document.querySelector('script'), null, 'source HTML must remain text, not executable DOM')
    assert.equal(dom.window.document.querySelector('a[href^="javascript:"]'), null, 'unsafe link schemes must not become links')
    assert.match(dom.window.document.body.textContent, /globalThis\.pwned/)
    assert.match(dom.window.document.body.textContent, /#guide/)
    const copyButton = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Copy relative path')
    assert.ok(copyButton)
    await act(async () => { copyButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)) })
    assert.equal(copiedPath, 'PWD/k8s.md')
    const wikiLink = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Next note')
    assert.ok(wikiLink, 'resolved Wikilinks should be navigable inside the reader')
    await act(async () => wikiLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(readPaths, ['PWD/k8s.md', 'notes/next.md'])
    assert.deepEqual(scrollTargets, ['installation-guide'],  'Wikilink fragments should scroll to the matching rendered heading')
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
})

test('heading fragment scrolling stays within the Knowledge panel that initiated navigation', async () => {
  const dom = new JSDOM('<!doctype html><div id="root-a"></div><div id="root-b"></div>', { url: 'http://localhost/' })
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
  const rootA = createRoot(dom.window.document.getElementById('root-a'))
  const rootB = createRoot(dom.window.document.getElementById('root-b'))
  const source = { id: 'vault', name: 'Vault', path: '/tmp/vault', kind: 'folder', indexedAt: 1, fileCount: 1, lastError: null }
  const localeSnapshot = { active: 'en', revision: 0 }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    get: () => undefined,
  }
  const scrolledPanels = []
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    scrolledPanels.push(this.closest('#root-a') ? 'A' : 'B')
  }
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    browse: async (sourceId) => ({ ok: true, sourceId, directoryPath: '', directories: [], documents: [
      { sourceId, path: 'note.md', title: 'Note', tags: [], updatedAt: 1 },
    ] }),
    read: async (sourceId, relPath) => ({
      ok: true, sourceId, path: relPath,
      content: relPath === 'note.md' ? '# Note\n\n## Installation [guide](https://example.test)\n\n[[guide#installation-guide|Go]]' : '## Installation [guide](https://example.test)',
      version: 'v1', title: 'Note', tags: [],
      links: relPath === 'note.md' ? [{ target: 'guide#installation-guide', alias: 'Go', resolvedPath: 'guide.md' }] : [],
      backlinks: [], updatedAt: 1,
    }),
  }
  try {
    await act(async () => {
      rootA.render(createElement(KnowledgePanelView, { ctx, rpc }))
      rootB.render(createElement(KnowledgePanelView, { ctx, rpc }))
    })
    const browseA = [...dom.window.document.querySelector('#root-a').querySelectorAll('button')].find((button) => button.textContent === 'Browse')
    const browseB = [...dom.window.document.querySelector('#root-b').querySelectorAll('button')].find((button) => button.textContent === 'Browse')
    await act(async () => {
      browseA.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      browseB.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    for (const root of [dom.window.document.querySelector('#root-a'), dom.window.document.querySelector('#root-b')]) {
      const open = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Open')
      await act(async () => open.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    const linkB = [...dom.window.document.querySelector('#root-b').querySelectorAll('button')].find((button) => button.textContent === 'Go')
    await act(async () => {
      linkB.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    assert.deepEqual(scrolledPanels, ['B'])
  } finally {
    await act(async () => { rootA.unmount(); rootB.unmount() })
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
})

test('KnowledgePanelView renders search state without requiring configForms', async () => {
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
  const sessionSnapshot = { byId: {} }
  const localeSnapshot = { active: 'en', revision: 0 }
  const ctx = {
    locale: {
      subscribe: () => () => {},
      getSnapshot: () => localeSnapshot,
    },
    sessions: {
      list: {
        subscribe: () => () => {},
        getSnapshot: () => sessionSnapshot,
      },
    },
    get: () => undefined,
  }
  const rpc = {
    listSources: async () => ({ ok: true, sources: [] }),
    listInbox: async () => ({ ok: true, items: [] }),
  }
  try {
    await act(async () => root.render(createElement(KnowledgePanelView, { ctx, rpc })))
    assert.match(dom.window.document.body.textContent, /Browse/)
    assert.match(dom.window.document.body.textContent, /Enter a keyword to search/)
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
})
