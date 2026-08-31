import { describe, expect, it, vi } from 'vitest'

import { composeApplicationRuntime } from '../application-runtime'
import { createConnectorApplicationModule, type ConnectorApplicationDeps } from './application'

type TestDoubles = Record<string, ReturnType<typeof vi.fn>>

interface ConnectorApplicationHarness {
  settings: TestDoubles
  mcpClientManager: TestDoubles
  connectorApprovals: TestDoubles
  skillImportApprovals: TestDoubles
  deps: ConnectorApplicationDeps
}

const createHarness = (): ConnectorApplicationHarness => {
  const settings = {
    getConnectors: vi.fn().mockResolvedValue({ customMcpServers: [] }),
    saveCustomServerOAuthState: vi.fn().mockResolvedValue(undefined),
    resolveDeviceOAuthCredential: vi.fn().mockResolvedValue(undefined),
    setCustomServerRuntimeProjectionProvider: vi.fn(),
    setCustomServerAuthenticator: vi.fn(),
    setDeviceCredentialAuthenticator: vi.fn(),
    previewSkillArchive: vi.fn(),
    importSkillArchiveBatch: vi.fn(),
    scanRepoSkills: vi.fn().mockResolvedValue({ skills: [] }),
    importSkill: vi.fn()
  }
  const mcpClientManager = {
    listTools: vi.fn().mockResolvedValue([]),
    call: vi.fn(),
    authenticate: vi.fn().mockResolvedValue(undefined),
    cancelAuthentication: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    closeAll: vi.fn().mockResolvedValue(undefined)
  }
  const connectorApprovals = {
    request: vi.fn().mockResolvedValue('once'),
    respond: vi.fn(),
    getPending: vi.fn().mockReturnValue(null),
    pauseSession: vi.fn(),
    resumeSession: vi.fn()
  }
  const skillImportApprovals = {
    createCancellationGuard: vi
      .fn()
      .mockReturnValue({ signal: new AbortController().signal, isCancelled: () => false }),
    createSessionCancellationGuard: vi
      .fn()
      .mockReturnValue({ signal: new AbortController().signal, isCancelled: () => false }),
    request: vi.fn(),
    respond: vi.fn(),
    replayPending: vi.fn(),
    beginSessionTurn: vi.fn(),
    endSessionTurn: vi.fn(),
    allowSessionTurnAttachment: vi.fn(),
    cancelSession: vi.fn(),
    cancelAll: vi.fn()
  }
  const deps: ConnectorApplicationDeps = {
    settings: settings as unknown as ConnectorApplicationDeps['settings'],
    skillsDir: '/tmp/skills',
    openExternal: vi.fn(),
    notifyStatusChanged: vi.fn(),
    broadcastConnectorApproval: vi.fn(),
    replayConnectorApproval: vi.fn(),
    onConnectorApprovalSettled: vi.fn(),
    broadcastCredentialRequest: vi.fn(),
    replayCredentialRequest: vi.fn(),
    onCredentialRequestSettled: vi.fn(),
    broadcastSkillImportApproval: vi.fn(),
    onSkillImportSettled: vi.fn(),
    onSkillImportLifecycleSettled: vi.fn(),
    uploads: {} as ConnectorApplicationDeps['uploads'],
    fetchImpl: vi.fn() as unknown as typeof fetch,
    resolveApiKey: vi.fn(),
    canRequestCredential: vi.fn().mockReturnValue(true),
    resolveSpecialistProfile: vi.fn().mockResolvedValue(undefined),
    mcpClientManager: mcpClientManager as unknown as NonNullable<
      ConnectorApplicationDeps['mcpClientManager']
    >,
    connectorApprovals: connectorApprovals as unknown as NonNullable<
      ConnectorApplicationDeps['connectorApprovals']
    >,
    skillImportApprovals: skillImportApprovals as unknown as NonNullable<
      ConnectorApplicationDeps['skillImportApprovals']
    >
  }
  return { settings, mcpClientManager, connectorApprovals, skillImportApprovals, deps }
}

describe('Connector application composition', () => {
  it('reuses fakes and closes the MCP manager through runtime disposal', async () => {
    const { settings, mcpClientManager, connectorApprovals, skillImportApprovals, deps } =
      createHarness()
    const runtime = await composeApplicationRuntime(async (modules) => ({
      application: await modules.add(deps, createConnectorApplicationModule)
    }))
    const application = runtime.interfaces.application

    expect(application.mcpClientManager).toBe(mcpClientManager)
    expect(application.connectorApprovals).toBe(connectorApprovals)
    expect(application.skillImportApprovals).toBe(skillImportApprovals)
    expect(application.connectorService).toBeDefined()
    expect(application.runtimeSettings).toBeDefined()
    expect(application.skillImporter).toBeDefined()
    expect(settings.setCustomServerRuntimeProjectionProvider).toHaveBeenCalledOnce()
    expect(settings.setCustomServerAuthenticator).toHaveBeenCalledOnce()
    expect(settings.setDeviceCredentialAuthenticator).toHaveBeenCalledOnce()

    await runtime.dispose()
    expect(mcpClientManager.closeAll).toHaveBeenCalledOnce()
  })

  it('fails closed before OAuth authentication when the client secret cannot be decrypted', async () => {
    const { settings, mcpClientManager, deps } = createHarness()
    settings.getConnectors.mockResolvedValue({
      customMcpServers: [
        {
          id: 'oauth-incomplete',
          name: 'oauth-incomplete',
          displayName: 'OAuth incomplete',
          transport: 'streamable_http',
          url: 'https://mcp.example.test',
          enabled: false,
          oauth: {
            authorizationServerUrl: 'https://auth.example.test',
            clientId: 'registered-client'
          },
          oauthClientSecretRef: 'enc:unavailable'
        }
      ]
    })
    const module = await createConnectorApplicationModule(deps)
    const authenticate = settings.setCustomServerAuthenticator.mock.calls[0][0] as (
      serverId: string
    ) => Promise<void>

    await expect(authenticate('oauth-incomplete')).rejects.toThrow(/credential_unavailable/)
    expect(mcpClientManager.authenticate).not.toHaveBeenCalled()

    await module.dispose?.()
  })

  it('uses the device OAuth credential transport during authentication', async () => {
    const { settings, mcpClientManager, deps } = createHarness()
    settings.resolveDeviceOAuthCredential.mockResolvedValue({
      id: 'shared-oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'sse',
      oauth: { scopes: ['read'] },
      hasClientSecret: false
    })
    const module = await createConnectorApplicationModule(deps)
    const authenticate = settings.setDeviceCredentialAuthenticator.mock.calls[0][0] as (
      credentialId: string
    ) => Promise<void>

    await authenticate('shared-oauth')

    expect(mcpClientManager.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'credential:shared-oauth',
        transport: 'sse',
        url: 'https://mcp.example.test/'
      })
    )
    expect(mcpClientManager.close).toHaveBeenCalledWith('credential:shared-oauth')

    await module.dispose?.()
  })

  it('fails closed before device OAuth authentication when its client secret cannot be decrypted', async () => {
    const { settings, mcpClientManager, deps } = createHarness()
    settings.resolveDeviceOAuthCredential.mockResolvedValue({
      id: 'shared-oauth',
      resourceUri: 'https://mcp.example.test/',
      transport: 'streamable_http',
      oauth: {
        authorizationServerUrl: 'https://auth.example.test/',
        clientId: 'registered-client'
      },
      hasClientSecret: true
    })
    const module = await createConnectorApplicationModule(deps)
    const authenticate = settings.setDeviceCredentialAuthenticator.mock.calls[0][0] as (
      credentialId: string
    ) => Promise<void>

    await expect(authenticate('shared-oauth')).rejects.toThrow(/credential_unavailable/)
    expect(mcpClientManager.authenticate).not.toHaveBeenCalled()

    await module.dispose?.()
  })

  it('captures the immutable custom Connector target and full arguments for approval', async () => {
    const { settings, mcpClientManager, connectorApprovals, deps } = createHarness()
    settings.getConnectors.mockResolvedValue({
      enabledIds: [],
      autoAllowIds: [],
      askToolIds: ['stable-server/lookup'],
      customMcpServers: [
        {
          id: 'server-id',
          name: 'stable-server',
          displayName: 'Duplicate label',
          transport: 'streamable_http',
          url: 'https://mcp.example.test/path',
          enabled: true
        }
      ]
    })
    mcpClientManager.listTools.mockResolvedValue([
      { name: 'lookup', description: 'Look up a record', inputSchema: { type: 'object' } }
    ])
    mcpClientManager.call.mockResolvedValue({ ok: true })
    const module = await createConnectorApplicationModule(deps)
    await module.capability.runtimeSettings.refresh()
    const args = { query: 'x'.repeat(400) }

    await module.capability.connectorService.call('stable-server', 'lookup', args, {
      origin: 'internal'
    })

    expect(connectorApprovals.request).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: 'server-id',
        connectorName: 'stable-server',
        displayName: 'Duplicate label',
        transport: 'streamable_http',
        target: 'https://mcp.example.test',
        argsJson: JSON.stringify(args)
      }),
      undefined
    )
    await module.dispose?.()
  })

  it('bounds oversized approval arguments before broadcasting them', async () => {
    const { settings, mcpClientManager, connectorApprovals, deps } = createHarness()
    settings.getConnectors.mockResolvedValue({
      enabledIds: [],
      autoAllowIds: [],
      askToolIds: ['stable-server/lookup'],
      customMcpServers: [
        {
          id: 'server-id',
          name: 'stable-server',
          displayName: 'Stable server',
          transport: 'streamable_http',
          url: 'https://mcp.example.test/path',
          enabled: true
        }
      ]
    })
    mcpClientManager.listTools.mockResolvedValue([
      { name: 'lookup', description: 'Look up a record', inputSchema: { type: 'object' } }
    ])
    mcpClientManager.call.mockResolvedValue({ ok: true })
    const module = await createConnectorApplicationModule(deps)
    await module.capability.runtimeSettings.refresh()
    const args = { query: 'x'.repeat(70_000) }

    await module.capability.connectorService.call('stable-server', 'lookup', args, {
      origin: 'internal'
    })

    const request = connectorApprovals.request.mock.calls[0][0]
    expect(request.argsJson?.length).toBeLessThan(JSON.stringify(args).length)
    expect(request.argsJsonTruncated).toBe(true)
    await module.dispose?.()
  })

  it('forwards the conversation cancellation signal to GitHub scanning', async () => {
    const { settings, skillImportApprovals, deps } = createHarness()
    const controller = new AbortController()
    skillImportApprovals.createSessionCancellationGuard.mockReturnValue({
      signal: controller.signal,
      isCancelled: () => false
    })
    const runtime = await composeApplicationRuntime(async (modules) => ({
      application: await modules.add(deps, createConnectorApplicationModule)
    }))

    await expect(
      runtime.interfaces.application.skillImporter.request({
        sessionId: 'session-1',
        githubUrl: 'https://github.com/acme/skills'
      })
    ).rejects.toThrow('No importable Skills were found')
    expect(settings.scanRepoSkills).toHaveBeenCalledWith(
      { repo: 'https://github.com/acme/skills' },
      expect.any(AbortSignal)
    )
    const forwardedSignal = settings.scanRepoSkills.mock.calls[0][1] as AbortSignal
    expect(forwardedSignal.aborted).toBe(false)
    controller.abort()
    expect(forwardedSignal.aborted).toBe(true)

    await runtime.dispose()
  })

  it('fails closed when no local credential owner is available', async () => {
    const { deps } = createHarness()
    vi.mocked(deps.canRequestCredential).mockReturnValue(false)
    const module = await createConnectorApplicationModule(deps)

    await expect(
      module.capability.connectorService.call(
        'literature',
        'openalex_search_works',
        { query: 'CRISPR', max_records: 1 },
        { origin: 'internal' }
      )
    ).rejects.toThrow(/credential_required/)
    expect(deps.broadcastCredentialRequest).not.toHaveBeenCalled()
    expect(deps.fetchImpl).not.toHaveBeenCalled()

    await module.dispose?.()
  })

  it('closes the MCP manager when construction fails before runtime ownership', async () => {
    const { settings, mcpClientManager, deps } = createHarness()
    const failure = new Error('settings projection registration failed')
    settings.setCustomServerRuntimeProjectionProvider.mockImplementationOnce(() => {
      throw failure
    })

    await expect(createConnectorApplicationModule(deps)).rejects.toBe(failure)

    expect(mcpClientManager.closeAll).toHaveBeenCalledOnce()
  })
})
