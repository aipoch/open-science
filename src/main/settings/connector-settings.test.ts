import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  AddCustomServerRequest,
  ConnectorsSnapshot,
  UpdateCustomServerRequest
} from '../../shared/settings'

const keychain = vi.hoisted(() => ({
  available: true,
  decryptable: true,
  encryptedValues: [] as string[]
}))

// Reversible fake safeStorage so secrets can be encrypted without an OS keychain.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (plaintext: string) => {
      if (!keychain.available) throw new Error('Encryption is unavailable')
      keychain.encryptedValues.push(plaintext)
      return Buffer.from(`cipher:${plaintext}`, 'utf8')
    },
    decryptString: (buffer: Buffer) => {
      if (!keychain.available) throw new Error('Encryption is unavailable')
      if (!keychain.decryptable) throw new Error('Ciphertext is corrupted')
      return buffer.toString('utf8').slice('cipher:'.length)
    }
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

const { ConnectorSettingsModule } = await import('./connector-settings')
const { DeviceCredentialStore } = await import('./device-credentials')
const { encryptKey } = await import('./crypto')
const { selectEnabledCustomServers } = await import('../connectors/custom-mcp-bootstrap')
const { CustomServerIdConflictError } = await import('./custom-server-identity')
const { SettingsRepository } = await import('./repository')
const { ALL_CONNECTOR_IDS } = await import('../connectors/registry')

// Exercises the durable Connector owner against a real on-disk repository.
describe('ConnectorSettingsModule', () => {
  let dir: string
  let service: InstanceType<typeof ConnectorSettingsModule>
  let repository: InstanceType<typeof SettingsRepository>
  type UntrustedAddCustomServerRequest = Omit<AddCustomServerRequest, 'displayName'> & {
    displayName?: string
    env?: Record<string, string>
    headers?: Record<string, string>
    oauth?: Exclude<UpdateCustomServerRequest['oauth'], null | undefined>
  }
  const addCustomServer = (request: UntrustedAddCustomServerRequest): Promise<ConnectorsSnapshot> =>
    service.addCustomServer({
      ...request,
      displayName: request.displayName ?? request.name
    } as AddCustomServerRequest)
  const addHistoricalCustomServer = async (
    request: UntrustedAddCustomServerRequest
  ): Promise<ConnectorsSnapshot> => {
    const oauth = request.oauth
      ? {
          ...(request.oauth.clientMetadataUrl
            ? { clientMetadataUrl: request.oauth.clientMetadataUrl }
            : {}),
          ...(request.oauth.authorizationServerUrl
            ? { authorizationServerUrl: request.oauth.authorizationServerUrl }
            : {}),
          ...(request.oauth.scopes ? { scopes: request.oauth.scopes } : {}),
          ...(request.oauth.clientId ? { clientId: request.oauth.clientId } : {}),
          ...(request.oauth.redirectUri ? { redirectUri: request.oauth.redirectUri } : {})
        }
      : undefined
    await repository.addCustomServer({
      id: request.id ?? request.name,
      name: request.name,
      displayName: request.displayName ?? request.name,
      transport: request.transport,
      enabled: !oauth,
      ...(request.description ? { description: request.description } : {}),
      ...(request.command ? { command: request.command } : {}),
      ...(request.args ? { args: request.args } : {}),
      ...(request.env ? { env: request.env } : {}),
      ...(request.url ? { url: request.url } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
      ...(oauth ? { oauth } : {}),
      ...(request.oauth?.clientSecret
        ? { oauthClientSecretRef: encryptKey(request.oauth.clientSecret) }
        : {})
    })
    return service.listConnectors()
  }

  beforeEach(async () => {
    keychain.available = true
    keychain.decryptable = true
    keychain.encryptedValues.length = 0
    dir = await mkdtemp(join(tmpdir(), 'osci-svc-connectors-'))
    repository = new SettingsRepository(dir)
    service = new ConnectorSettingsModule(repository)
    return async () => {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists every bundled connector, all enabled and not auto-allowed by default', async () => {
    const snapshot = await service.listConnectors()

    expect(snapshot.connectors).toHaveLength(ALL_CONNECTOR_IDS.length)
    expect(snapshot.connectors.every((c) => c.enabled)).toBe(true)
    expect(snapshot.connectors.every((c) => !c.autoAllow)).toBe(true)
    expect(snapshot.customServers).toEqual([])
    expect(snapshot.ncbi).toEqual({ contactEmail: undefined, hasApiKey: false })
    expect(snapshot.openAlex).toEqual({ hasApiKey: false })
  })

  it.each([
    ['locked secure storage', () => (keychain.available = false)],
    ['corrupted ciphertext', () => (keychain.decryptable = false)]
  ])(
    'marks device credentials as needing secret resolution when %s',
    async (_case, makeSecretsUnreadable) => {
      const credentialStore = new DeviceCredentialStore(dir)
      service = new ConnectorSettingsModule(repository, fetch, credentialStore)
      const staticCredential = await service.createDeviceCredential({
        displayName: 'Lab API',
        kind: 'api_key',
        secret: 'api-secret'
      })
      const oauth = await service.createDeviceCredential({
        displayName: 'Lab OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {
          authorizationServerUrl: 'https://auth.example.test/',
          clientId: 'registered-client',
          clientSecret: 'oauth-secret'
        }
      })
      await service.saveCustomServerOAuthState(`credential:${oauth.createdCredential.id}`, {
        tokens: { access_token: 'oauth-access', token_type: 'Bearer' }
      })

      makeSecretsUnreadable()

      await expect(
        credentialStore.resolveStatic(staticCredential.createdCredential.id, {
          kind: 'header',
          name: 'X-Api-Key'
        })
      ).rejects.toThrow('Static credential is unavailable')
      await expect(
        service.resolveDeviceOAuthCredential(oauth.createdCredential.id)
      ).resolves.toMatchObject({
        hasClientSecret: true,
        clientSecret: undefined,
        state: undefined
      })
      expect(await service.listDeviceCredentials()).toMatchObject({
        credentials: [
          { displayName: 'Lab API', status: 'stored', needsSecret: true },
          {
            displayName: 'Lab OAuth',
            status: 'disconnected',
            hasClientSecret: true,
            needsSecret: true
          }
        ]
      })
    }
  )

  it('returns the exact credential created by each concurrent request', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))

    const [first, second] = await Promise.all([
      service.createDeviceCredential({
        displayName: 'Shared name',
        kind: 'token',
        secret: 'first-secret'
      }),
      service.createDeviceCredential({
        displayName: 'Shared name',
        kind: 'token',
        secret: 'second-secret'
      })
    ])

    expect(first.createdCredential.id).not.toBe(second.createdCredential.id)
    expect(first.createdCredential.displayName).toBe('Shared name')
    expect(second.createdCredential.displayName).toBe('Shared name')
    expect(first.credentials).toContainEqual(first.createdCredential)
    expect(second.credentials).toContainEqual(second.createdCredential)
  })

  it('binds new Connectors to device-global static credentials without copying plaintext', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credentials = await service.createDeviceCredential({
      displayName: 'Lab token',
      kind: 'token',
      secret: 'shared-secret'
    })
    const credential = credentials.credentials[0]!

    await addCustomServer({
      name: 'shared-static',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      headerCredentialIds: { Authorization: credential.id }
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.headerRefs).toEqual({ Authorization: `credential:${credential.id}` })
    expect(JSON.stringify(stored)).not.toContain('shared-secret')
    expect((await service.getConnectors())?.customMcpServers?.[0]?.headers).toEqual({
      Authorization: 'Bearer shared-secret'
    })
    await expect(service.removeDeviceCredential({ id: credential.id })).rejects.toThrow(
      /shared-static/i
    )
  })

  it('rebinds an existing Connector environment variable to a device credential', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const first = (
      await service.createDeviceCredential({
        displayName: 'First token',
        kind: 'api_key',
        secret: 'first-secret'
      })
    ).credentials[0]!
    const second = (
      await service.createDeviceCredential({
        displayName: 'Second token',
        kind: 'api_key',
        secret: 'second-secret'
      })
    ).credentials.find(({ displayName }) => displayName === 'Second token')!
    const added = await addCustomServer({
      name: 'rebind-static',
      transport: 'stdio',
      command: 'npx',
      envCredentialIds: { API_TOKEN: first.id }
    })

    await service.updateCustomServer({
      id: added.customServers[0].id,
      transport: 'stdio',
      command: 'npx',
      envCredentialIds: { API_TOKEN: second.id }
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.envRefs).toEqual({ API_TOKEN: `credential:${second.id}` })
    expect(JSON.stringify(stored)).not.toContain('second-secret')
    expect((await service.getConnectors())?.customMcpServers?.[0]?.env).toEqual({
      API_TOKEN: 'second-secret'
    })
  })

  it('rebinds an existing Connector header to a device credential', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const first = (
      await service.createDeviceCredential({
        displayName: 'First token',
        kind: 'token',
        secret: 'first-secret'
      })
    ).createdCredential
    const second = (
      await service.createDeviceCredential({
        displayName: 'Second token',
        kind: 'token',
        secret: 'second-secret'
      })
    ).createdCredential
    const added = await addCustomServer({
      name: 'rebind-header',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      headerCredentialIds: { Authorization: first.id }
    })

    await service.updateCustomServer({
      id: added.customServers[0].id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      headerCredentialIds: { Authorization: second.id }
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.headerRefs).toEqual({ Authorization: `credential:${second.id}` })
    expect(JSON.stringify(stored)).not.toContain('second-secret')
    expect((await service.getConnectors())?.customMcpServers?.[0]?.headers).toEqual({
      Authorization: 'Bearer second-secret'
    })
  })

  it('serializes credential removal with a concurrent Connector binding', async () => {
    const credentialStore = new DeviceCredentialStore(dir)
    service = new ConnectorSettingsModule(repository, fetch, credentialStore)
    const credentials = await service.createDeviceCredential({
      displayName: 'Concurrent token',
      kind: 'token',
      secret: 'shared-secret'
    })
    const credential = credentials.credentials[0]!
    let releasePersist!: () => void
    let markPersistStarted!: () => void
    const persistStarted = new Promise<void>((resolve) => {
      markPersistStarted = resolve
    })
    const persistReleased = new Promise<void>((resolve) => {
      releasePersist = resolve
    })
    const addPersistedServer = repository.addCustomServer.bind(repository)
    vi.spyOn(repository, 'addCustomServer').mockImplementation(async (server) => {
      markPersistStarted()
      await persistReleased
      return addPersistedServer(server)
    })
    const removeCredential = vi.spyOn(credentialStore, 'remove')

    const adding = addCustomServer({
      name: 'concurrent-binding',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      headerCredentialIds: { Authorization: credential.id }
    })
    await persistStarted
    const removing = service.removeDeviceCredential({ id: credential.id })
    await Promise.resolve()

    expect(removeCredential).not.toHaveBeenCalled()
    releasePersist()
    await adding
    await expect(removing).rejects.toThrow(/concurrent-binding/i)
    expect(removeCredential).not.toHaveBeenCalled()
  })

  it('keeps shared OAuth config and state solely in the device credential document', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credentials = await service.createDeviceCredential({
      displayName: 'Lab OAuth',
      kind: 'oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test/',
        scopes: ['read'],
        clientId: 'registered-client',
        clientSecret: 'oauth-client-secret'
      }
    })
    const credential = credentials.credentials[0]!
    await service.saveCustomServerOAuthState(`credential:${credential.id}`, {
      tokens: { access_token: 'initial-oauth-token', token_type: 'bearer' }
    })
    const added = await addCustomServer({
      name: 'shared-oauth',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauthCredentialId: credential.id
    })
    expect(added.customServers[0]).toMatchObject({
      enabled: true,
      oauthCredentialId: credential.id,
      oauth: { sharedCredential: true }
    })
    const id = added.customServers[0]!.id
    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'oauth-token', token_type: 'bearer' }
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored).toMatchObject({ oauthRef: `credential:${credential.id}` })
    expect(stored?.oauth).toBeUndefined()
    expect((await service.getConnectors())?.customMcpServers?.[0]).toMatchObject({
      oauth: { scopes: ['read'] },
      oauthState: { tokens: { access_token: 'oauth-token' } }
    })
    expect((await service.listDeviceCredentials()).credentials[0]).toMatchObject({
      status: 'connected',
      consumerCount: 1,
      consumerNames: ['shared-oauth']
    })

    const exported = await service.buildCustomServerTemplateExport(id)
    expect(exported.contents).not.toContain('oauth-client-secret')
    expect(JSON.parse(exported.contents!).oauth).toEqual({
      authorization_server_url: 'https://auth.example.test/',
      scopes: ['read'],
      client_id: 'registered-client'
    })
    expect(JSON.parse(exported.contents!).required_secrets).toEqual({ oauth_client_secret: true })

    await expect(
      service.updateCustomServer({
        id,
        transport: 'streamable_http',
        url: 'https://mcp.example.test/',
        oauth: {
          authorizationServerUrl: 'https://auth.example.test/',
          scopes: ['write'],
          clientId: 'registered-client'
        }
      })
    ).rejects.toThrow(/edited in Credentials/i)
    expect((await repository.getSettings()).connectors?.customMcpServers?.[0]?.oauthRef).toBe(
      `credential:${credential.id}`
    )

    await addCustomServer({
      name: 'shared-oauth-sibling',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauthCredentialId: credential.id
    })
    const consumerIds = await service.deviceCredentialConsumerIds(credential.id)
    await repository.setCustomServersEnabled(consumerIds, true)
    await service.disconnectCustomServer(id)
    expect((await service.listDeviceCredentials()).credentials[0]).toMatchObject({
      status: 'disconnected',
      consumerCount: 2
    })
    expect(
      (await service.listConnectors()).customServers.filter((server) =>
        consumerIds.includes(server.id)
      )
    ).toEqual([
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ enabled: false })
    ])
  })

  it('binds an existing remote Connector to an already connected OAuth credential', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Existing OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: { scopes: ['read'] }
      })
    ).credentials[0]!
    const added = await addCustomServer({
      name: 'existing-remote',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/'
    })
    const id = added.customServers[0]!.id
    await service.saveCustomServerOAuthState(`credential:${credential.id}`, {
      tokens: { access_token: 'connected-token', token_type: 'Bearer' }
    })

    const updated = await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauthCredentialId: credential.id
    })

    expect((await repository.getSettings()).connectors?.customMcpServers?.[0]).toMatchObject({
      oauthRef: `credential:${credential.id}`,
      enabled: true
    })
    expect(updated.customServers[0]).toMatchObject({
      oauthCredentialId: credential.id,
      oauth: { scopes: ['read'], sharedCredential: true }
    })
    expect((await service.listDeviceCredentials()).credentials[0]).toMatchObject({
      consumerCount: 1,
      consumerNames: ['existing-remote']
    })
  })

  it('disables an existing remote Connector when the selected OAuth credential is disconnected', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Disconnected OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {}
      })
    ).credentials[0]!
    const added = await addCustomServer({
      name: 'disconnected-remote',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/'
    })

    await service.updateCustomServer({
      id: added.customServers[0]!.id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauthCredentialId: credential.id
    })

    expect((await repository.getSettings()).connectors?.customMcpServers?.[0]).toMatchObject({
      oauthRef: `credential:${credential.id}`,
      enabled: false
    })
  })

  it('fails closed when a shared OAuth client secret cannot be decrypted', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Unavailable OAuth secret',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {
          authorizationServerUrl: 'https://auth.example.test/',
          clientId: 'registered-client',
          clientSecret: 'oauth-secret'
        }
      })
    ).credentials[0]!
    await addCustomServer({
      name: 'unavailable-oauth-secret',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauthCredentialId: credential.id
    })

    keychain.available = false

    await expect(service.listConnectors()).resolves.toMatchObject({
      customServers: [
        expect.objectContaining({
          name: 'unavailable-oauth-secret',
          availability: 'credential_unavailable'
        })
      ]
    })
  })

  it('requires a shared OAuth credential transport to match its Connector', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credential = (
      await service.createDeviceCredential({
        displayName: 'SSE OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'sse',
        oauth: {}
      })
    ).credentials[0]!

    await expect(
      addCustomServer({
        name: 'wrong-transport',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/',
        oauthCredentialId: credential.id
      })
    ).rejects.toThrow(/transport does not match/i)
  })

  it('serializes OAuth disconnect with new Connector bindings', async () => {
    const credentialStore = new DeviceCredentialStore(dir)
    service = new ConnectorSettingsModule(repository, fetch, credentialStore)
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Shared OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {}
      })
    ).credentials[0]!
    await credentialStore.saveOAuthState(credential.id, {
      tokens: { access_token: 'shared-token', token_type: 'bearer' }
    })
    const barrierEntered = Promise.withResolvers<void>()
    const releaseBarrier = Promise.withResolvers<void>()
    const disconnect = service.disconnectDeviceCredential(
      credential.id,
      async (consumers, mutation) => {
        expect(consumers).toEqual([])
        barrierEntered.resolve()
        await releaseBarrier.promise
        return mutation()
      }
    )
    await barrierEntered.promise
    const add = addCustomServer({
      name: 'disconnect-race',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauthCredentialId: credential.id
    })
    let addSettled = false
    void add.finally(() => {
      addSettled = true
    })
    await Promise.resolve()
    expect(addSettled).toBe(false)
    releaseBarrier.resolve()
    await Promise.all([disconnect, add])

    expect((await repository.getSettings()).connectors?.customMcpServers?.[0]).toMatchObject({
      enabled: false,
      oauthRef: `credential:${credential.id}`
    })
    expect((await credentialStore.resolveOAuth(credential.id))?.state).toBeUndefined()
  })

  it.each([
    ['resource URL', { url: 'https://other.example.test/' }],
    ['transport', { transport: 'sse' as const }]
  ])(
    'fails closed when a persisted shared OAuth binding has a mismatched %s',
    async (_case, mutation) => {
      const credentialStore = new DeviceCredentialStore(dir)
      service = new ConnectorSettingsModule(repository, fetch, credentialStore)
      const credential = (
        await service.createDeviceCredential({
          displayName: 'Scoped OAuth',
          kind: 'oauth',
          resourceUri: 'https://mcp.example.test/',
          transport: 'streamable_http',
          oauth: {}
        })
      ).credentials[0]!
      await credentialStore.saveOAuthState(credential.id, {
        tokens: { access_token: 'scoped-token', token_type: 'bearer' }
      })
      await addCustomServer({
        name: 'tampered-oauth-scope',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/',
        oauthCredentialId: credential.id
      })
      const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
      await repository.updateCustomServer(stored!.id, { ...stored!, ...mutation, enabled: true })

      const runtime = await service.getConnectors()
      expect(runtime?.customMcpServers?.[0]).toMatchObject({
        oauthRef: `credential:${credential.id}`,
        oauthCredentialUnavailable: true
      })
      expect(runtime?.customMcpServers?.[0]).not.toHaveProperty('oauthState')
      expect(selectEnabledCustomServers(runtime)).toEqual([])
      await expect(service.listConnectors()).resolves.toMatchObject({
        customServers: [
          expect.objectContaining({
            name: 'tampered-oauth-scope',
            availability: 'credential_unavailable'
          })
        ]
      })
    }
  )

  it('requires shared OAuth registration metadata to satisfy imported Connector requirements', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Registered OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {
          authorizationServerUrl: 'https://auth.example.test/',
          clientId: 'registered-client',
          redirectUri: 'http://127.0.0.1:8080/callback'
        }
      })
    ).credentials[0]!

    await expect(
      addCustomServer({
        name: 'wrong-oauth-registration',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/',
        oauthCredentialId: credential.id,
        oauthRequirements: {
          authorizationServerUrl: 'https://auth.example.test/',
          clientId: 'registered-client',
          redirectUri: 'http://127.0.0.1:9090/other'
        }
      })
    ).rejects.toThrow(/registration does not match/i)
  })

  it('enforces imported client-secret requirements for a selected shared OAuth credential', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Public OAuth client',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {}
      })
    ).credentials[0]!

    await expect(
      addCustomServer({
        name: 'secret-required',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/',
        oauthCredentialId: credential.id,
        requiresOAuthClientSecret: true
      })
    ).rejects.toThrow(/requires a client secret/i)
  })

  it('clears an unavailable shared OAuth binding when Configure disables OAuth', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Missing OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {}
      })
    ).credentials[0]!
    const added = await addCustomServer({
      name: 'recover-missing-oauth',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauthCredentialId: credential.id
    })
    const id = added.customServers[0]!.id
    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    await repository.updateCustomServer(stored!.id, {
      ...stored!,
      oauthRef: 'credential:missing'
    })

    const updated = await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauth: null
    })

    expect(
      (await repository.getSettings()).connectors?.customMcpServers?.[0]?.oauthRef
    ).toBeUndefined()
    expect(updated.customServers[0]).not.toHaveProperty('oauth')
    expect(updated.customServers[0]).not.toHaveProperty('availability', 'credential_unavailable')
  })

  it('fails closed when a referenced shared OAuth credential is missing', async () => {
    const credentialStore = new DeviceCredentialStore(dir)
    service = new ConnectorSettingsModule(repository, fetch, credentialStore)
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Missing OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {}
      })
    ).credentials[0]!
    const added = await addCustomServer({
      name: 'missing-oauth',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      oauthCredentialId: credential.id
    })
    const id = added.customServers[0]!.id
    await repository.setCustomServerEnabled(id, true)

    await credentialStore.remove(credential.id)

    await expect(service.listConnectors()).resolves.toMatchObject({
      customServers: [
        expect.objectContaining({ name: 'missing-oauth', availability: 'credential_unavailable' })
      ]
    })
    expect(selectEnabledCustomServers(await service.getConnectors())).toEqual([])
    await expect(service.setCustomServerEnabled({ id, enabled: true })).rejects.toThrow(
      /credential_unavailable/i
    )
  })

  it('lists a Connector with an unavailable shared static credential as unavailable', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const credential = (
      await service.createDeviceCredential({
        displayName: 'Unavailable token',
        kind: 'token',
        secret: 'shared-secret'
      })
    ).credentials[0]!
    await addCustomServer({
      name: 'unavailable-static',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/',
      headerCredentialIds: { Authorization: credential.id }
    })

    keychain.available = false

    await expect(service.listConnectors()).resolves.toMatchObject({
      customServers: [
        expect.objectContaining({
          name: 'unavailable-static',
          hasHeaders: false,
          headerNames: ['Authorization'],
          availability: 'credential_unavailable'
        })
      ]
    })
  })

  it('disables and re-enables one connector', async () => {
    let snapshot = await service.setConnectorEnabled({ id: 'chemistry', enabled: false })
    expect(snapshot.connectors.find((c) => c.id === 'chemistry')?.enabled).toBe(false)
    // Others stay enabled.
    expect(snapshot.connectors.find((c) => c.id === 'pubmed')?.enabled).toBe(true)

    snapshot = await service.setConnectorEnabled({ id: 'chemistry', enabled: true })
    expect(snapshot.connectors.find((c) => c.id === 'chemistry')?.enabled).toBe(true)
  })

  it('toggles connector auto-allow (skip approvals)', async () => {
    const snapshot = await service.setConnectorAutoAllow({ id: 'biomart', autoAllow: true })
    expect(snapshot.connectors.find((c) => c.id === 'biomart')?.autoAllow).toBe(true)
  })

  it('returns connector detail with tools defaulting to allow', async () => {
    const detail = await service.getConnectorDetail('chemistry')

    expect(detail.id).toBe('chemistry')
    expect(detail.tools.length).toBeGreaterThan(0)
    expect(detail.tools.every((t) => t.permission === 'allow')).toBe(true)
    expect(detail.tools[0].id).toBe(`chemistry/${detail.tools[0].method}`)
  })

  it('cycles a tool through block, ask, and back to allow', async () => {
    const first = await service.getConnectorDetail('chemistry')
    const toolId = first.tools[0].id

    const blocked = await service.setToolPermission({ toolId, permission: 'block' })
    expect(blocked.tools.find((t) => t.id === toolId)?.permission).toBe('block')

    const asked = await service.setToolPermission({ toolId, permission: 'ask' })
    expect(asked.tools.find((t) => t.id === toolId)?.permission).toBe('ask')

    const allowed = await service.setToolPermission({ toolId, permission: 'allow' })
    expect(allowed.tools.find((t) => t.id === toolId)?.permission).toBe('allow')
  })

  it('never keeps a tool in both ask and blocked sets', async () => {
    const first = await service.getConnectorDetail('chemistry')
    const toolId = first.tools[0].id

    await service.setToolPermission({ toolId, permission: 'ask' })
    await service.setToolPermission({ toolId, permission: 'block' })
    const c = await service.getConnectors()
    expect(c?.askToolIds ?? []).not.toContain(toolId)
    expect(c?.blockedToolIds ?? []).toContain(toolId)
  })

  it('does not persist policy for an unknown connector tool', async () => {
    await expect(
      service.setToolPermission({ toolId: 'chemistry/not-a-real-tool', permission: 'ask' })
    ).rejects.toThrow('Unknown')

    const connectors = await service.getConnectors()
    expect(connectors?.askToolIds ?? []).not.toContain('chemistry/not-a-real-tool')
  })

  it('treats block as stronger than ask when reading inconsistent stored policy', async () => {
    const first = await service.getConnectorDetail('chemistry')
    const toolId = first.tools[0].id
    await repository.setToolPolicy(toolId, true, false)
    await repository.setToolBlocked(toolId, true)

    const detail = await service.getConnectorDetail('chemistry')

    expect(detail.tools.find((tool) => tool.id === toolId)?.permission).toBe('block')
  })

  it('stores contact email and reports hasApiKey without exposing the key', async () => {
    const snapshot = await service.setNcbiCredentials({
      contactEmail: 'me@lab.org',
      apiKey: 'secret-key'
    })

    expect(snapshot.ncbi.contactEmail).toBe('me@lab.org')
    expect(snapshot.ncbi.hasApiKey).toBe(true)
    // The raw key never appears in the renderer snapshot.
    expect(JSON.stringify(snapshot)).not.toContain('secret-key')
  })

  it('preserves an omitted NCBI key and clears an explicit empty key', async () => {
    await service.setNcbiCredentials({ contactEmail: 'first@lab.org', apiKey: 'secret-key' })

    let snapshot = await service.setNcbiCredentials({ contactEmail: 'second@lab.org' })
    expect(snapshot.ncbi).toEqual({ contactEmail: 'second@lab.org', hasApiKey: true })

    snapshot = await service.setNcbiCredentials({ contactEmail: 'second@lab.org', apiKey: '' })
    expect(snapshot.ncbi).toEqual({ contactEmail: 'second@lab.org', hasApiKey: false })
  })

  it('does not report undecryptable credentials as configured', async () => {
    await service.setNcbiCredentials({ apiKey: 'ncbi-secret' })
    await service.setOpenAlexCredential({ apiKey: 'openalex-secret' })
    await addHistoricalCustomServer({
      name: 'local-secrets',
      transport: 'stdio',
      command: 'example-mcp',
      env: { API_TOKEN: 'local-secret', DAMAGED_TOKEN: 'damaged-secret' }
    })
    await addHistoricalCustomServer({
      name: 'remote-secrets',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer remote-secret' }
    })
    await addHistoricalCustomServer({
      name: 'oauth-secrets',
      transport: 'streamable_http',
      url: 'https://example.com/oauth-mcp',
      oauth: {
        authorizationServerUrl: 'https://example.com/oauth',
        clientId: 'registered-client',
        clientSecret: 'client-secret'
      }
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.find(
      ({ name }) => name === 'local-secrets'
    )
    await repository.updateCustomServer(stored!.id, {
      ...stored!,
      envRefs: { ...stored!.envRefs, DAMAGED_TOKEN: 'not-a-key-ref' }
    })
    expect(
      (await service.listConnectors()).customServers.find(({ name }) => name === 'local-secrets')
    ).toMatchObject({ hasEnv: false, enabled: true, availability: 'credential_unavailable' })

    keychain.available = false
    const snapshot = await service.listConnectors()

    expect({
      ncbi: snapshot.ncbi.hasApiKey,
      openAlex: snapshot.openAlex?.hasApiKey,
      localEnv: snapshot.customServers.find(({ name }) => name === 'local-secrets')?.hasEnv,
      remoteHeaders: snapshot.customServers.find(({ name }) => name === 'remote-secrets')
        ?.hasHeaders,
      oauthClientSecret: snapshot.customServers.find(({ name }) => name === 'oauth-secrets')?.oauth
        ?.hasClientSecret,
      oauthAvailability: snapshot.customServers.find(({ name }) => name === 'oauth-secrets')
        ?.availability
    }).toEqual({
      ncbi: false,
      openAlex: false,
      localEnv: false,
      remoteHeaders: false,
      oauthClientSecret: false,
      oauthAvailability: 'credential_unavailable'
    })
  })

  it('refuses to persist enabled state when custom credentials are unavailable', async () => {
    await repository.addCustomServer({
      id: 'credential-unavailable-enable',
      name: 'credential-unavailable-enable',
      displayName: 'Credential unavailable enable',
      transport: 'stdio',
      enabled: false,
      command: 'example-mcp',
      envRefs: { API_TOKEN: 'not-a-key-ref' }
    })

    await expect(
      service.setCustomServerEnabled({ id: 'credential-unavailable-enable', enabled: true })
    ).rejects.toThrow('credential_unavailable')

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.find(
      ({ id }) => id === 'credential-unavailable-enable'
    )
    expect(stored?.enabled).toBe(false)
  })

  it('encrypts OpenAlex at rest and exposes only configured state', async () => {
    let snapshot = await service.setOpenAlexCredential({ apiKey: 'openalex-secret' })
    expect(snapshot.openAlex).toEqual({ hasApiKey: true })
    expect(JSON.stringify(snapshot)).not.toContain('openalex-secret')

    const raw = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(raw).not.toContain('openalex-secret')
    expect(JSON.parse(raw).connectors.openAlexApiKeyRef).toMatch(/^enc:/)

    snapshot = await service.setOpenAlexCredential({ apiKey: '' })
    expect(snapshot.openAlex).toEqual({ hasApiKey: false })
  })

  it('validates an OpenAlex key without persisting or returning the secret', async () => {
    const openAlexFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }))
    const validatingService = new ConnectorSettingsModule(repository, openAlexFetch)

    const result = await validatingService.validateOpenAlexCredential({
      apiKey: 'openalex-secret'
    })

    expect(result).toEqual({ valid: true })
    const requestUrl = openAlexFetch.mock.calls[0]?.[0]
    expect(requestUrl).toBeInstanceOf(URL)
    expect((requestUrl as URL).origin).toBe('https://api.openalex.org')
    expect((requestUrl as URL).pathname).toBe('/rate-limit')
    expect((requestUrl as URL).searchParams.get('api_key')).toBe('openalex-secret')
    expect(JSON.stringify(result)).not.toContain('openalex-secret')
    expect((await repository.getSettings()).connectors?.openAlexApiKeyRef).toBeUndefined()
  })

  it('accepts a rate-limited OpenAlex key as valid', async () => {
    const rateLimitedService = new ConnectorSettingsModule(
      repository,
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }))
    )

    await expect(
      rateLimitedService.validateOpenAlexCredential({ apiKey: 'rate-limited-key' })
    ).resolves.toEqual({ valid: true })
  })

  it('classifies rejected, malformed, and unavailable OpenAlex validation attempts', async () => {
    const rejectedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 401 }))
    const rejectedService = new ConnectorSettingsModule(repository, rejectedFetch)
    await expect(
      rejectedService.validateOpenAlexCredential({ apiKey: 'rejected-key' })
    ).resolves.toEqual({ valid: false, reason: 'rejected' })

    await expect(
      rejectedService.validateOpenAlexCredential({ apiKey: 'contains spaces' })
    ).resolves.toEqual({ valid: false, reason: 'invalid-format' })
    expect(rejectedFetch).toHaveBeenCalledTimes(1)

    const unavailableService = new ConnectorSettingsModule(
      repository,
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
    )
    await expect(
      unavailableService.validateOpenAlexCredential({ apiKey: 'openalex-key' })
    ).resolves.toEqual({ valid: false, reason: 'unavailable' })
  })

  it('throws for an unknown connector id', async () => {
    await expect(service.getConnectorDetail('nope')).rejects.toThrow(/Unknown connector/)
  })

  it('does not synthesize persisted trust metadata from an ordinary add request', async () => {
    await addCustomServer({
      name: 'unverified-trust',
      transport: 'stdio',
      command: 'npx'
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored).not.toHaveProperty('trustedAt')
  })

  it('adds, toggles, and removes a local (stdio) custom server', async () => {
    let snapshot = await addCustomServer({
      name: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      description: 'Memory server'
    })
    expect(snapshot.customServers).toHaveLength(1)
    const added = snapshot.customServers[0]
    expect(added).toMatchObject({
      name: 'my-mem',
      displayName: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      enabled: true,
      description: 'Memory server'
    })
    expect(added.id).toBe('my-mem')

    snapshot = await service.setCustomServerEnabled({ id: added.id, enabled: false })
    expect(snapshot.customServers[0].enabled).toBe(false)

    await repository.setConnectorAutoAllow(added.name, true)
    await repository.setToolPolicy(`${added.name}/lookup`, true, false)
    const prunePermissions = vi.fn(async (serverId: string) => {
      expect(serverId).toBe(added.id)
      const persisted = (await repository.getSettings()).connectors
      expect(persisted?.customMcpServers ?? []).toEqual([])
      expect(persisted?.pendingCustomServerDeletionIds).toEqual([added.id])
    })
    snapshot = await service.removeCustomServer({ id: added.id }, prunePermissions)
    expect(snapshot.customServers).toEqual([])
    expect(prunePermissions).toHaveBeenCalledOnce()
    const afterRemoval = (await repository.getSettings()).connectors
    expect(afterRemoval?.autoAllowIds).not.toContain(added.name)
    expect(afterRemoval?.askToolIds ?? []).not.toContain(`${added.name}/lookup`)
    expect(afterRemoval?.pendingCustomServerDeletionIds).toBeUndefined()
  })

  it('rejects oversized manual Connector fields before persistence', async () => {
    await expect(
      addCustomServer({
        name: 'oversized-args',
        transport: 'stdio',
        command: 'npx',
        args: ['x'.repeat(2_049)]
      })
    ).rejects.toThrow('Connector argument must not exceed 2048 characters.')

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('rejects excessive manual Connector secrets before encryption', async () => {
    const env = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`TOKEN_${index}`, `secret-${index}`])
    )

    await expect(
      addCustomServer({
        name: 'oversized-env',
        transport: 'stdio',
        command: 'npx',
        env
      })
    ).rejects.toThrow('New Connectors must use shared Credentials')

    expect(keychain.encryptedValues).toEqual([])
    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it.each([
    [
      'entry count',
      Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`X-Credential-${index}`, `credential-${index}`])
      ),
      'Connector header credential bindings must not exceed 64 entries.'
    ],
    [
      'credential ID length',
      { Authorization: 'c'.repeat(129) },
      'Connector header credential bindings credential ID must not exceed 128 characters.'
    ],
    [
      'serialized size',
      Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          `X-${String(index).padStart(2, '0')}-${'n'.repeat(123)}`,
          'c'.repeat(128)
        ])
      ),
      'Connector header credential bindings must not exceed 16384 serialized bytes.'
    ]
  ])('rejects excessive credential binding %s before lookup', async (_case, bindings, error) => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))

    await expect(
      addCustomServer({
        name: 'oversized-bindings',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/',
        headerCredentialIds: bindings
      })
    ).rejects.toThrow(error)

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('applies header credential binding limits before update lookup', async () => {
    service = new ConnectorSettingsModule(repository, fetch, new DeviceCredentialStore(dir))
    const added = await addCustomServer({
      name: 'update-binding-limits',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/'
    })
    const bindings = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`X-Credential-${index}`, `credential-${index}`])
    )

    await expect(
      service.updateCustomServer({
        id: added.customServers[0].id,
        transport: 'streamable_http',
        url: 'https://mcp.example.test/',
        headerCredentialIds: bindings
      })
    ).rejects.toThrow('Connector header credential bindings must not exceed 64 entries.')

    expect((await repository.getSettings()).connectors?.customMcpServers?.[0]?.headerRefs).toBe(
      undefined
    )
  })

  it.each([
    {
      label: 'Windows environment variables',
      platform: 'win32',
      request: {
        name: 'ambiguous-add-env',
        transport: 'stdio' as const,
        command: 'npx',
        envCredentialIds: { API_TOKEN: 'first', api_token: 'second' }
      }
    },
    {
      label: 'HTTP headers',
      platform: 'darwin',
      request: {
        name: 'ambiguous-add-headers',
        transport: 'streamable_http' as const,
        url: 'https://mcp.example.test',
        headerCredentialIds: { Authorization: 'first', authorization: 'second' }
      }
    }
  ])('rejects case-colliding $label before add persistence', async ({ platform, request }) => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    try {
      await expect(addCustomServer(request)).rejects.toThrow(/duplicate credential name/i)
      expect(keychain.encryptedValues).toEqual([])
      expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it.each([
    {
      label: 'Windows environment variables',
      platform: 'win32',
      transport: 'stdio' as const,
      replacement: { env: { API_TOKEN: 'first', api_token: 'second' } }
    },
    {
      label: 'HTTP headers',
      platform: 'darwin',
      transport: 'streamable_http' as const,
      replacement: { headers: { Authorization: 'first', authorization: 'second' } }
    }
  ])('rejects case-colliding $label before update persistence', async (testCase) => {
    const added = await addCustomServer({
      name: `ambiguous-update-${testCase.transport.replaceAll('_', '-')}`,
      transport: testCase.transport,
      ...(testCase.transport === 'stdio' ? { command: 'npx' } : { url: 'https://mcp.example.test' })
    })
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: testCase.platform
    })
    keychain.encryptedValues.length = 0
    try {
      await expect(
        service.updateCustomServer({
          id: added.customServers[0].id,
          transport: testCase.transport,
          ...(testCase.transport === 'stdio'
            ? { command: 'npx' }
            : { url: 'https://mcp.example.test' }),
          ...testCase.replacement
        })
      ).rejects.toThrow(/duplicate credential name/i)
      expect(keychain.encryptedValues).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('rejects raw secret replacement while retaining historical values', async () => {
    const retainedEnvironment = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [`TOKEN_${index}`, 'x'.repeat(16_384)])
    )
    const added = await addHistoricalCustomServer({
      name: 'combined-secret-budget',
      transport: 'stdio',
      command: 'npx',
      env: retainedEnvironment,
      headers: { Authorization: 'small' }
    })
    keychain.encryptedValues.length = 0

    await expect(
      service.updateCustomServer({
        id: added.customServers[0].id,
        transport: 'stdio',
        command: 'npx',
        headers: { Authorization: 'x'.repeat(16_384) }
      })
    ).rejects.toThrow('Header values must use shared Credentials')
    expect(keychain.encryptedValues).toEqual([])
  })

  it('rejects a 65th custom Connector before persistence', async () => {
    for (let index = 0; index < 64; index += 1) {
      await addCustomServer({
        name: `capacity-${index}`,
        transport: 'stdio',
        command: 'npx'
      })
    }

    await expect(
      addCustomServer({ name: 'capacity-overflow', transport: 'stdio', command: 'npx' })
    ).rejects.toThrow('Custom Connector limit of 64 reached.')
    expect((await repository.getSettings()).connectors?.customMcpServers).toHaveLength(64)
  })

  it('grandfathers an unchanged oversized public field on an existing Connector', async () => {
    const historicalArgument = 'x'.repeat(2_049)
    await repository.addCustomServer({
      id: 'historical-oversized',
      name: 'historical-oversized',
      displayName: 'Historical',
      transport: 'stdio',
      command: 'npx',
      args: [historicalArgument],
      enabled: true,
      trustedAt: Date.now()
    })

    await expect(
      service.updateCustomServer({
        id: 'historical-oversized',
        displayName: 'Historical renamed',
        transport: 'stdio',
        command: 'npx',
        args: [historicalArgument]
      })
    ).resolves.toMatchObject({
      customServers: [expect.objectContaining({ displayName: 'Historical renamed' })]
    })
  })

  it('clears inactive credential maps when the custom-server transport changes', async () => {
    const added = await addHistoricalCustomServer({
      name: 'transport-secret-cleanup',
      transport: 'stdio',
      command: 'python3',
      env: { API_TOKEN: 'stdio-secret' }
    })
    const id = added.customServers[0].id

    await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test'
    })
    let stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.envRefs).toBeUndefined()
    expect(stored?.env).toBeUndefined()
    expect(stored?.headerRefs).toBeUndefined()

    await service.updateCustomServer({
      id,
      transport: 'stdio',
      command: 'python3',
      args: ['-u', 'server.py']
    })
    stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.headerRefs).toBeUndefined()
    expect(stored?.headers).toBeUndefined()
    expect(stored?.envRefs).toBeUndefined()
  })

  it('retains a deletion journal and reserves its ID when permission pruning fails', async () => {
    const added = await addCustomServer({
      name: 'recoverable-delete',
      transport: 'stdio',
      command: 'npx'
    })
    const id = added.customServers[0].id

    await expect(
      service.removeCustomServer({ id }, async () => {
        throw new Error('grant cleanup failed')
      })
    ).rejects.toThrow('grant cleanup failed')

    const persisted = (await repository.getSettings()).connectors
    expect(persisted?.customMcpServers ?? []).toEqual([])
    expect(persisted?.pendingCustomServerDeletionIds).toEqual([id])
    expect((await service.listConnectors()).reservedCustomServerIds).toEqual([id])
    await expect(
      service.addCustomServer({
        id,
        name: 'replacement',
        displayName: 'Replacement',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('ID is already in use')

    const replacement = await service.addCustomServer({
      name: id,
      displayName: 'Replacement',
      transport: 'stdio',
      command: 'npx'
    })
    expect(replacement.customServers[0].id).not.toBe(id)
    expect(replacement.customServers[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    const retryCleanup = vi.fn(async () => undefined)
    const retried = await service.removeCustomServer({ id }, retryCleanup)
    expect(retryCleanup).toHaveBeenCalledWith(id)
    expect(retried.reservedCustomServerIds).toEqual([])
    expect(retried.customServers).toEqual(replacement.customServers)
  })

  it('uses a valid user-provided custom server ID', async () => {
    const snapshot = await service.addCustomServer({
      id: 'research-memory',
      name: 'my-mem',
      displayName: 'My memory',
      transport: 'stdio',
      command: 'npx'
    })

    expect(snapshot.customServers[0].id).toBe('research-memory')
  })

  it('falls back to a UUID when the inferred custom server ID is reserved', async () => {
    const snapshot = await service.addCustomServer({
      name: 'mcp-research',
      displayName: 'MCP Research',
      transport: 'stdio',
      command: 'npx'
    })

    expect(snapshot.customServers[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('falls back to a UUID when an inferred ID loses a repository race', async () => {
    const persist = vi.spyOn(repository, 'addCustomServer')
    persist.mockRejectedValueOnce(new CustomServerIdConflictError())

    const snapshot = await service.addCustomServer({
      name: 'rna-reviewer',
      displayName: 'RNA reviewer',
      transport: 'stdio',
      command: 'npx'
    })

    expect(persist).toHaveBeenCalledTimes(2)
    expect(snapshot.customServers[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('rejects invalid or already-used custom server IDs', async () => {
    await expect(
      service.addCustomServer({
        id: 'hello ee',
        name: 'first-server',
        displayName: 'First server',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('ID may only contain lowercase letters, numbers, and hyphens.')

    await service.addCustomServer({
      id: 'research-memory',
      name: 'second-server',
      displayName: 'Second server',
      transport: 'stdio',
      command: 'npx'
    })
    await expect(
      service.addCustomServer({
        id: 'research-memory',
        name: 'third-server',
        displayName: 'Third server',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('ID is already in use.')

    await expect(
      service.addCustomServer({
        id: 'second-server',
        name: 'fourth-server',
        displayName: 'Fourth server',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('ID is already in use.')
    await expect(
      service.addCustomServer({
        id: 'fifth-server',
        name: 'research-memory',
        displayName: 'Fifth server',
        transport: 'stdio',
        command: 'npx'
      })
    ).rejects.toThrow('already exists')
  })

  it('advertises only safe custom Connector Skills from the successful materialization projection', async () => {
    await addCustomServer({
      name: 'custom-catalog',
      transport: 'stdio',
      command: 'example-mcp'
    })

    expect(await service.provisionedConnectorSkillNames()).not.toContain('mcp-custom-catalog')

    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [
        'mcp-custom-catalog',
        'mcp-custom-catalog',
        'mcp-second',
        'mcp-pubmed',
        'mcp-../../escape',
        'mcp-UPPER'
      ],
      availability: () => undefined,
      isRefreshing: () => false
    })

    expect(await service.provisionedConnectorSkillNames()).toContain('mcp-custom-catalog')
    expect(
      service.connectorSkillNames({
        enabledIds: [],
        autoAllowIds: [],
        disabledConnectorIds: [...ALL_CONNECTOR_IDS]
      })
    ).toEqual(['mcp-custom-catalog', 'mcp-second'])
    expect(
      service.connectorSkillCatalogEntries({
        enabledIds: [],
        autoAllowIds: [],
        disabledConnectorIds: [...ALL_CONNECTOR_IDS]
      })
    ).toEqual([
      { directory: 'mcp-custom-catalog', name: 'mcp-custom-catalog', source: 'connector' },
      { directory: 'mcp-second', name: 'mcp-second', source: 'connector' }
    ])
  })

  it('projects runtime availability separately from logical enablement', async () => {
    const added = await addCustomServer({
      name: 'offline-server',
      transport: 'stdio',
      command: 'example-mcp'
    })
    const id = added.customServers[0].id
    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [],
      availability: (serverId) => (serverId === id ? 'unavailable' : undefined),
      isRefreshing: () => false
    })

    const [server] = (await service.listConnectors()).customServers

    expect(server).toMatchObject({ id, enabled: true, availability: 'unavailable' })

    const [disabled] = (await service.setCustomServerEnabled({ id, enabled: false })).customServers
    expect(disabled).toMatchObject({ id, enabled: false })
    expect(disabled.availability).toBeUndefined()
  })

  it('does not block listing while the current runtime refresh is still pending', async () => {
    const added = await addCustomServer({
      name: 'late-offline-server',
      transport: 'stdio',
      command: 'example-mcp'
    })
    const id = added.customServers[0].id
    const runtimeProjection = {
      materializedSkillNames: () => [],
      availability: () => undefined,
      isRefreshing: () => true
    }
    service.setCustomServerRuntimeProjectionProvider(runtimeProjection)

    const [server] = (await service.listConnectors()).customServers

    expect(server).toMatchObject({ id, enabled: true, checking: true })
  })

  it('projects checking only for the custom server currently being refreshed', async () => {
    const first = await service.addCustomServer({
      name: 'refreshing-server',
      displayName: 'Refreshing server',
      transport: 'stdio',
      command: 'example-mcp'
    })
    const refreshingId = first.customServers[0].id
    const second = await service.addCustomServer({
      name: 'settled-server',
      displayName: 'Settled server',
      transport: 'stdio',
      command: 'example-mcp'
    })
    const settledId = second.customServers.find((server) => server.id !== refreshingId)!.id
    service.setCustomServerRuntimeProjectionProvider({
      materializedSkillNames: () => [],
      availability: () => undefined,
      isRefreshing: (serverId) => serverId === refreshingId
    })

    const servers = (await service.listConnectors()).customServers

    expect(servers.find((server) => server.id === refreshingId)).toMatchObject({ checking: true })
    expect(servers.find((server) => server.id === settledId)?.checking).toBeUndefined()
  })

  it('rejects duplicate and built-in custom connector names', async () => {
    await addCustomServer({
      name: 'example-server',
      transport: 'stdio',
      command: 'example-mcp'
    })

    await expect(
      addCustomServer({
        name: 'example-server',
        displayName: 'Another label',
        transport: 'stdio',
        command: 'another-mcp'
      })
    ).rejects.toThrow('already exists')
    await expect(
      addCustomServer({ name: 'chemistry', transport: 'stdio', command: 'example-mcp' })
    ).rejects.toThrow('reserved by a built-in connector')
  })

  it('separates the display name from the immutable invocation name', async () => {
    const snapshot = await addCustomServer({
      name: 'example-oauth-e2e',
      displayName: 'Example OAuth E2E',
      transport: 'streamable_http',
      url: 'https://mcp.example.test'
    })

    expect(snapshot.customServers[0]).toMatchObject({
      name: 'example-oauth-e2e',
      displayName: 'Example OAuth E2E'
    })
    await expect(
      addCustomServer({
        name: 'example-oauth-e2e',
        displayName: 'Another display name',
        transport: 'stdio',
        command: 'example-mcp'
      })
    ).rejects.toThrow('already exists')
  })

  it('allows display labels to match stored local IDs', async () => {
    const existing = await addCustomServer({
      name: 'stable-route',
      displayName: 'legacy-route',
      transport: 'stdio',
      command: 'example-mcp'
    })

    const added = await addCustomServer({
      name: 'legacy-route',
      displayName: existing.customServers[0].id,
      transport: 'stdio',
      command: 'example-mcp'
    })
    expect(added.customServers.map((server) => server.name)).toEqual(
      expect.arrayContaining(['legacy-route', 'stable-route'])
    )
  })

  it('fails closed when a legacy Connector derives a bundled route', async () => {
    await repository.addCustomServer({
      id: 'legacy-reserved-route',
      name: 'Chemistry!',
      transport: 'stdio',
      enabled: true,
      command: 'legacy-command'
    } as never)

    const snapshot = await service.listConnectors()
    expect(snapshot.customServers[0]).toMatchObject({
      name: 'chemistry',
      displayName: 'Chemistry!',
      enabled: true,
      availability: 'unavailable'
    })
  })

  it('fails closed when legacy Connectors derive the same route', async () => {
    await repository.addCustomServer({
      id: 'legacy-duplicate-a',
      name: 'Duplicate MCP',
      transport: 'stdio',
      enabled: true,
      command: 'first-command'
    } as never)
    await repository.addCustomServer({
      id: 'legacy-duplicate-b',
      name: 'Duplicate-MCP!',
      transport: 'stdio',
      enabled: true,
      command: 'second-command'
    } as never)

    const snapshot = await service.listConnectors()
    expect(snapshot.customServers).toHaveLength(2)
    expect(snapshot.customServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ enabled: true, availability: 'unavailable' }),
        expect.objectContaining({ enabled: true, availability: 'unavailable' })
      ])
    )
  })

  it('keeps persisted identity conflicts visible but unavailable', async () => {
    const baseline = await repository.getSettings()
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        ...baseline,
        connectors: {
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'duplicate-id',
              name: 'duplicate-one',
              displayName: 'Duplicate one',
              transport: 'stdio',
              command: 'first-command',
              enabled: true
            },
            {
              id: 'duplicate-id',
              name: 'duplicate-two',
              displayName: 'Duplicate two',
              transport: 'stdio',
              command: 'second-command',
              enabled: true
            },
            {
              id: 'chemistry',
              name: 'built-in-id-collision',
              displayName: 'Built-in ID collision',
              transport: 'stdio',
              command: 'third-command',
              enabled: true
            },
            {
              id: 'cross-id',
              name: 'cross-name',
              displayName: 'Cross one',
              transport: 'stdio',
              command: 'fourth-command',
              enabled: true
            },
            {
              id: 'cross-name',
              name: 'cross-other',
              displayName: 'Cross two',
              transport: 'stdio',
              command: 'fifth-command',
              enabled: true
            },
            {
              id: 'Invalid ID',
              name: 'invalid-id-format',
              displayName: 'Invalid ID format',
              transport: 'stdio',
              command: 'sixth-command',
              enabled: true
            }
          ]
        }
      })
    )
    service = new ConnectorSettingsModule(new SettingsRepository(dir))

    const snapshot = await service.listConnectors()

    expect(snapshot.customServers).toHaveLength(6)
    expect(snapshot.customServers.every((server) => server.availability === 'unavailable')).toBe(
      true
    )
  })

  it('exports only credential names and validates imports against installed connectors', async () => {
    const snapshot = await addHistoricalCustomServer({
      id: 'internal-export-id',
      name: 'example-export',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/research-mcp'],
      env: { API_TOKEN: 'must-not-export' }
    })

    const result = await service.buildCustomServerTemplateExport(snapshot.customServers[0].id)
    expect(result.preview).toMatchObject({ ready: true, connectorId: snapshot.customServers[0].id })
    expect(result.contents).toContain('API_TOKEN')
    expect(result.contents).not.toContain('must-not-export')
    expect(result.contents).not.toContain('internal-export-id')

    const imported = await service.previewCustomServerTemplateImport(result.contents!)
    expect(imported.ready).toBe(false)
    expect(imported.diagnostics.map((item) => item.code)).toContain(
      'connector-template.duplicate-name'
    )
  })

  it('adds a remote (streamable_http) custom server with a url', async () => {
    const snapshot = await addCustomServer({
      name: 'remote-x',
      transport: 'streamable_http',
      url: 'https://example.com/mcp'
    })
    expect(snapshot.customServers[0]).toMatchObject({
      name: 'remote-x',
      transport: 'streamable_http',
      url: 'https://example.com/mcp'
    })
  })

  it('rejects non-loopback HTTP before persistence', async () => {
    await expect(
      addCustomServer({
        name: 'remote-http-credentials',
        transport: 'streamable_http',
        url: 'http://example.com/mcp'
      })
    ).rejects.toThrow(/HTTPS|loopback/)

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('stores OAuth configuration publicly and OAuth state encrypted', async () => {
    const snapshot = await addHistoricalCustomServer({
      name: 'oauth-x',
      transport: 'streamable_http',
      url: 'https://example.com/mcp',
      oauth: {
        authorizationServerUrl: 'https://example.com/oauth',
        scopes: ['openid', 'profile']
      }
    })
    const id = snapshot.customServers[0].id
    expect(snapshot.customServers[0].enabled).toBe(false)
    expect(snapshot.customServers[0].oauth).toEqual({
      authorizationServerUrl: 'https://example.com/oauth',
      scopes: ['openid', 'profile'],
      hasTokens: false,
      hasClientSecret: false
    })
    expect(snapshot.customServers[0].availability).toBe('unauthenticated')
    await expect(service.setCustomServerEnabled({ id, enabled: true })).rejects.toThrow('Sign in')

    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'oauth-access', token_type: 'Bearer' }
    })
    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).not.toContain('oauth-access')
    expect(storedJson).toContain('oauthRef')

    const resolved = (await service.getConnectors())?.customMcpServers?.[0]
    expect(resolved?.oauthState?.tokens?.access_token).toBe('oauth-access')
    const connected = (await service.listConnectors()).customServers[0]
    expect(connected.oauth?.hasTokens).toBe(true)
    expect(connected.availability).toBeUndefined()
    expect(connected.enabled).toBe(false)

    const enabled = await service.setCustomServerEnabled({ id, enabled: true })
    expect(enabled.customServers[0].enabled).toBe(true)
  })

  it('does not let a stale OAuth save replace a concurrent configuration edit', async () => {
    const added = await addHistoricalCustomServer({
      name: 'oauth-config-race',
      transport: 'streamable_http',
      url: 'https://old.example/mcp',
      oauth: { authorizationServerUrl: 'https://old.example/oauth' }
    })
    const id = added.customServers[0].id
    const updateCustomServerOAuthState = repository.updateCustomServerOAuthState.bind(repository)
    let releaseStaleSave!: () => void
    const staleSaveReleased = new Promise<void>((resolve) => {
      releaseStaleSave = resolve
    })
    let markStaleSaveStarted!: () => void
    const staleSaveStarted = new Promise<void>((resolve) => {
      markStaleSaveStarted = resolve
    })
    let intercepted = false
    vi.spyOn(repository, 'updateCustomServerOAuthState').mockImplementation(
      async (serverId, expectedFingerprint, expectedClientSecretRef, oauthRef) => {
        if (!intercepted && oauthRef) {
          intercepted = true
          markStaleSaveStarted()
          await staleSaveReleased
        }
        return updateCustomServerOAuthState(
          serverId,
          expectedFingerprint,
          expectedClientSecretRef,
          oauthRef
        )
      }
    )

    const staleSave = service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'stale-token', token_type: 'Bearer' }
    })
    await staleSaveStarted
    await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://new.example/mcp',
      oauth: { authorizationServerUrl: 'https://new.example/oauth' }
    })
    releaseStaleSave()
    await staleSave

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.url).toBe('https://new.example/mcp')
    expect(stored?.oauth?.authorizationServerUrl).toBe('https://new.example/oauth')
    expect(stored?.oauthRef).toBeUndefined()
  })

  it('discards a stale OAuth save when only the client secret changed', async () => {
    const added = await addHistoricalCustomServer({
      name: 'oauth-client-secret-race',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        clientSecret: 'old-client-secret'
      }
    })
    const id = added.customServers[0].id
    const updateCustomServerOAuthState = repository.updateCustomServerOAuthState.bind(repository)
    let releaseStaleSave!: () => void
    const staleSaveReleased = new Promise<void>((resolve) => {
      releaseStaleSave = resolve
    })
    let markStaleSaveStarted!: () => void
    const staleSaveStarted = new Promise<void>((resolve) => {
      markStaleSaveStarted = resolve
    })
    vi.spyOn(repository, 'updateCustomServerOAuthState').mockImplementation(
      async (serverId, expectedFingerprint, expectedClientSecretRef, oauthRef) => {
        if (oauthRef) {
          markStaleSaveStarted()
          await staleSaveReleased
        }
        return updateCustomServerOAuthState(
          serverId,
          expectedFingerprint,
          expectedClientSecretRef,
          oauthRef
        )
      }
    )

    const staleSave = service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'stale-token', token_type: 'Bearer' }
    })
    await staleSaveStarted
    await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        clientSecret: 'new-client-secret'
      }
    })
    releaseStaleSave()
    await staleSave

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthRef).toBeUndefined()
    expect((await service.getConnectors())?.customMcpServers?.[0].oauthClientSecret).toBe(
      'new-client-secret'
    )
  })

  it('stores a pre-registered client secret as an encrypted ref and applies explicit edit semantics', async () => {
    const added = await addHistoricalCustomServer({
      name: 'oauth-static',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        clientSecret: 'local-client-secret',
        redirectUri: 'http://127.0.0.1:8080/callback'
      }
    })
    const id = added.customServers[0].id

    expect(added.customServers[0].oauth).toEqual({
      authorizationServerUrl: 'https://auth.example.test',
      clientId: 'registered-client',
      redirectUri: 'http://127.0.0.1:8080/callback',
      hasTokens: false,
      hasClientSecret: true
    })
    expect(JSON.stringify(added)).not.toContain('local-client-secret')
    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).toContain('oauthClientSecretRef')
    expect(storedJson).toContain('registered-client')
    expect(storedJson).toContain('http://127.0.0.1:8080/callback')
    expect(storedJson).not.toContain('local-client-secret')
    expect((await service.getConnectors())?.customMcpServers?.[0].oauthClientSecret).toBe(
      'local-client-secret'
    )
    const exported = await service.buildCustomServerTemplateExport(id)
    expect(exported.contents).not.toContain('local-client-secret')
    expect(JSON.parse(exported.contents!).schema_version).toBe(1)
    expect(JSON.parse(exported.contents!).oauth).toEqual({
      authorization_server_url: 'https://auth.example.test',
      client_id: 'registered-client',
      redirect_uri: 'http://127.0.0.1:8080/callback'
    })
    expect(JSON.parse(exported.contents!).required_secrets).toEqual({
      oauth_client_secret: true
    })

    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'static-token', token_type: 'Bearer' }
    })
    await service.updateCustomServer({
      id,
      displayName: 'Renamed static client',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        redirectUri: 'http://127.0.0.1:8080/callback'
      }
    })
    let stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthClientSecretRef).toBeDefined()
    expect(stored?.oauthRef).toBeDefined()

    const cleared = await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        redirectUri: 'http://127.0.0.1:8080/callback',
        clientSecret: null
      }
    })
    stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthClientSecretRef).toBeUndefined()
    expect(stored?.oauthRef).toBeUndefined()
    expect(cleared.customServers[0].oauth?.hasClientSecret).toBe(false)
  })

  it('rejects embedded OAuth registration when adding a Connector', async () => {
    await expect(
      addCustomServer({
        name: 'oauth-static-without-issuer',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { clientId: 'registered-client' }
      })
    ).rejects.toThrow('New Connectors must use shared Credentials')
  })

  it('clears a saved client secret when its bound authorization-server issuer changes', async () => {
    const added = await addHistoricalCustomServer({
      name: 'oauth-static-issuer-change',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth-one.example.test',
        clientId: 'registered-client',
        clientSecret: 'issuer-bound-secret'
      }
    })
    const id = added.customServers[0].id
    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'issuer-token', token_type: 'Bearer' }
    })

    const updated = await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        authorizationServerUrl: 'https://auth-two.example.test',
        clientId: 'registered-client'
      }
    })

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthClientSecretRef).toBeUndefined()
    expect(stored?.oauthRef).toBeUndefined()
    expect(updated.customServers[0]).toMatchObject({
      enabled: false,
      oauth: { hasClientSecret: false, hasTokens: false }
    })
  })

  it('clears OAuth credentials when the remote endpoint changes', async () => {
    const added = await addHistoricalCustomServer({
      name: 'oauth-endpoint',
      transport: 'streamable_http',
      url: 'https://one.example/mcp',
      oauth: { scopes: ['openid'] }
    })
    const id = added.customServers[0].id
    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'endpoint-token', token_type: 'Bearer' }
    })
    await service.setCustomServerEnabled({ id, enabled: true })

    const updated = await service.updateCustomServer({
      id,
      transport: 'streamable_http',
      url: 'https://two.example/mcp'
    })

    expect(updated.customServers[0]).toMatchObject({
      url: 'https://two.example/mcp',
      enabled: false,
      availability: 'unauthenticated',
      oauth: { hasTokens: false }
    })
    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauthRef).toBeUndefined()
  })

  it('clears OAuth when switching a remote Connector to local transport', async () => {
    const added = await addHistoricalCustomServer({
      name: 'oauth-to-local',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: { scopes: ['openid'] }
    })
    const id = added.customServers[0].id
    await service.saveCustomServerOAuthState(id, {
      tokens: { access_token: 'remote-token', token_type: 'Bearer' }
    })

    const updated = await service.updateCustomServer({
      id,
      transport: 'stdio',
      command: 'local-command'
    })

    expect(updated.customServers[0]).toMatchObject({
      transport: 'stdio',
      command: 'local-command'
    })
    expect(updated.customServers[0].oauth).toBeUndefined()
    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored?.oauth).toBeUndefined()
    expect(stored?.oauthRef).toBeUndefined()
  })

  it('rejects embedded authentication when adding a Connector', async () => {
    await expect(
      addCustomServer({
        name: 'invalid-auth',
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer stale' },
        oauth: { scopes: ['openid'] }
      })
    ).rejects.toThrow('New Connectors must use shared Credentials')
  })

  it('rejects credential-bearing arguments when adding a custom server', async () => {
    await expect(
      addCustomServer({
        name: 'unsafe-arguments',
        transport: 'stdio',
        command: 'example-mcp',
        args: ['--token=plaintext-secret']
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('rejects a credential-bearing header argument when adding a custom server', async () => {
    await expect(
      addCustomServer({
        name: 'unsafe-header-argument',
        transport: 'stdio',
        command: 'example-mcp',
        args: ['--header', 'Authorization: Bearer plaintext-secret']
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('rejects a credential-bearing custom header argument when adding a custom server', async () => {
    await expect(
      addCustomServer({
        name: 'unsafe-custom-header-argument',
        transport: 'stdio',
        command: 'example-mcp',
        args: ['--header', 'X-API-Token: plaintext-secret']
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it.each([
    [
      'client metadata URL',
      { clientMetadataUrl: 'https://oauth-user:oauth-secret@client.example.test/metadata' }
    ],
    [
      'authorization server URL',
      { authorizationServerUrl: 'https://auth.example.test?api_key=oauth-secret' }
    ],
    [
      'redirect URI',
      {
        authorizationServerUrl: 'https://auth.example.test',
        clientId: 'registered-client',
        redirectUri: 'http://127.0.0.1/callback?access_token=oauth-secret'
      }
    ]
  ])('rejects credentials embedded in an OAuth %s', async (_description, oauth) => {
    await expect(
      addCustomServer({
        name: 'unsafe-oauth-url',
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth
      })
    ).rejects.toThrow('New Connectors must use shared Credentials')

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('rejects a credential-bearing header argument after renderer whitespace tokenization', async () => {
    await expect(
      addCustomServer({
        name: 'unsafe-tokenized-header-argument',
        transport: 'stdio',
        command: 'example-mcp',
        args: ['--header', 'Authorization:', 'Bearer', 'plaintext-secret']
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it.each([
    ['split credential flag', ['--auth-token', 'plaintext-secret']],
    ['split curl user credentials', ['--user', 'researcher:plaintext-secret']],
    ['inline curl user credentials', ['--user=researcher:plaintext-secret']],
    ['short curl user credentials', ['-uresearcher:plaintext-secret']],
    [
      'credential-bearing URL argument',
      ['--endpoint', 'https://mcp.example.test?auth_token=plaintext-secret']
    ]
  ])('rejects a %s when adding a custom server', async (_description, args) => {
    await expect(
      addCustomServer({
        name: 'unsafe-argument-form',
        transport: 'stdio',
        command: 'example-mcp',
        args
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it.each([
    'https://user:plaintext-secret@mcp.example.test',
    'https://mcp.example.test?api_key=plaintext-secret',
    'https://mcp.example.test?auth_token=plaintext-secret'
  ])('rejects a credential-bearing URL when updating a custom server', async (url) => {
    const added = await addCustomServer({
      name: 'unsafe-url-update',
      transport: 'streamable_http',
      url: 'https://mcp.example.test'
    })

    await expect(
      service.updateCustomServer({
        id: added.customServers[0].id,
        transport: 'streamable_http',
        url
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect((await repository.getSettings()).connectors?.customMcpServers?.[0]?.url).toBe(
      'https://mcp.example.test'
    )
  })

  it('rejects a credential-bearing OAuth URL when updating a custom server', async () => {
    const added = await addHistoricalCustomServer({
      name: 'unsafe-oauth-url-update',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: { authorizationServerUrl: 'https://auth.example.test' }
    })

    await expect(
      service.updateCustomServer({
        id: added.customServers[0].id,
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { authorizationServerUrl: 'https://auth.example.test?api_key=oauth-secret' }
      })
    ).rejects.toThrow(/encrypted environment or header fields/i)

    expect(
      (await repository.getSettings()).connectors?.customMcpServers?.[0]?.oauth
        ?.authorizationServerUrl
    ).toBe('https://auth.example.test')
  })

  it('rejects an invalid custom server (stdio without a command)', async () => {
    await expect(addCustomServer({ name: 'bad', transport: 'stdio' })).rejects.toThrow(
      /Invalid custom connector/
    )
  })

  it('rejects raw custom-server secrets before persistence', async () => {
    await expect(
      addCustomServer({
        name: 'secretful',
        transport: 'stdio',
        command: 'run',
        env: { TOKEN: 'super-secret' }
      })
    ).rejects.toThrow('New Connectors must use shared Credentials')
    expect((await repository.getSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('rejects private credentials when updating a newly created Connector', async () => {
    const added = await addCustomServer({
      name: 'shared-only-update',
      transport: 'stdio',
      command: 'run'
    })
    const id = added.customServers[0].id

    await expect(
      service.updateCustomServer({
        id,
        transport: 'stdio',
        command: 'run',
        env: { TOKEN: 'super-secret' }
      })
    ).rejects.toThrow('Environment values must use shared Credentials')
    await expect(
      service.updateCustomServer({
        id,
        transport: 'streamable_http',
        url: 'https://mcp.example.test',
        oauth: { scopes: ['read'] }
      })
    ).rejects.toThrow('OAuth settings must use a shared Credential')

    const stored = (await repository.getSettings()).connectors?.customMcpServers?.[0]
    expect(stored).toEqual(expect.objectContaining({ id, command: 'run', transport: 'stdio' }))
    expect(stored).not.toHaveProperty('env')
    expect(stored).not.toHaveProperty('envRefs')
    expect(stored).not.toHaveProperty('oauth')
    expect(stored).not.toHaveProperty('oauthRef')
  })

  it('redacts credential-bearing fields from historical custom-server views', async () => {
    await repository.addCustomServer({
      id: 'legacy-args-secret',
      name: 'legacy-args-secret',
      displayName: 'Legacy args secret',
      transport: 'stdio',
      command: 'example-mcp',
      args: ['--token=legacy-plaintext-secret'],
      enabled: true
    })
    await repository.addCustomServer({
      id: 'legacy-url-secret',
      name: 'legacy-url-secret',
      displayName: 'Legacy URL secret',
      transport: 'streamable_http',
      url: 'https://mcp.example.test?api_key=legacy-plaintext-secret',
      enabled: true
    })

    const snapshot = await service.listConnectors()
    expect(snapshot.customServers).toEqual([
      expect.objectContaining({
        name: 'legacy-args-secret',
        args: undefined,
        enabled: true,
        availability: 'credential_unavailable'
      }),
      expect.objectContaining({
        name: 'legacy-url-secret',
        url: undefined,
        enabled: true,
        availability: 'credential_unavailable'
      })
    ])
    expect(JSON.stringify(snapshot)).not.toContain('legacy-plaintext-secret')

    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).toContain('legacy-plaintext-secret')
  })

  it('redacts credential-bearing OAuth URLs from historical custom-server views', async () => {
    await repository.addCustomServer({
      id: 'legacy-oauth-url-secret',
      name: 'legacy-oauth-url-secret',
      displayName: 'Legacy OAuth URL secret',
      transport: 'streamable_http',
      url: 'https://mcp.example.test',
      oauth: {
        clientMetadataUrl: 'https://oauth-user:client-secret@client.example.test/metadata',
        authorizationServerUrl: 'https://auth.example.test?api_key=issuer-secret',
        clientId: 'registered-client',
        redirectUri: 'http://127.0.0.1/callback?access_token=redirect-secret'
      },
      enabled: true
    })

    const [server] = (await service.listConnectors()).customServers
    expect(server).toMatchObject({
      name: 'legacy-oauth-url-secret',
      enabled: true,
      availability: 'credential_unavailable'
    })
    expect(server.oauth).not.toHaveProperty('clientMetadataUrl')
    expect(server.oauth).not.toHaveProperty('authorizationServerUrl')
    expect(server.oauth).not.toHaveProperty('redirectUri')
    expect(JSON.stringify(server)).not.toMatch(/client-secret|issuer-secret|redirect-secret/)

    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).toMatch(/client-secret|issuer-secret|redirect-secret/)
  })

  it('redacts curl-style user credentials from historical custom-server views', async () => {
    await repository.addCustomServer({
      id: 'legacy-user-credentials',
      name: 'legacy-user-credentials',
      displayName: 'Legacy user credentials',
      transport: 'stdio',
      command: 'example-mcp',
      args: ['--user', 'legacy-user:legacy-password'],
      enabled: true
    })

    const [server] = (await service.listConnectors()).customServers
    expect(server).toMatchObject({
      name: 'legacy-user-credentials',
      args: undefined,
      enabled: true,
      availability: 'credential_unavailable'
    })
    expect(JSON.stringify(server)).not.toContain('legacy-password')

    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).toContain('legacy-password')
  })

  it('migrates legacy plaintext custom-server secrets when secure storage is available', async () => {
    await repository.addCustomServer({
      id: 'legacy',
      name: 'legacy',
      displayName: 'Legacy',
      transport: 'streamable_http',
      enabled: true,
      url: 'https://example.test/mcp',
      env: { TOKEN: 'legacy-env-secret' },
      headers: { Authorization: 'legacy-header-secret' }
    })

    const server = (await service.getConnectors())?.customMcpServers?.[0]
    expect(server?.env).toEqual({ TOKEN: 'legacy-env-secret' })
    expect(server?.headers).toEqual({ Authorization: 'legacy-header-secret' })

    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).not.toContain('legacy-env-secret')
    expect(storedJson).not.toContain('legacy-header-secret')
    expect(storedJson).toContain('envRefs')
    expect(storedJson).toContain('headerRefs')
  })

  it('does not fail a legacy secret read when deletion wins the migration race', async () => {
    await repository.addCustomServer({
      id: 'legacy-race',
      name: 'legacy-race',
      displayName: 'Legacy race',
      transport: 'stdio',
      enabled: true,
      command: 'legacy-command',
      env: { TOKEN: 'legacy-secret' }
    })
    const readSettings = repository.getSettings.bind(repository)
    vi.spyOn(repository, 'getSettings').mockImplementationOnce(async () => {
      const staleSettings = await readSettings()
      await repository.removeCustomServer('legacy-race')
      return staleSettings
    })

    await expect(service.getConnectors()).resolves.toMatchObject({
      customMcpServers: [expect.objectContaining({ id: 'legacy-race' })]
    })
    expect((await readSettings()).connectors?.customMcpServers ?? []).toEqual([])
  })

  it('keeps legacy secrets readable but rejects new secret writes without secure storage', async () => {
    await repository.addCustomServer({
      id: 'legacy',
      name: 'legacy',
      displayName: 'Legacy',
      transport: 'stdio',
      enabled: true,
      command: 'old-command',
      env: { TOKEN: 'keep-me' }
    })
    keychain.available = false

    expect((await service.getConnectors())?.customMcpServers?.[0]?.env).toEqual({
      TOKEN: 'keep-me'
    })
    await service.updateCustomServer({
      id: 'legacy',
      transport: 'stdio',
      command: 'new-command'
    })
    await expect(
      addCustomServer({
        name: 'new-secret',
        transport: 'stdio',
        command: 'run',
        env: { TOKEN: 'must-not-persist' }
      })
    ).rejects.toThrow('New Connectors must use shared Credentials')

    const storedJson = await readFile(join(dir, 'settings.json'), 'utf8')
    expect(storedJson).toContain('keep-me')
    expect(storedJson).toContain('new-command')
    expect(storedJson).not.toContain('must-not-persist')
  })

  it('edits a custom server, keeping its name and preserving omitted env', async () => {
    const added = await addHistoricalCustomServer({
      name: 'my-mem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'old'],
      env: { TOKEN: 'keep-me' }
    })
    const id = added.customServers[0].id

    // Change command/args but omit env — the stored secret env must be preserved.
    const updated = await service.updateCustomServer({
      id,
      transport: 'stdio',
      command: 'node',
      args: ['server.js']
    })
    const view = updated.customServers.find((s) => s.id === id)
    expect(view?.name).toBe('my-mem') // name is immutable
    expect(view?.command).toBe('node')
    expect(view?.args).toEqual(['server.js'])

    const stored = (await service.getConnectors())?.customMcpServers?.find((s) => s.id === id)
    expect(stored?.env).toEqual({ TOKEN: 'keep-me' })
  })

  it('invalidates remembered authority before persisting a security-sensitive server edit', async () => {
    const added = await addCustomServer({
      name: 'mutable-endpoint',
      transport: 'stdio',
      command: 'old-command',
      args: ['serve']
    })
    const id = added.customServers[0].id
    const commit = vi.fn()
    const rollback = vi.fn()
    const invalidate = vi.fn(async (serverId: string) => {
      const stored = (await service.getConnectors())?.customMcpServers?.find(
        (server) => server.id === serverId
      )
      expect(stored?.command).toBe('old-command')
      return { commit, rollback }
    })

    await service.updateCustomServer(
      {
        id,
        transport: 'streamable_http',
        url: 'https://new.example/mcp'
      },
      invalidate
    )

    expect(invalidate).toHaveBeenCalledOnce()
    expect(invalidate).toHaveBeenCalledWith(id)
    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ id, url: 'https://new.example/mcp' })
    expect(rollback).not.toHaveBeenCalled()
    const stored = (await service.getConnectors())?.customMcpServers?.find(
      (server) => server.id === id
    )
    expect(stored?.transport).toBe('streamable_http')
    expect(stored?.url).toBe('https://new.example/mcp')
  })

  it('keeps grants for display-only edits and fails closed when invalidation fails', async () => {
    const added = await addCustomServer({
      name: 'stable-endpoint',
      description: 'Before',
      transport: 'stdio',
      command: 'stable-command'
    })
    const id = added.customServers[0].id
    const invalidate = vi.fn().mockResolvedValue(undefined)

    await service.updateCustomServer(
      {
        id,
        description: 'After',
        transport: 'stdio',
        command: 'stable-command'
      },
      invalidate
    )
    expect(invalidate).not.toHaveBeenCalled()

    invalidate.mockRejectedValueOnce(new Error('grant cleanup failed'))
    await expect(
      service.updateCustomServer(
        {
          id,
          description: 'After',
          transport: 'stdio',
          command: 'replacement-command'
        },
        invalidate
      )
    ).rejects.toThrow('grant cleanup failed')

    const stored = (await service.getConnectors())?.customMcpServers?.find(
      (server) => server.id === id
    )
    expect(stored?.description).toBe('After')
    expect(stored?.command).toBe('stable-command')
  })

  it('rolls back the custom-server security barrier when persistence fails', async () => {
    const added = await addCustomServer({
      name: 'rollback-endpoint',
      transport: 'stdio',
      command: 'old-command'
    })
    const id = added.customServers[0].id
    const commit = vi.fn()
    const rollback = vi.fn()
    vi.spyOn(repository, 'updateCustomServer').mockRejectedValueOnce(new Error('write failed'))

    await expect(
      service.updateCustomServer({ id, transport: 'stdio', command: 'new-command' }, async () => ({
        commit,
        rollback
      }))
    ).rejects.toThrow('write failed')

    expect(commit).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('rejects editing an unknown custom server', async () => {
    await expect(
      service.updateCustomServer({ id: 'nope', transport: 'stdio', command: 'x' })
    ).rejects.toThrow(/Unknown custom connector/)
  })
})
