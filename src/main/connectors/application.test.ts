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
    setCustomServerRuntimeProjectionProvider: vi.fn(),
    setCustomServerAuthenticator: vi.fn(),
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
    broadcastSkillImportApproval: vi.fn(),
    onSkillImportSettled: vi.fn(),
    onSkillImportLifecycleSettled: vi.fn(),
    uploads: {} as ConnectorApplicationDeps['uploads'],
    fetchImpl: vi.fn() as unknown as typeof fetch,
    resolveApiKey: vi.fn(),
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

    await runtime.dispose()
    expect(mcpClientManager.closeAll).toHaveBeenCalledOnce()
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
