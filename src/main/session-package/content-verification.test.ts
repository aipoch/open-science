import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { link, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withFileIoPacing } from '../file-io-pacing'
import { createPackageContentVerifier } from './materialize'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

const roots: string[] = []
const fixture = async (): Promise<{ source: string; alias: string; payload: Buffer }> => {
  const root = await mkdtemp(join(tmpdir(), 'package-verify-'))
  roots.push(root)
  const source = join(root, 'source')
  const alias = join(root, 'alias')
  const payload = Buffer.alloc(128 * 1024, 42)
  await writeFile(source, payload)
  await link(source, alias)
  return { source, alias, payload }
}
afterEach(async () => {
  if (process.platform === 'win32') {
    const observations = await Promise.all(
      vi.mocked(fs.lstat).mock.results.map(async (result, i) => {
        const stat = await result.value
        return {
          path: String(vi.mocked(fs.lstat).mock.calls[i][0]),
          ino: String(stat.ino),
          size: String(stat.size),
          mtime: String(stat.mtimeNs),
          ctime: String(stat.ctimeNs)
        }
      })
    )
    const last = observations.at(-1)
    if (last && (observations.length === 3 || observations.length === 5)) {
      const actual = await vi.importActual<typeof fs>('node:fs/promises')
      const handle = await actual.open(last.path, 'r')
      try {
        const stat = await handle.stat({ bigint: true })
        const digest = createHash('sha256')
          .update(await handle.readFile())
          .digest('hex')
        process.stdout.write(
          `[DEBUG-quit-ci-handle] ${JSON.stringify({
            observed: last,
            opened: {
              ino: String(stat.ino),
              size: String(stat.size),
              mtime: String(stat.mtimeNs),
              ctime: String(stat.ctimeNs)
            },
            digest
          })}\n`
        )
      } finally {
        await handle.close()
      }
    }
    process.stdout.write(`[DEBUG-quit-ci] ${JSON.stringify(observations)}\n`)
  }
  vi.mocked(fs.lstat).mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each([false, true])(
  'reads unchanged aliases once per invocation with large inode=%s while validating each caller budget',
  async (largeInode) => {
    const { source, alias, payload } = await fixture()
    if (largeInode) {
      const { lstat } = await vi.importActual<typeof fs>('node:fs/promises')
      vi.mocked(fs.lstat).mockImplementation(async (...args) => {
        const stat = await lstat(...args)
        // NTFS file IDs can exceed the integer precision of a JavaScript number.
        stat.ino = (typeof stat.ino === 'bigint' ? 2n ** 60n : 2 ** 60) as typeof stat.ino
        return stat
      })
    }
    let bytes = 0
    await withFileIoPacing(
      async (size) => {
        bytes += size
      },
      async () => {
        const verify = createPackageContentVerifier()
        const digest = await verify(source, payload.length)
        expect(digest).toEqual({
          sizeBytes: payload.length,
          checksum: createHash('sha256').update(payload).digest('hex')
        })
        expect(await verify(alias, payload.length)).toEqual(digest)
        expect(await verify(source, payload.length)).toEqual(digest)
        expect(bytes).toBe(payload.length)
        await expect(verify(alias, payload.length - 1)).rejects.toThrow()
        const controller = new AbortController()
        controller.abort(new Error('cancelled'))
        await expect(verify(alias, payload.length, controller.signal)).rejects.toThrow('cancelled')
        await createPackageContentVerifier()(alias, payload.length)
        expect(bytes).toBe(payload.length * 2)
      }
    )
  }
)

it(
  'does not trust a replaced source or separately stored legacy object',
  { repeats: process.platform === 'win32' ? 99 : 0 },
  async () => {
    const { source, payload } = await fixture()
    let bytes = 0
    await withFileIoPacing(
      async (size) => {
        bytes += size
      },
      async () => {
        const verify = createPackageContentVerifier()
        const original = await verify(source, payload.length)
        const replacement = `${source}.replacement`
        await writeFile(replacement, payload)
        expect(await verify(replacement, payload.length)).toEqual(original)
        expect(bytes).toBe(payload.length * 2)
        await writeFile(replacement, Buffer.alloc(payload.length, 1))
        await rename(replacement, source)
        expect((await verify(source, payload.length)).checksum).not.toBe(original.checksum)
        expect(bytes).toBe(payload.length * 3)
      }
    )
  }
)

it(
  'rehashes a same-size in-place edit and rejects edits made while hashing',
  { repeats: process.platform === 'win32' ? 99 : 0 },
  async () => {
    const { source, alias, payload } = await fixture()
    const verify = createPackageContentVerifier()
    const original = await verify(source, payload.length)
    await writeFile(alias, Buffer.alloc(payload.length, 1))
    expect((await verify(source, payload.length)).checksum).not.toBe(original.checksum)
    let changed = false
    await expect(
      withFileIoPacing(
        async () => {
          if (!changed) {
            changed = true
            await writeFile(alias, 'changed during read')
          }
        },
        () => createPackageContentVerifier()(source, payload.length)
      )
    ).rejects.toThrow('changed during validation')
  }
)
