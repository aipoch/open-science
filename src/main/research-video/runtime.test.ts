import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalModelOwner } from '../local-models/owner'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
it('keeps runtime downloads, use leases and removal under the local-model owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'narration-owner-'))
  roots.push(root)
  const content = Buffer.from('verified fixture')
  const assets = ['runtime.cjs', 'voice.bin', 'binding.node'].map((file) => ({
    file,
    url: `https://example.invalid/${file}`,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex')
  }))
  const download = vi.fn(async (_url: string, path: string) => {
    await writeFile(path, content)
    return path
  })
  const owner = createLocalModelOwner({
    namespace: 'research-narration',
    dataRoot: () => root,
    revisions: [{ revision: 'test-runtime', assets }],
    acquireWriter: () => () => {},
    download
  })
  let lease: Awaited<ReturnType<typeof owner.acquireUse>> | undefined
  try {
    expect((await owner.getSnapshot()).availability).toBe('notInstalled')
    expect(download).not.toHaveBeenCalled()
    await owner.install()
    await vi.waitFor(async () => expect((await owner.getSnapshot()).availability).toBe('ready'))
    expect(download).toHaveBeenCalledTimes(assets.length)
    lease = await owner.acquireUse()
    expect((await owner.remove()).inUse).toBe(true)
    lease.release()
    lease = undefined
    await owner.remove()
    await vi.waitFor(async () => expect((await owner.getSnapshot()).hasFiles).toBe(false))
    expect((await owner.getSnapshot()).availability).toBe('notInstalled')
  } finally {
    lease?.release()
    await owner.close()
  }
})
