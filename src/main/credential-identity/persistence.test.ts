import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: {} }))
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['decrypt', 'unavailable', 'availability-error'] as const)(
  'a failed %s selected-key read prevents settings rewrites and credential deletion without altering source bytes',
  async (failure) => {
    vi.resetModules()
    const root = await mkdtemp(join(tmpdir(), 'credential-preserve-'))
    roots.push(root)
    const settings = JSON.stringify({
      version: 2,
      providers: [],
      agentFrameworkId: 'claude',
      connectors: { ncbiApiKeyRef: 'enc:b2xk' }
    })
    const credentials = JSON.stringify({
      version: 1,
      credentials: [
        {
          id: 'kept',
          kind: 'api_key',
          displayName: 'Original',
          secretRef: 'enc:b2xk',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    await writeFile(join(root, 'settings.json'), settings)
    await writeFile(join(root, 'credentials.json'), credentials)
    const { installCredentialAccess } = await import('./runtime')
    installCredentialAccess({
      identity: { backend: 'mac-keychain', appName: 'Open-Science', exists: true },
      probe: () => ({ status: 'exists' }),
      recover: () => {},
      cipher: {
        isEncryptionAvailable: () => {
          if (failure === 'availability-error') throw new Error('locked')
          return failure !== 'unavailable'
        },
        encryptString: () => {
          throw new Error('must not encrypt')
        },
        decryptString: () => {
          throw new Error('wrong key')
        }
      }
    })
    const { tryDecryptKey } = await import('../settings/crypto')
    expect(() => tryDecryptKey('enc:b2xk')).toThrow(/recovery/i)
    const { SettingsDocumentStore } = await import('../settings/document-store')
    const { DeviceCredentialStore } = await import('../settings/device-credentials')
    await expect(
      new SettingsDocumentStore(root).mutate((value) => ({ ...value, providers: [] }))
    ).rejects.toThrow(/recovery/i)
    await expect(new DeviceCredentialStore(root).remove('kept')).rejects.toThrow(/recovery/i)
    expect(await readFile(join(root, 'settings.json'), 'utf8')).toBe(settings)
    expect(await readFile(join(root, 'credentials.json'), 'utf8')).toBe(credentials)
  }
)
