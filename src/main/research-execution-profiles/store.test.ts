import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../settings/crypto', () => ({ encryptKey: vi.fn(), decryptKey: vi.fn() }))
import { ResearchExecutionProfileStore } from './store'
import { saveResearchExecutionProfileRequestSchema } from '../../shared/research-execution-profile'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const binding = {
  projectId: 'project',
  sourceSessionId: 'source',
  sourceIdentity: 'closure-1',
  descriptorVersionId: 'descriptor',
  descriptorSha256: 'a'.repeat(64),
  planKey: 'original'
}
const slots = [
  {
    key: 'provider',
    environmentVariable: 'PROVIDER_API_KEY',
    required: true,
    description: 'Provider credential'
  }
]
const secret = 'fixture-secret-never-publish-123'
async function setup(): Promise<{
  root: string
  store: ResearchExecutionProfileStore
  cipher: { encrypt(value: string): string; decrypt(value: string): string }
  request: typeof binding & {
    sessionId: string
    displayName: string
    variables: Record<string, string>
    credentials: Record<string, string>
    allowedNetworkHosts: string[]
  }
}> {
  const root = await mkdtemp(join(tmpdir(), 'research-profile-'))
  roots.push(root)
  // Deterministic test cipher still proves this owner never writes plaintext or returns refs.
  const cipher = {
    encrypt: (value: string) => 'encrypted:' + Buffer.from(value).toString('base64'),
    decrypt: (value: string) => Buffer.from(value.slice(10), 'base64').toString()
  }
  const store = new ResearchExecutionProfileStore(root, cipher)
  const request = {
    ...binding,
    sessionId: 'discussion',
    displayName: 'My provider',
    variables: { MODEL: 'small' },
    credentials: { provider: secret },
    allowedNetworkHosts: ['api.example.org']
  }
  return { root, store, cipher, request }
}
it('stores encrypted credentials locally and returns only opaque profiles; leases are revocable', async () => {
  const { root, store, request } = await setup()
  const saved = await store.save(request, binding, slots)
  expect(saved.configuredCredentialKeys).toEqual(['provider'])
  expect(JSON.stringify(saved)).not.toContain(secret)
  expect(JSON.stringify(saved)).not.toContain('encrypted:')
  expect(await readFile(join(root, 'research-execution-profiles.json'), 'utf8')).not.toContain(
    secret
  )
  const lease = await store.lease(saved.profileId, binding, slots)
  expect(lease.privateEnvironment).toEqual({ MODEL: 'small', PROVIDER_API_KEY: secret })
  expect(lease.secretValues).toEqual([secret])
  lease.release()
  expect(lease.privateEnvironment).toEqual({})
  expect(lease.secretValues).toEqual([])
})
it('refuses cross-research reuse, unknown slots and credentials placed in public variables', async () => {
  const { store, request } = await setup()
  const saved = await store.save(request, binding, slots)
  await expect(
    store.lease(saved.profileId, { ...binding, sourceIdentity: 'other' }, slots)
  ).rejects.toThrow('unavailable')
  await expect(
    store.save({ ...request, credentials: { other: secret } }, binding, slots)
  ).rejects.toThrow('declared')
  await expect(
    store.save({ ...request, variables: { PROVIDER_API_KEY: secret } }, binding, slots)
  ).rejects.toThrow('declared')
  await expect(
    store.save({ ...request, variables: { CONFIG: secret } }, binding, slots)
  ).rejects.toThrow('public')
  expect(await store.list({ ...binding, descriptorSha256: 'b'.repeat(64) })).toEqual([])
})
it('preserves secrets during non-secret updates, fails closed when locked, and removes profiles', async () => {
  const { store, cipher, request } = await setup()
  const saved = await store.save(request, binding, slots)
  await store.save(
    { ...request, profileId: saved.profileId, credentials: {}, variables: { MODEL: 'large' } },
    binding,
    slots
  )
  const lease = await store.lease(saved.profileId, binding, slots)
  expect(lease.privateEnvironment.MODEL).toBe('large')
  expect(lease.privateEnvironment.PROVIDER_API_KEY).toBe(secret)
  lease.release()
  cipher.decrypt = () => {
    throw new Error(secret)
  }
  await expect(store.lease(saved.profileId, binding, slots)).rejects.toThrow('unavailable')
  await store.remove(saved.profileId, binding)
  expect(await store.list(binding)).toEqual([])
})
it('does not grant runtime control, wildcards, local hosts, or persist an aborted save', async () => {
  const { root, store, request } = await setup()
  for (const name of [
    'PATH',
    'HOME',
    'NODE_OPTIONS',
    'BASH_ENV',
    'LD_PRELOAD',
    'OPEN_SCIENCE_INPUT_DIR'
  ]) {
    expect(
      saveResearchExecutionProfileRequestSchema.safeParse({
        ...request,
        variables: { [name]: 'bad' }
      }).success
    ).toBe(false)
  }
  for (const host of ['*', '*.example.org', 'localhost', '127.0.0.1', 'https://example.org']) {
    expect(
      saveResearchExecutionProfileRequestSchema.safeParse({
        ...request,
        allowedNetworkHosts: [host]
      }).success
    ).toBe(false)
  }
  const controller = new AbortController()
  controller.abort()
  await expect(store.save(request, binding, slots, controller.signal)).rejects.toThrow()
  await expect(readFile(join(root, 'research-execution-profiles.json'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
})
