import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  }
}))

const { encryptKey } = await import('./crypto')
const { SettingsRepository } = await import('./repository')
const { XaiProviderAccountOwner } = await import('./xai-provider-account-owner')

describe('XaiProviderAccountOwner', () => {
  let dir: string
  let repository: InstanceType<typeof SettingsRepository>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-xai-account-owner-'))
    repository = new SettingsRepository(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('clears account validation when signing out', async () => {
    await repository.upsertProvider({
      id: 'builtin-xai-subscription',
      type: 'xai-subscription',
      name: 'xAI (Grok) OAuth',
      keyRef: encryptKey('refresh-token'),
      accountEmail: 'researcher@example.com',
      lastValidatedAt: 100,
      lastValidationFailure: { at: 101, category: 'auth' }
    })
    const owner = new XaiProviderAccountOwner(repository, (operation) => operation())

    await owner.logout()

    const [provider] = (await repository.getSettings()).providers
    expect(provider).not.toHaveProperty('keyRef')
    expect(provider).not.toHaveProperty('accountEmail')
    expect(provider).not.toHaveProperty('lastValidatedAt')
    expect(provider).not.toHaveProperty('lastValidationFailure')
  })
})
