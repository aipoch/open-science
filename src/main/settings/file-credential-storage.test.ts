import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureCredentialStore } from './credential-store-mode'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('No keyring')
    },
    decryptString: () => {
      throw new Error('No keyring')
    }
  }
}))

import {
  decryptKey,
  encryptKey,
  isCredentialStorageAvailable,
  isEncryptionAvailable
} from './crypto'
import { DeviceCredentialStore } from './device-credentials'
import { SettingsDocumentStore } from './document-store'
import { ProviderRuntimeProjectionOwner } from './provider-runtime-projection'

afterEach(() => configureCredentialStore([], 'linux', true))

describe('explicit file credentials without a keyring', () => {
  it('defaults to OS storage and rejects unsupported or ambiguous selection', () => {
    expect(() => encryptKey('fixture-secret')).toThrow()
    expect(() => configureCredentialStore(['--credential-store=auto'], 'linux', true)).toThrow()
    expect(() => configureCredentialStore(['--credential-store=file'], 'darwin', true)).toThrow()
    expect(() => configureCredentialStore(['--credential-store=file'], 'linux', false)).toThrow()
    expect(() =>
      configureCredentialStore(['--credential-store=file', '--credential-store=os'], 'linux', true)
    ).toThrow()
  })

  it('round-trips file refs only with explicit opt-in, without treating them as encrypted', () => {
    configureCredentialStore(['--credential-store=file'], 'linux', true)
    expect(isEncryptionAvailable()).toBe(false)
    expect(isCredentialStorageAvailable()).toBe(true)
    expect(decryptKey(encryptKey(''))).toBe('')
    const ref = encryptKey('fixture-secret')
    expect(ref).toMatch(/^file:v1:/)
    expect(decryptKey(ref)).toBe('fixture-secret')
    expect(() => decryptKey('enc:unreadable')).toThrow()
    configureCredentialStore([], 'linux', true)
    expect(() => decryptKey(ref)).toThrow()
  })

  it('preserves provider configuration and resolves a file key through the runtime projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-provider-'))
    try {
      configureCredentialStore(['--credential-store=file'], 'linux', true)
      const store = new SettingsDocumentStore(root)
      await store.mutate((settings) => ({
        ...settings,
        providers: [
          {
            id: 'fixture',
            type: 'custom',
            name: 'Fixture',
            baseUrl: 'https://fixture.example',
            keyRef: encryptKey('provider-secret')
          }
        ]
      }))
      const provider = (await new SettingsDocumentStore(root).read()).providers[0]
      const projection = new ProviderRuntimeProjectionOwner()
      expect(projection.toProviderView(provider)).toMatchObject({ hasKey: true, needsKey: false })
      expect(projection.resolveProvider(provider).key).toBe('provider-secret')
      if (process.platform !== 'win32')
        expect((await stat(join(root, 'settings.json'))).mode & 0o777).toBe(0o600)
      configureCredentialStore([], 'linux', true)
      expect(projection.toProviderView(provider).needsKey).toBe(true)
      expect((await store.read()).providers[0].keyRef).toBe(provider.keyRef)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists OAuth client secrets and refreshed state through the same selected backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-oauth-'))
    try {
      configureCredentialStore(['--credential-store=file'], 'linux', true)
      const store = new DeviceCredentialStore(root)
      const created = await store.create({
        displayName: 'Fixture OAuth',
        kind: 'oauth',
        resourceUri: 'https://fixture.example/mcp',
        transport: 'streamable_http',
        oauth: {
          clientId: 'fixture',
          clientSecret: 'client-secret',
          authorizationServerUrl: 'https://fixture.example'
        }
      })
      await store.saveOAuthState(created.id, {
        tokens: {
          access_token: 'access-secret',
          token_type: 'Bearer',
          refresh_token: 'refresh-secret'
        }
      })
      const resolved = await new DeviceCredentialStore(root).resolveOAuth(created.id)
      expect(resolved?.clientSecret).toBe('client-secret')
      expect(resolved?.state?.tokens?.refresh_token).toBe('refresh-secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('saves, reopens and replaces a static credential through the real document owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'file-credential-'))
    try {
      configureCredentialStore(['--credential-store=file'], 'linux', true)
      const store = new DeviceCredentialStore(root)
      const saved = await store.create({
        displayName: 'Fixture',
        kind: 'token',
        secret: 'fixture-secret'
      })
      const file = join(root, 'credentials.json')
      expect(await readFile(file, 'utf8')).toContain('file:v1:')
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
      const reopened = new DeviceCredentialStore(root)
      const rows = await reopened.list()
      expect(rows[0].id).toBe(saved.id)
      expect(rows[0].kind === 'token' && decryptKey(rows[0].secretRef)).toBe('fixture-secret')
      await reopened.update({ id: saved.id, secret: 'replacement-secret' })
      const replaced = (await reopened.list())[0]
      expect(replaced.kind === 'token' && decryptKey(replaced.secretRef)).toBe('replacement-secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
