import test from 'node:test'
import assert from 'node:assert/strict'
import { pickDirectory } from '../src/client/directory-picker.ts'

test('uses Desktop native chooser and returns its selected folder', async () => {
  let calls = 0
  const result = await pickDirectory({ pick: async () => { calls++; return '/Users/test/My Vault' } }, undefined)
  assert.equal(calls, 1)
  assert.equal(result, '/Users/test/My Vault')
})

test('preserves cancellation and falls back to workspace picker', async () => {
  assert.equal(await pickDirectory({ pick: async () => null }, undefined), null)
  assert.equal(await pickDirectory(undefined, { pickDirectory: async () => '/vault' }), '/vault')
})

test('reports unavailable picker instead of inventing a path', async () => {
  await assert.rejects(pickDirectory(undefined, undefined), /unavailable/i)
})
