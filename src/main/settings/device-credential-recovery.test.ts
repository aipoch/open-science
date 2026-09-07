import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CreateDeviceCredentialRequest } from '../../shared/settings'
import { ConnectorSettingsModule } from './connector-settings'
import { DeviceCredentialStore } from './device-credentials'
import { SettingsRepository } from './repository'

const keychain = vi.hoisted(() => ({ unreadable: new Set<string>(), available: true }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value: string) => Buffer.from(`cipher:${value}`),
    decryptString: (buffer: Buffer) => {
      if (keychain.unreadable.has(buffer.toString())) throw new Error('Cannot decrypt this value')
      return buffer.toString().slice('cipher:'.length)
    }
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

describe('device credential recovery', () => {
  let dir: string
  beforeEach(async () => {
    keychain.unreadable.clear()
    keychain.available = true
    dir = await mkdtemp(join(tmpdir(), 'device-credential-recovery-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.each(['unreadable', 'rotated'] as const)(
    'replaces a %s OAuth client secret without changing credential identity or consumers',
    async (reason) => {
      const store = new DeviceCredentialStore(dir)
      const module = new ConnectorSettingsModule(new SettingsRepository(dir), fetch, store)
      const { createdCredential } = await module.createDeviceCredential({
        displayName: 'Registered OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {
          authorizationServerUrl: 'https://auth.example.test/',
          clientId: 'registered-client',
          clientSecret: 'old-client-secret'
        }
      })
      await module.addCustomServer({
        name: 'consumer',
        displayName: 'Consumer',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/',
        oauthCredentialId: createdCredential.id
      })
      if (reason === 'unreadable') keychain.unreadable.add('cipher:old-client-secret')
      expect((await module.listDeviceCredentials()).credentials[0]).toMatchObject({
        needsSecret: reason === 'unreadable',
        hasClientSecret: true,
        consumerCount: 1
      })
      // Saving or clearing login state cannot replace the separate registration secret.
      await store.saveOAuthState(createdCredential.id, {
        tokens: { access_token: 'temporary-token', token_type: 'Bearer' }
      })
      await store.saveOAuthState(createdCredential.id, undefined)
      expect((await store.resolveOAuth(createdCredential.id))?.clientSecret).toBe(
        reason === 'unreadable' ? undefined : 'old-client-secret'
      )

      await expect(
        module.updateDeviceCredential({ id: createdCredential.id, secret: 'new-client-secret' })
      ).resolves.toMatchObject({
        credentials: [{ id: createdCredential.id, needsSecret: false, consumerCount: 1 }]
      })
      const reopened = new DeviceCredentialStore(dir)
      await expect(reopened.resolveOAuth(createdCredential.id)).resolves.toMatchObject({
        clientSecret: 'new-client-secret',
        oauth: { clientId: 'registered-client' }
      })
      expect(await reopened.list()).toHaveLength(1)
      expect(await readFile(join(dir, 'credentials.json'), 'utf8')).not.toContain(
        'new-client-secret'
      )
    }
  )

  it('distinguishes damaged login state from the registration secret and preserves valid tokens on replacement', async () => {
    const store = new DeviceCredentialStore(dir)
    const created = await store.create({
      displayName: 'Registered',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http',
      oauth: {
        clientId: 'client',
        authorizationServerUrl: 'https://auth.example.test/',
        clientSecret: 'old'
      }
    })
    const state = { tokens: { access_token: 'valid-token', token_type: 'Bearer' } }
    await store.saveOAuthState(created.id, state)
    await store.update({ id: created.id, secret: 'new' })
    await expect(new DeviceCredentialStore(dir).resolveOAuth(created.id)).resolves.toMatchObject({
      clientSecret: 'new',
      state
    })
    keychain.unreadable.add(`cipher:${JSON.stringify(state)}`)
    expect(store.view((await store.list())[0]!)).toMatchObject({
      needsSecret: true,
      needsClientSecret: false,
      status: 'disconnected'
    })
    await store.saveOAuthState(created.id, state)
    keychain.unreadable.clear()
    expect(store.view((await store.list())[0]!)).toMatchObject({
      needsSecret: false,
      needsClientSecret: false,
      status: 'connected'
    })
  })

  it('rejects a client secret on a dynamically registered OAuth credential', async () => {
    const store = new DeviceCredentialStore(dir)
    const created = await store.create({
      displayName: 'Dynamic',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http',
      oauth: {}
    })
    await expect(store.update({ id: created.id, secret: 'invalid' })).rejects.toThrow(
      'Client ID is required'
    )
    expect((await store.resolveOAuth(created.id))?.hasClientSecret).toBe(false)
  })

  it.each(['empty', 'oversized', 'storage-unavailable'] as const)(
    'keeps OAuth material unchanged when replacement is %s',
    async (reason) => {
      const store = new DeviceCredentialStore(dir)
      const created = await store.create({
        displayName: 'Registered',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {
          clientId: 'client',
          authorizationServerUrl: 'https://auth.example.test/',
          clientSecret: 'original'
        }
      })
      const before = await readFile(join(dir, 'credentials.json'), 'utf8')
      if (reason === 'storage-unavailable') keychain.available = false
      await expect(
        store.update({
          id: created.id,
          secret: reason === 'empty' ? ' ' : reason === 'oversized' ? 's'.repeat(16_385) : 'new'
        })
      ).rejects.toThrow()
      expect(await readFile(join(dir, 'credentials.json'), 'utf8')).toBe(before)
    }
  )

  const requests: CreateDeviceCredentialRequest[] = [
    { displayName: 'Lab token', kind: 'token', secret: 'fictional-secret' },
    {
      displayName: 'Lab OAuth',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test/',
        clientId: 'registered-client',
        clientSecret: 'fictional-client-secret'
      }
    }
  ]
  it.each(requests)(
    'does not leave an unacknowledged $kind creation when settings projection fails',
    async (request) => {
      await writeFile(join(dir, 'settings.json'), '{broken settings')
      const store = new DeviceCredentialStore(dir)
      const module = new ConnectorSettingsModule(new SettingsRepository(dir), fetch, store)
      const result = await module.createDeviceCredential(request).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
      )
      const durable = await new DeviceCredentialStore(dir).list()
      // Either reject before committing, or acknowledge the saved identity despite refresh failure.
      expect.soft(result.value?.createdCredential.id).toBe(durable[0]?.id)
      if (result.error) {
        await rm(join(dir, 'settings.json'))
        await module.createDeviceCredential(request)
        expect(await new DeviceCredentialStore(dir).list()).toHaveLength(1)
      } else {
        expect(durable).toHaveLength(1)
      }
    }
  )
  it.each(requests)(
    'acknowledges a saved $kind identity when the post-write list read fails',
    async (request) => {
      const store = new DeviceCredentialStore(dir)
      const module = new ConnectorSettingsModule(new SettingsRepository(dir), fetch, store)
      // The real create/write path runs; only the existing public projection boundary fails.
      vi.spyOn(module, 'listDeviceCredentials').mockRejectedValueOnce(new Error('List read failed'))
      const result = await module.createDeviceCredential(request).catch(() => undefined)
      const durable = await new DeviceCredentialStore(dir).list()
      expect(durable).toHaveLength(1)
      expect(result?.createdCredential.id).toBe(durable[0]?.id)
    }
  )
})
