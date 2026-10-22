import { createHash } from 'node:crypto'
import { link, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { withFileIoPacing } from '../file-io-pacing'
import { createPackageContentVerifier } from './content-verification'

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
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('reads unchanged aliases once per invocation while validating each caller budget', async () => {
  const { source, alias, payload } = await fixture()
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
})

it('does not trust a replaced source or separately stored legacy object', async () => {
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
})

it('rehashes a same-size in-place edit and rejects edits made while hashing', async () => {
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
})
