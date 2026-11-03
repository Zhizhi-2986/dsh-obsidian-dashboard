import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/client/index.js'
import { TYPERT_REMOTE, knowledgeRpcOf } from '../src/client/remote.ts'

test('profile-scoped knowledge RPCs do not require an active Session lookup', () => {
  const browse = TYPERT_REMOTE.descriptors.find((entry) => entry.method === 'browse')
  assert.ok(browse)
  assert.deepEqual(browse.parameters.map((parameter) => parameter.name), ['sourceId', 'directoryPath'])
  assert.equal(TYPERT_REMOTE.descriptors.every((entry) => entry.parameters.every((parameter) => parameter.source !== 'lookup')), true)
})

test('registers direct knowledge-page source management RPCs', () => {
  const add = TYPERT_REMOTE.descriptors.find((entry) => entry.method === 'addSource')
  const remove = TYPERT_REMOTE.descriptors.find((entry) => entry.method === 'removeSource')
  assert.ok(add)
  assert.ok(remove)
  assert.deepEqual(add.parameters.map((parameter) => parameter.name), ['input'])
  assert.deepEqual(remove.parameters.map((parameter) => parameter.name), ['sourceId'])
})

test('unwraps the installed DSH Gateway envelope before returning knowledge results', async () => {
  const source = { id: 'vault', name: 'Vault', path: '/vault', kind: 'folder', indexedAt: 1, fileCount: 2, lastError: null }
  const remote = { knowledge: {
    listSources: async () => ({ ok: true, value: { ok: true, sources: [source] } }),
    addSource: async () => ({ ok: true, value: { ok: true, source } }),
    removeSource: async () => ({ ok: true, value: { ok: true } }),
    browse: async () => ({ ok: true, value: { ok: true, sourceId: 'vault', directoryPath: '', directories: [], documents: [] } }),
  } }
  const rpc = knowledgeRpcOf({ remote })
  assert.deepEqual(await rpc.listSources(), { ok: true, sources: [source] })
  assert.deepEqual(await rpc.addSource({ name: 'Vault', path: '/vault', kind: 'folder' }), { ok: true, source })
  assert.deepEqual(await rpc.removeSource('vault'), { ok: true })
  assert.deepEqual(await rpc.browse('vault', ''), {
    ok: true, sourceId: 'vault', directoryPath: '', directories: [], documents: [],
  })

  const failedRpc = knowledgeRpcOf({ remote: { knowledge: {
    listSources: async () => ({ ok: false, error: new Error('gateway unavailable') }),
  } } })
  assert.deepEqual(await failedRpc.listSources(), { ok: false, code: 'IO', message: 'gateway unavailable' })
})

test('mounts RPC namespace before registering Knowledge client UI', async () => {
  const registrations = []
  let injectedKnowledgeNamespace = false
  let remoteCtx
  const ctx = {
    remote: { $mount: async () => () => {}, knowledge: {} },
    locale: { register: () => () => {}, bind: () => (key) => key },
    configForms: { get: () => ({}), whileServed: (_names, callback) => callback() },
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    effect: (callback) => callback(),
    inject: (services, callback) => {
      if (services.includes('remote.knowledge')) {
        injectedKnowledgeNamespace = true
        return callback(remoteCtx)
      }
      return callback(ctx)
    },
  }
  remoteCtx = { ...ctx, remote: { knowledge: {} } }
  await apply(ctx)
  assert.equal(injectedKnowledgeNamespace, true)
  assert.ok(registrations.some(({ options }) => options.name === 'plugins.bundle.config' && options.key === 'dsh-obsidian'))
})
