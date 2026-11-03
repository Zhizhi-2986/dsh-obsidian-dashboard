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
  const source = { id: 'vault', name: 'Vault', path: '/Users/zhizhi/Documents/Vault', kind: 'vault', indexedAt: 1, fileCount: 1, lastError: null }
  const localeSnapshot = { active: 'en', revision: 0 }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
    get: () => undefined,
  }
  const rpc = {
    listSources: async () => ({ ok: true, sources: [source] }),
    listInbox: async () => ({ ok: true, items: [] }),
    search: async () => ({ ok: true, query: 'k8s', hits: [{ sourceId: source.id, path: 'PWD/k8s.md', title: 'k8s', tags: [], updatedAt: 1, snippet: null, line: null }], truncated: false }),
    read: async () => ({ ok: true, sourceId: source.id, path: 'PWD/k8s.md', content: '# k8s\\nContent stays in Knowledge.', version: '1', title: 'k8s', tags: [], links: [], backlinks: [], updatedAt: 1 }),
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
    const openButton = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Open')
    assert.ok(openButton)
    await act(async () => openButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    assert.match(dom.window.document.body.textContent, /Content stays in Knowledge/)
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
