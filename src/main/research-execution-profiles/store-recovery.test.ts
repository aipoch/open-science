import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ResearchExecutionProfileStore } from './store'

const faults = vi.hoisted(() => ({
  beforeReplace: undefined as (() => void) | undefined,
  beforeRecovery: undefined as (() => void) | undefined
}))
vi.mock('electron', () => ({ safeStorage: {} }))
vi.mock('../storage/durable-json-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/durable-json-file')>()
  const filesystem = await import('node:fs/promises')
  return {
    ...actual,
    readDurableJsonFile: async (
      ...[path, decode, dependencies = {}, options = {}]: Parameters<
        typeof actual.readDurableJsonFile
      >
    ): ReturnType<typeof actual.readDurableJsonFile> =>
      actual.readDurableJsonFile(
        path,
        decode,
        {
          ...dependencies,
          rename: async (source, destination) => {
            faults.beforeRecovery?.()
            await (dependencies.rename ?? filesystem.rename)(source, destination)
          }
        },
        options
      ),
    writeDurableJsonFile: async (
      ...[path, contents, dependencies = {}]: Parameters<typeof actual.writeDurableJsonFile>
    ): Promise<void> =>
      actual.writeDurableJsonFile(path, contents, {
        ...dependencies,
        rename: async (source, destination) => {
          faults.beforeReplace?.()
          await (dependencies.rename ?? filesystem.rename)(source, destination)
        }
      })
  }
})
const roots: string[] = []
beforeEach(() => {
  vi.resetModules()
  faults.beforeReplace = undefined
  faults.beforeRecovery = undefined
})
afterEach(async () => {
  faults.beforeReplace = undefined
  faults.beforeRecovery = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const binding = {
  projectId: 'project',
  sourceSessionId: 'source',
  sourceIdentity: 'source-identity',
  descriptorVersionId: 'descriptor',
  descriptorSha256: 'a'.repeat(64),
  planKey: 'baseline'
}
const request = {
  ...binding,
  sessionId: 'discussion',
  displayName: 'Local provider',
  variables: {},
  allowedNetworkHosts: [],
  credentials: { provider: 'test-secret-never-log' }
}
const slots = [
  {
    key: 'provider',
    description: 'Provider key',
    environmentVariable: 'PROVIDER_KEY',
    required: true
  }
]

async function setup(): Promise<{
  root: string
  path: string
  original: string
  store: ResearchExecutionProfileStore
  profileId: string
  latchFailure: () => void
}> {
  const root = await mkdtemp(join(tmpdir(), 'research-profile-recovery-'))
  roots.push(root)
  const { ResearchExecutionProfileStore } = await import('./store')
  const store = new ResearchExecutionProfileStore(root, {
    encrypt: (text) => 'enc:' + Buffer.from(text).toString('base64'),
    decrypt: (text) => Buffer.from(text.slice(4), 'base64').toString()
  })
  const profile = await store.save(request, binding, slots)
  const path = join(root, 'research-execution-profiles.json')
  const original = await readFile(path, 'utf8')
  const { installCredentialAccess, credentialCipher } =
    await import('../credential-identity/runtime')
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from('must-not-replace'),
    decryptString: (): string => {
      throw new Error('test-secret-never-log')
    }
  }
  installCredentialAccess({
    identity: { backend: 'mac-keychain', appName: 'Open-Science', exists: true },
    probe: () => ({ status: 'exists' }),
    cipher,
    recover: () => undefined
  })
  return {
    root,
    path,
    original,
    store,
    profileId: profile.profileId,
    latchFailure: () => {
      try {
        credentialCipher(cipher).decryptString(Buffer.from('ciphertext'))
      } catch {
        /* recovery latch is the assertion target */
      }
    }
  }
}

it('rejects profile reads, leases, edits and deletion after credential recovery is latched', async () => {
  const h = await setup()
  h.latchFailure()
  for (const operation of [
    () => h.store.list(binding),
    () => h.store.lease(h.profileId, binding, slots),
    () =>
      h.store.save(
        { ...request, profileId: h.profileId, credentials: {}, displayName: 'Edited' },
        binding,
        slots
      ),
    () => h.store.remove(h.profileId, binding)
  ]) {
    await expect(operation()).rejects.toMatchObject({ name: 'CredentialIdentityError' })
    expect(await readFile(h.path, 'utf8')).toBe(h.original)
  }
  expect(await readdir(h.root)).toEqual(['research-execution-profiles.json'])
})

it.each(['save', 'remove'] as const)(
  'rechecks recovery before atomic replacement for %s',
  async (method) => {
    const h = await setup()
    const checkpoint = vi.fn(h.latchFailure)
    faults.beforeReplace = checkpoint
    const writing =
      method === 'save'
        ? h.store.save(
            { ...request, profileId: h.profileId, credentials: {}, displayName: 'Edited' },
            binding,
            slots
          )
        : h.store.remove(h.profileId, binding)
    await expect(writing).rejects.toMatchObject({ name: 'CredentialIdentityError' })
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(await readFile(h.path, 'utf8')).toBe(h.original)
    expect(await readdir(h.root)).toEqual(['research-execution-profiles.json'])
  }
)

it('does not promote a recovery temp while credential access is blocked', async () => {
  const h = await setup()
  const temporary = h.path + '.123.tmp'
  await rename(h.path, temporary)
  h.latchFailure()
  await expect(h.store.list(binding)).rejects.toMatchObject({ name: 'CredentialIdentityError' })
  expect(await readdir(h.root)).toEqual(['research-execution-profiles.json.123.tmp'])
  expect(await readFile(temporary, 'utf8')).toBe(h.original)
})

it('rechecks recovery immediately before promoting a valid profile temp', async () => {
  const h = await setup()
  const temporary = h.path + '.123.tmp'
  await rename(h.path, temporary)
  const checkpoint = vi.fn(h.latchFailure)
  faults.beforeRecovery = checkpoint
  await expect(h.store.list(binding)).rejects.toMatchObject({ name: 'CredentialIdentityError' })
  expect(checkpoint).toHaveBeenCalledOnce()
  expect(await readdir(h.root)).toEqual(['research-execution-profiles.json.123.tmp'])
  expect(await readFile(temporary, 'utf8')).toBe(h.original)
})
