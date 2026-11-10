import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileText, readSourceFileText } from '../src/host/read-file.ts'

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-obsidian-read-test-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

test('source index reader rejects symlink leaves instead of following outside the source', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'vault')
    const outside = join(dir, 'outside.md')
    await mkdir(root)
    await writeFile(outside, 'secret outside source')
    await symlink(outside, join(root, 'linked.md'))
    await assert.rejects(readSourceFileText(root, 'linked.md'), { code: 'OUTSIDE_SOURCE' })
  })
})

test('index reader enforces its byte cap and propagates OS permissions', async (context) => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'note.md')
    await writeFile(file, 'four')
    await assert.rejects(readFileText(file, 3), { code: 'FS_TOO_LARGE' })
    assert.equal(await readFileText(file), 'four')

    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      context.skip('root user bypasses mode-bit read restrictions')
      return
    }
    await chmod(file, 0)
    try {
      await assert.rejects(readFileText(file), (error) => error.code === 'EACCES' || error.code === 'EPERM')
    } finally {
      await chmod(file, 0o600)
    }
  })
})
