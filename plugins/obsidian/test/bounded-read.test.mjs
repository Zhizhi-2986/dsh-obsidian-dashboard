import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeBoundedText, readHandleTextBounded } from '../src/host/bounded-read.ts'

function fakeHandle(bytes) {
  let offset = 0
  let bytesRequested = 0
  return {
    get bytesRequested() { return bytesRequested },
    async read(buffer, bufferOffset, length) {
      bytesRequested += length
      const count = Math.min(length, bytes.byteLength - offset)
      buffer.set(bytes.subarray(offset, offset + count), bufferOffset)
      offset += count
      return { bytesRead: count }
    },
  }
}

test('bounded handle reader detects growth with at most one byte beyond the cap', async () => {
  const handle = fakeHandle(Buffer.from('growing-content'))
  await assert.rejects(readHandleTextBounded(handle, 4), { code: 'FS_TOO_LARGE' })
  assert.ok(handle.bytesRequested <= 5)
})

test('bounded handle reader decodes valid UTF-8 and rejects binary or malformed content', async () => {
  assert.equal(await readHandleTextBounded(fakeHandle(Buffer.from('text')), 4), 'text')
  assert.equal(decodeBoundedText(Buffer.from([0, 1, 2])), null)
  assert.equal(decodeBoundedText(Buffer.from([0xff, 0xfe])), null)
})
