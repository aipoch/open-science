import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`cipher:${plaintext}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

import { configureCredentialStore } from './credential-store-mode'
const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')

describe('SettingsService provider facade', () => {
  let dir: string
  let repository: InstanceType<typeof SettingsRepository>
  let service: InstanceType<typeof SettingsService>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-service-providers-facade-'))
    repository = new SettingsRepository(dir)
    service = new SettingsService({ repository, configRoot: dir })
    return async () => {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('builds read-only bootstrap recovery for the selected active model', async () => {
    await repository.setAgentFramework('codex')
    await repository.upsertProvider({
      id: 'cli-openai',
      name: 'OpenAI',
      type: 'official',
      vendorId: 'openai',
      model: 'gpt-5.4'
    })
    await repository.setActiveProvider('cli-openai', 'gpt-5.4-mini')
    const before = await repository.getSettings()
    expect(await service.bootstrap({ action: 'status' }, () => {})).toMatchObject({
      ok: true,
      next: {
        provider: [
          'provider',
          'add',
          '--type',
          'official',
          '--vendor',
          'openai',
          '--model',
          'gpt-5.4-mini',
          '--api-key-env',
          'OPENAI_API_KEY',
          '--json'
        ]
      }
    })
    expect(await repository.getSettings()).toEqual(before)
  })

  it('projects file storage capability and leaves legacy refs unchanged', async () => {
    configureCredentialStore(['--credential-store=file'], 'linux', true)
    try {
      const legacyRef = `plain:${Buffer.from('legacy-key').toString('base64')}`
      await repository.upsertProvider({
        id: 'legacy',
        type: 'custom',
        name: 'Legacy',
        keyRef: legacyRef
      })
      const snapshot = await service.getSettingsView()
      expect(snapshot.credentialStore).toBe('file')
      expect(service.isEncryptionAvailable()).toBe(true)
      expect((await repository.getSettings()).providers[0].keyRef).toBe(legacyRef)
    } finally {
      configureCredentialStore([], 'linux', true)
    }
  })

  it('keeps provider key migration on the existing whole-settings read path', async () => {
    const legacyRef = `plain:${Buffer.from('legacy-key', 'utf8').toString('base64')}`
    await repository.upsertProvider({
      id: 'legacy-provider',
      type: 'custom',
      name: 'Legacy',
      baseUrl: 'https://legacy.example/v1',
      model: 'legacy-model',
      apiEndpoints: ['openai'],
      keyRef: legacyRef,
      keyMask: 'le•••••ey'
    })

    await service.getConnectors()
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toContain(legacyRef)

    const snapshot = await service.getSettingsView()
    const stored = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(stored).not.toContain(legacyRef)
    expect(stored).toContain('enc:')
    expect(snapshot.providers[0]).toMatchObject({
      id: 'legacy-provider',
      maskedKey: '••••••••',
      hasKey: true,
      needsKey: false
    })
    expect(JSON.stringify(snapshot)).not.toContain('legacy-key')
  })

  it('preserves the shared id suffix sequence across providers and runtime installs', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(123)
    const facade = new SettingsService({
      repository,
      configRoot: dir,
      installManagedClaudeImpl: async ({ installId }) => ({
        result: { installId, ok: false, error: 'expected test failure' }
      })
    })

    try {
      const first = await facade.upsertProvider({
        type: 'custom',
        name: 'First',
        baseUrl: 'https://first.example/v1',
        model: 'first-model',
        key: 'first-key',
        apiEndpoints: ['openai']
      })
      expect(first.providers[0]?.id).toBe('p_123_1')

      const install = await facade.installClaude({ source: 'managed' }, () => undefined)
      expect(install.installId).toBe('install-123-2')

      const second = await facade.upsertProvider({
        type: 'custom',
        name: 'Second',
        baseUrl: 'https://second.example/v1',
        model: 'second-model',
        key: 'second-key',
        apiEndpoints: ['openai']
      })
      expect(second.providers.find((provider) => provider.name === 'Second')?.id).toBe('p_123_3')
    } finally {
      now.mockRestore()
    }
  })
})
