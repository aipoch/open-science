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

const { SettingsService } = await import('./service')
const { SettingsRepository } = await import('./repository')

describe('SettingsService provider facade', () => {
  let dir: string
  let repository: InstanceType<typeof SettingsRepository>
  let service: InstanceType<typeof SettingsService>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-service-providers-facade-'))
    repository = new SettingsRepository(dir)
    service = new SettingsService({ repository, storageRoot: dir })
    return async () => {
      await rm(dir, { recursive: true, force: true })
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
      maskedKey: 'le•••••ey',
      hasKey: true,
      needsKey: false
    })
    expect(JSON.stringify(snapshot)).not.toContain('legacy-key')
  })
})
