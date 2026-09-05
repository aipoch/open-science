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
    service = new SettingsService({ repository, configRoot: dir })
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

  it('owns device OAuth sign-in and disconnect through the Connector runtime adapter', async () => {
    const authenticate = vi.fn(async (id: string) => {
      await service.saveCustomServerOAuthState('credential:' + id, {
        tokens: { access_token: 'oauth-token', token_type: 'bearer' }
      })
    })
    const disconnect = vi.fn(async () => undefined)
    service.setDeviceCredentialAuthenticator(authenticate, vi.fn(), disconnect)

    const created = await service.createDeviceCredential({
      displayName: 'Lab OAuth',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http',
      oauth: { scopes: ['read'] }
    })
    const credential = created.credentials[0]!

    expect(authenticate).not.toHaveBeenCalled()
    expect(credential.status).toBe('disconnected')

    const connected = await service.authenticateDeviceCredential({ id: credential.id })
    expect(authenticate).toHaveBeenCalledWith(credential.id)
    expect(connected.credentials[0]?.status).toBe('connected')

    const disconnected = await service.disconnectDeviceCredential({ id: credential.id })
    expect(disconnect).toHaveBeenCalledWith(credential.id)
    expect(disconnected.credentials[0]?.status).toBe('disconnected')
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
