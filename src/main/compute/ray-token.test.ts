import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createNodeSecureStorageCipher } from '../credential-identity/node-cipher'
import { decodeRayTokenDocument, rayTokenFileName } from '../credential-identity/ray-token-document'
import { OptionalSecureStorageStringProtection } from './credential-vault'
import { RayTokenStore } from './ray-token'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})
async function fixture(): Promise<{
  open: () => RayTokenStore
  file: string
  protection: OptionalSecureStorageStringProtection
}> {
  const root = await mkdtemp(join(tmpdir(), 'ray-tokens-'))
  roots.push(root)
  const cipher = createNodeSecureStorageCipher(
    { backend: 'mac-keychain', appName: 'Test', exists: true },
    root,
    { readPassword: () => Buffer.from('fixture-key'), unprotect: vi.fn() }
  )
  const protection = new OptionalSecureStorageStringProtection(cipher, 'darwin')
  const open = (): RayTokenStore => new RayTokenStore(() => root, protection)
  return { open, file: join(root, rayTokenFileName), protection }
}

it('preserves concurrent updates and restores, rotates and removes only the selected gateway token', async () => {
  const { open, file } = await fixture()
  const store = open()
  const a = 'https://ray.test/one'
  const b = 'https://ray.test/two'
  expect(await store.get(a)).toBeUndefined()
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await Promise.all([
    store.set('https://RAY.test:443/one/', 'first-secret'),
    open().set(b, 'second-secret')
  ])
  expect(await open().list()).toEqual([a, b])
  expect(await open().get(a)).toBe('first-secret')
  expect(await readFile(file, 'utf8')).not.toMatch(/first-secret|second-secret/)
  await Promise.all([store.set(a, 'rotated'), store.remove(b)])
  expect(await open().get(a)).toBe('rotated')
  expect(await open().get(b)).toBeUndefined()
})

it('rejects insecure destinations, unavailable protection and a ciphertext copied to another endpoint', async () => {
  const { open, file, protection } = await fixture()
  const store = open()
  const a = 'https://ray.test/one'
  const b = 'https://ray.test/two'
  await expect(store.set('http://ray.test', 'test-token')).rejects.toThrow('require HTTPS')
  await store.set(a, 'test-token')
  const previous = await readFile(file, 'utf8')
  vi.spyOn(protection, 'protect').mockImplementationOnce(() => {
    throw new Error('cipher internals')
  })
  await expect(store.set(a, 'replacement')).rejects.toThrow('Secure credential storage unavailable')
  await expect(store.set(a, 'x'.repeat(16 * 1024 + 1))).rejects.toThrow(
    'Invalid Ray Dashboard access token'
  )
  expect(await readFile(file, 'utf8')).toBe(previous)
  const edited = decodeRayTokenDocument(previous)
  edited.entries[0].endpoint = b
  await writeFile(file, JSON.stringify(edited))
  await expect(store.get(b)).rejects.toThrow('Unable to read the Ray Dashboard access token')
})
