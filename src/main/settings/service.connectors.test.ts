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

// Keeps the public SettingsService connector facade and its legacy migration trigger characterized.
describe('SettingsService connector facade', () => {
  let dir: string
  let service: InstanceType<typeof SettingsService>
  let repository: InstanceType<typeof SettingsRepository>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osci-svc-connectors-facade-'))
    repository = new SettingsRepository(dir)
    service = new SettingsService({ repository })
    return async () => {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('delegates Connector mutations and secret-free projections', async () => {
    const snapshot = await service.setNcbiCredentials({
      contactEmail: 'me@lab.org',
      apiKey: 'secret-key'
    })

    expect(snapshot.ncbi).toEqual({ contactEmail: 'me@lab.org', hasApiKey: true })
    expect(JSON.stringify(snapshot)).not.toContain('secret-key')
    expect((await service.getConnectors())?.ncbiApiKeyRef).toMatch(/^enc:/)
  })

  it('migrates a legacy NCBI key only through the existing whole-settings read path', async () => {
    await repository.setNcbiCredentials('me@lab.org', 'plain:legacy-key')

    await service.getConnectors()
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toContain('plain:legacy-key')

    await service.getSettingsView()
    const stored = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(stored).not.toContain('plain:legacy-key')
    expect(stored).toContain('enc:')
  })
})
