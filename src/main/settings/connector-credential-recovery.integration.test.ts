import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsRepository } from './repository'
import { SettingsService } from './service'
import { DeviceCredentialStore } from './device-credentials'
import { ConnectorSettingsWorkflows } from './workflows/connectors'
import { ConnectorService } from '../connectors/service'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`cipher:${text}`),
    decryptString: (buffer: Buffer) => buffer.toString().slice('cipher:'.length)
  },
  app: { getPath: () => '/home', getAppPath: () => '/home/no-such-app-root', isPackaged: false }
}))

describe('shared credential recovery', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'connector-recovery-'))
    return async () => {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each(['projection', 'client-reset'] as const)(
    'C03 resumes dispatch after a committed token rotation fails %s and Retry succeeds',
    async (failure) => {
      const settings = new SettingsService({
        repository: new SettingsRepository(dir),
        configRoot: dir
      })
      const { createdCredential } = await settings.createDeviceCredential({
        displayName: 'Shared token',
        kind: 'token',
        secret: 'old-token'
      })
      await settings.addCustomServer({
        id: 'consumer',
        name: 'consumer',
        displayName: 'Consumer',
        transport: 'stdio',
        command: 'unused',
        envCredentialIds: { API_TOKEN: createdCredential.id }
      })
      let current = await settings.getConnectors()
      const call = vi.fn(async () => ({ ok: true }))
      const runtime = new ConnectorService({
        getConnectors: () => current,
        getConnectorsFresh: () => settings.getConnectors(),
        resolveApiKey: () => undefined,
        mcpClientManager: { listTools: async () => [{ name: 'read' }], call }
      })
      const refresh = vi.fn(async () => {
        current = await settings.getConnectors()
      })
      const reset = vi.fn(async () => undefined)
      const workflows = new ConnectorSettingsWorkflows(settings, {
        beginCustomServerSecurityChange: (id) => runtime.beginCustomServerSecurityChange(id),
        resetCustomServerClient: reset,
        clearCustomServerFailure: (id) => runtime.clearCustomServerFailure(id),
        refreshConnectorSkillDocs: refresh,
        invalidatePermissionProjection: vi.fn(),
        requestSkillsReload: vi.fn(),
        pruneCustomServerPermissions: vi.fn(async () => undefined),
        removeTagsForConnector: vi.fn(async () => undefined)
      })
      await expect(runtime.call('consumer', 'read', {}, { origin: 'internal' })).resolves.toEqual({
        ok: true
      })
      call.mockClear()
      if (failure === 'projection')
        refresh.mockRejectedValueOnce(new Error('injected document refresh failure'))
      else
        reset
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('injected client reset failure'))
      await expect(
        workflows.updateDeviceCredential({ id: createdCredential.id, secret: 'new-token' })
      ).rejects.toThrow()
      // A newly constructed store proves the successful durable write, independent of cached views.
      await expect(
        new DeviceCredentialStore(dir).resolveStatic(createdCredential.id, {
          kind: 'env',
          name: 'API_TOKEN'
        })
      ).resolves.toBe('new-token')
      await expect(runtime.call('consumer', 'read', {}, { origin: 'internal' })).rejects.toThrow(
        'connector_configuration_changed'
      )
      expect(call).not.toHaveBeenCalled()
      // A failed retry must keep the barrier and remain recoverable.
      reset.mockRejectedValueOnce(new Error('retry reset failed'))
      await expect(workflows.retryCustomServer({ id: 'consumer' })).rejects.toThrow(
        'retry reset failed'
      )
      await expect(runtime.call('consumer', 'read', {}, { origin: 'internal' })).rejects.toThrow(
        'connector_configuration_changed'
      )
      await expect(workflows.retryCustomServer({ id: 'consumer' })).resolves.toHaveProperty(
        'customServers'
      )
      expect(current?.customMcpServers?.[0]?.env).toEqual({ API_TOKEN: 'new-token' })
      await expect(runtime.call('consumer', 'read', {}, { origin: 'internal' })).resolves.toEqual({
        ok: true
      })
      expect(call).toHaveBeenCalledOnce()
    }
  )
  it('C03 does not let a delayed retry release a newer security barrier', async () => {
    const settings = new SettingsService({
      repository: new SettingsRepository(dir),
      configRoot: dir
    })
    const { createdCredential } = await settings.createDeviceCredential({
      displayName: 'Token',
      kind: 'token',
      secret: 'old'
    })
    await settings.addCustomServer({
      id: 'consumer',
      name: 'consumer',
      displayName: 'Consumer',
      transport: 'stdio',
      command: 'unused',
      envCredentialIds: { API_TOKEN: createdCredential.id }
    })
    let current = await settings.getConnectors()
    const call = vi.fn(async () => ({ ok: true }))
    const runtime = new ConnectorService({
      getConnectors: () => current,
      getConnectorsFresh: () => settings.getConnectors(),
      resolveApiKey: () => undefined,
      mcpClientManager: { listTools: async () => [{ name: 'read' }], call }
    })
    const refresh = vi.fn(async () => {
      current = await settings.getConnectors()
    })
    const workflows = new ConnectorSettingsWorkflows(settings, {
      beginCustomServerSecurityChange: (id) => runtime.beginCustomServerSecurityChange(id),
      resetCustomServerClient: vi.fn(async () => undefined),
      clearCustomServerFailure: (id) => runtime.clearCustomServerFailure(id),
      refreshConnectorSkillDocs: refresh,
      invalidatePermissionProjection: vi.fn(),
      requestSkillsReload: vi.fn(),
      pruneCustomServerPermissions: vi.fn(async () => undefined),
      removeTagsForConnector: vi.fn(async () => undefined)
    })
    refresh.mockRejectedValueOnce(new Error('refresh failed'))
    await expect(
      workflows.updateDeviceCredential({ id: createdCredential.id, secret: 'new' })
    ).rejects.toThrow('Credential changes were saved')
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    refresh.mockImplementationOnce(() => waiting)
    const retry = workflows.retryCustomServer({ id: 'consumer' })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    const newer = runtime.beginCustomServerSecurityChange('consumer')
    release()
    await retry
    current = await settings.getConnectors()
    await expect(runtime.call('consumer', 'read', {}, { origin: 'internal' })).rejects.toThrow(
      'connector_configuration_changed'
    )
    expect(call).not.toHaveBeenCalled()
    newer.commit(current!.customMcpServers![0])
    await expect(runtime.call('consumer', 'read', {}, { origin: 'internal' })).resolves.toEqual({
      ok: true
    })
  })

  it.each(['credential', 'connector'] as const)(
    'C03 recovers shared OAuth disconnect through the %s entry',
    async (entry) => {
      const settings = new SettingsService({
        repository: new SettingsRepository(dir),
        configRoot: dir
      })
      const { createdCredential } = await settings.createDeviceCredential({
        displayName: 'Shared OAuth',
        kind: 'oauth',
        resourceUri: 'https://mcp.example.test/',
        transport: 'streamable_http',
        oauth: {}
      })
      settings.setDeviceCredentialAuthenticator(
        async () => undefined,
        async () => undefined,
        async () => undefined
      )
      const credentials = new DeviceCredentialStore(dir)
      await credentials.saveOAuthState(createdCredential.id, {
        tokens: { access_token: 'token', token_type: 'Bearer' }
      })
      for (const id of ['first', 'second']) {
        await settings.addCustomServer({
          id,
          name: id,
          displayName: id,
          transport: 'streamable_http',
          url: 'https://mcp.example.test/',
          oauthCredentialId: createdCredential.id
        })
        await settings.setCustomServerEnabled({ id, enabled: true })
      }
      let current = await settings.getConnectors()
      const call = vi.fn(async () => ({ ok: true }))
      const runtime = new ConnectorService({
        getConnectors: () => current,
        getConnectorsFresh: () => settings.getConnectors(),
        resolveApiKey: () => undefined,
        mcpClientManager: { listTools: async () => [{ name: 'read' }], call }
      })
      const refresh = vi.fn(async () => {
        current = await settings.getConnectors()
      })
      const workflows = new ConnectorSettingsWorkflows(settings, {
        beginCustomServerSecurityChange: (id) => runtime.beginCustomServerSecurityChange(id),
        resetCustomServerClient: vi.fn(async () => undefined),
        clearCustomServerFailure: (id) => runtime.clearCustomServerFailure(id),
        refreshConnectorSkillDocs: refresh,
        invalidatePermissionProjection: vi.fn(),
        requestSkillsReload: vi.fn(),
        pruneCustomServerPermissions: vi.fn(async () => undefined),
        removeTagsForConnector: vi.fn(async () => undefined)
      })
      await expect(runtime.call('first', 'read', {}, { origin: 'internal' })).resolves.toEqual({
        ok: true
      })
      call.mockClear()
      refresh.mockRejectedValueOnce(new Error('refresh failed'))
      await expect(
        entry === 'credential'
          ? workflows.disconnectDeviceCredential({ id: createdCredential.id })
          : workflows.disconnectCustomServer({ id: 'first' })
      ).rejects.toThrow('Credential changes were saved')
      expect(
        (await new DeviceCredentialStore(dir).resolveOAuth(createdCredential.id))?.state?.tokens
      ).toBeUndefined()
      await workflows.retryConnectorProjection()
      for (const id of ['first', 'second']) {
        await expect(runtime.call(id, 'read', {}, { origin: 'internal' })).rejects.toMatchObject({
          category: 'connector_disabled'
        })
      }
      expect(call).not.toHaveBeenCalled()
    }
  )
})
