import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NotebookNetworkSandboxOwner } from '../notebook/network-sandbox-owner'
import type { SettingsServiceOptions } from '../settings/service'
import type { createAcpRuntime } from '../acp/runtime-composition'

type NetworkOptions = ConstructorParameters<typeof NotebookNetworkSandboxOwner>[0]
type NetworkSettings = Awaited<ReturnType<NetworkOptions['getSettings']>>

const fixture = vi.hoisted(() => ({
  projectAfter: vi.fn(async (pending: Promise<unknown>) => pending),
  ready: vi.fn<() => Promise<boolean>>(),
  configured: vi.fn(async () => true),
  networkOptions: undefined as NetworkOptions | undefined,
  settingsOptions: undefined as SettingsServiceOptions | undefined,
  runtime: { current: undefined as ReturnType<typeof createAcpRuntime> | undefined },
  approvalAvailable: vi.fn(() => false),
  proxyEnvironment: undefined as Record<string, string> | undefined,
  applyProxy: vi.fn(async () => {}),
  network: {
    status: vi.fn<NotebookNetworkSandboxOwner['status']>(),
    installWindows: vi.fn(async () => ({ cancelled: false })),
    cancelWindowsSetup: vi.fn(() => true),
    removeWindows: vi.fn(async () => ({ cancelled: false })),
    applySettings: vi.fn(async () => {}),
    updateParentProxy: vi.fn(async () => {}),
    updateTrustBundle: vi.fn(async () => {}),
    dispose: vi.fn(async () => {})
  },
  serviceDispose: vi.fn(async () => {}),
  handles: [] as Array<{ rollback: () => Promise<void>; dispose: () => Promise<void> }>
}))

// Keep the real composition and Shell binding resolver. Only owner boundaries are replaced;
// no filesystem, credentials, native protection installation, or provider is needed to bind a Shell.
vi.mock('../runtime-metadata', () => ({
  runtimeMetadata: () => ({ packaged: false, applicationPath: '/app', resourcesPath: '/resources' })
}))
vi.mock('../runtime-network', () => ({ runtimeNetwork: vi.fn() }))
vi.mock('../acp/session-agent-target', () => ({ resolveValidatedSessionAgentTarget: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', () => ({
  createLogger: () => ({ warn: vi.fn() }),
  startDiagnosticOperation: () => ({ fail: vi.fn(), complete: vi.fn() })
}))
vi.mock('../lifecycle-shutdown', () => ({ QUIT_SHUTDOWN_BUDGET_MS: 1000 }))
vi.mock('../notebook/network-sandbox-owner', () => ({
  NotebookNetworkSandboxOwner: class {
    constructor(options: NetworkOptions) {
      fixture.networkOptions = options
      Object.assign(this, fixture.network)
    }
    windowsProtectionReady = fixture.ready
    windowsProtectionConfigured = fixture.configured
  }
}))
vi.mock('../notebook/trust-bundle', () => ({ resolveNotebookTrustBundle: vi.fn() }))
vi.mock('../settings/network-proxy-runtime', () => ({
  NetworkProxyRuntime: class {
    apply = fixture.applyProxy
    getChildProcessProxyEnvironment = (): Record<string, string> | undefined =>
      fixture.proxyEnvironment
  }
}))
vi.mock('../settings/repository', () => ({
  SettingsRepository: class {
    getSettings = async (): Promise<{ localShellRuntime: 'powershell' }> => ({
      localShellRuntime: 'powershell'
    })
  }
}))
vi.mock('../settings/service', () => ({
  SettingsService: class {
    constructor(options: SettingsServiceOptions) {
      fixture.settingsOptions = options
    }
    dispose = fixture.serviceDispose
    getNotebookNetwork = async (): Promise<NetworkSettings> => ({
      allowedDomains: [],
      disabledOpenScienceDomainGroups: [],
      disabledOpenScienceDomains: []
    })
    getNotebookFolderRestrictionEnabled = async (): Promise<boolean> => true
    getPackageMirror = async (): Promise<{ caBundle: string }> => ({ caBundle: '/ca.pem' })
    allowNotebookNetworkDomain = async (hostname: string): Promise<NetworkSettings> => ({
      allowedDomains: [hostname],
      disabledOpenScienceDomainGroups: [],
      disabledOpenScienceDomains: []
    })
  }
}))
vi.mock('../settings/settings-install-coordinator', () => ({
  SettingsInstallCoordinator: class {}
}))
vi.mock('../settings/settings-snapshot-commit-owner', () => ({
  SettingsSnapshotCommitOwner: class {
    projectAfter = fixture.projectAfter
  }
}))
vi.mock('../network-fetch', () => ({ netFetchStandard: vi.fn() }))
vi.mock('@aipoch/skills', () => ({ UserSkillSpecialistPackageAdapter: class {} }))
vi.mock('../storage-root', () => ({
  resolveConfigRoot: () => '/config',
  resolveDataRoot: () => '/data'
}))
vi.mock('../storage/initialize-location', () => ({ initializeDataLocation: vi.fn() }))
vi.mock('../wsl/windows-volume-probe', () => ({ probeWindowsVolume: vi.fn() }))
vi.mock('../wsl/wsl-setup-operation-journal', () => ({ FileWslSetupOperationJournal: class {} }))
vi.mock('../wsl/wsl-setup-owner', () => ({ WslSetupOwner: class {} }))
vi.mock('../wsl/wsl-setup-session-owner', () => ({ WslSetupSessionOwner: class {} }))
vi.mock('../wsl/wsl2-preview-gate', () => ({
  initializeWsl2BashPreview: vi.fn(),
  wsl2BashPreviewStatus: () => ({ available: false })
}))

import { composeSettingsBootstrap } from './settings-bootstrap'
import { resolveNotebookTrustBundle } from '../notebook/trust-bundle'

beforeEach(() => {
  fixture.ready.mockReset()
  fixture.configured.mockReset().mockResolvedValue(true)
  fixture.runtime.current = undefined
  fixture.approvalAvailable.mockReset().mockReturnValue(false)
  fixture.proxyEnvironment = undefined
  fixture.applyProxy.mockReset().mockResolvedValue(undefined)
  fixture.network.status.mockReset()
  fixture.network.updateParentProxy.mockReset().mockResolvedValue(undefined)
  fixture.handles.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const bootstrap = async (): ReturnType<typeof composeSettingsBootstrap> => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  return composeSettingsBootstrap({
    applicationEvents: {} as never,
    permissionApprovalPresence: { isAvailable: fixture.approvalAvailable } as never,
    getRuntimeRef: () => fixture.runtime,
    getSpecialistDomain: vi.fn(),
    getSpecialistService: vi.fn(),
    mainEntryPath: '/app/main.js',
    settingsStore: undefined,
    headless: true,
    modules: {
      add: async (
        _name: unknown,
        create: () => {
          capability: unknown
          rollback: () => Promise<void>
          dispose: () => Promise<void>
        }
      ) => {
        const handle = create()
        fixture.handles.push(handle)
        return handle.capability
      }
    } as never
  })
}

it('binds a new conversation Shell without waiting for a pending protection probe', async () => {
  let release!: (ready: boolean) => void
  fixture.ready.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve
      })
  )
  const settings = await bootstrap()
  let settled = false
  const binding = settings.getAvailableShellRuntimeBinding().then((value) => {
    settled = true
    return value
  })
  try {
    // Both settings reads and configured-status reads resolve immediately. An event-loop turn
    // is sufficient; a wall-clock timeout would make the regression depend on machine speed.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled, 'conversation creation is blocked on the Notebook protection probe').toBe(true)
    await expect(binding).resolves.toEqual({ kind: 'powershell', version: '7.6' })
  } finally {
    release?.(true)
    await binding
  }
})

it('keeps explicit protection setup and status failures observable after a conversation binds', async () => {
  const settings = await bootstrap()
  await settings.getAvailableShellRuntimeBinding()
  const failure = new Error('Protected runtime unavailable')
  fixture.network.status.mockRejectedValue(failure)
  const hooks = fixture.settingsOptions!
  await expect(hooks.getNotebookNetworkStatus!()).rejects.toBe(failure)
  await expect(hooks.installNotebookNetwork!()).resolves.toEqual({ cancelled: false })
  expect(hooks.cancelNotebookNetworkSetup!()).toBe(true)
  await expect(hooks.removeNotebookNetwork!()).resolves.toEqual({ cancelled: false })
  expect(fixture.network.installWindows).toHaveBeenCalledOnce()
  expect(fixture.network.cancelWindowsSetup).toHaveBeenCalledOnce()
  expect(fixture.network.removeWindows).toHaveBeenCalledOnce()
})

it('uses the live protection policy, trust bundle and granted roots at execution time', async () => {
  const settings = await bootstrap()
  const options = fixture.networkOptions!
  expect(options.configRoot).toBe('/config')
  await expect(options.getSettings()).resolves.toMatchObject({ allowedDomains: [] })
  await expect(options.getFolderRestrictionEnabled!()).resolves.toBe(true)
  await expect(options.getCaBundlePath!()).resolves.toBe('/ca.pem')
  await expect(options.getGrantedLocalRoots!()).resolves.toEqual([])
  const roots = [{ id: 'grant', path: '/allowed' }]
  settings.grantedRootsRepositoryRef.current = { list: async () => roots } as never
  await expect(options.getGrantedLocalRoots!()).resolves.toBe(roots)
  await expect(options.persistAlwaysAllow('example.org')).resolves.toMatchObject({
    allowedDomains: ['example.org']
  })
})

const decisionRequest = (): Parameters<NetworkOptions['requestDecision']>[0] => ({
  sessionId: 'session',
  projectId: 'project',
  hostname: 'example.org',
  allowOnce: false,
  signal: new AbortController().signal
})

it('fails closed without an approval surface or live coordinator, on abort, and on approval failure', async () => {
  await bootstrap()
  const decide = fixture.networkOptions!.requestDecision
  await expect(decide(decisionRequest())).resolves.toBe('unavailable')
  fixture.approvalAvailable.mockReturnValue(true)
  await expect(decide(decisionRequest())).resolves.toBe('deny')
  const requestAppPermission = vi.fn().mockRejectedValue(new Error('disconnected'))
  fixture.runtime.current = { requestAppPermission } as never
  await expect(decide({ ...decisionRequest(), signal: AbortSignal.abort() })).resolves.toBe('deny')
  expect(requestAppPermission).not.toHaveBeenCalled()
  await expect(decide(decisionRequest())).resolves.toBe('deny')
  expect(requestAppPermission).toHaveBeenCalledOnce()
})

it('binds resumable network approval to its exact execution and only offers allowed scopes', async () => {
  await bootstrap()
  fixture.approvalAvailable.mockReturnValue(true)
  const requestAppPermission = vi.fn().mockResolvedValue('allow-once')
  fixture.runtime.current = { requestAppPermission } as never
  const decide = fixture.networkOptions!.requestDecision
  const request = {
    ...decisionRequest(),
    runtime: 'bash' as const,
    reason: 'egress',
    allowOnce: true,
    executionId: 'execution',
    commandFingerprint: 'fingerprint',
    canResume: () => true
  }
  await expect(decide(request)).resolves.toBe('allowOnce')
  expect(requestAppPermission).toHaveBeenLastCalledWith(
    expect.objectContaining({
      networkApproval: {
        projectId: 'project',
        executionId: 'execution',
        commandFingerprint: 'fingerprint',
        hostname: 'example.org',
        port: 443,
        runtime: 'bash'
      },
      canResume: request.canResume,
      options: expect.arrayContaining([expect.objectContaining({ optionId: 'allow-once' })])
    })
  )
  requestAppPermission.mockResolvedValueOnce('always-allow')
  await expect(decide({ ...request, port: 8443 })).resolves.toBe('alwaysAllow')
  expect(requestAppPermission).toHaveBeenLastCalledWith(
    expect.objectContaining({
      networkApproval: expect.objectContaining({ port: 8443 }),
      rawInput: {
        notebookNetworkApproval: {
          hostname: 'example.org',
          port: 8443,
          runtime: 'bash',
          reason: 'egress'
        }
      }
    })
  )
  requestAppPermission.mockResolvedValueOnce('deny')
  await expect(decide(decisionRequest())).resolves.toBe('deny')
  const plain = requestAppPermission.mock.calls.at(-1)![0]
  expect(plain).not.toHaveProperty('networkApproval')
  expect(plain.options.map((option: { optionId: string }) => option.optionId)).toEqual([
    'always-allow',
    'deny'
  ])
})

it('refreshes the sandbox proxy only after the host proxy applies successfully', async () => {
  await bootstrap()
  const hooks = fixture.settingsOptions!
  const failure = new Error('Proxy update failed')
  fixture.applyProxy.mockRejectedValueOnce(failure)
  await expect(hooks.applyNetworkProxy!({ mode: 'system' })).rejects.toBe(failure)
  expect(fixture.network.updateParentProxy).not.toHaveBeenCalled()
  await hooks.applyNetworkProxy!({ mode: 'system' })
  expect(fixture.network.updateParentProxy).toHaveBeenCalledOnce()
  const options = fixture.networkOptions!
  await expect(options.getParentProxy!()).resolves.toBeUndefined()
  fixture.proxyEnvironment = { NO_PROXY: 'localhost' }
  await expect(options.getParentProxy!()).resolves.toBeUndefined()
  fixture.proxyEnvironment = { ALL_PROXY: 'http://proxy', NO_PROXY: 'localhost' }
  await expect(options.getParentProxy!()).resolves.toEqual({
    http: 'http://proxy',
    https: 'http://proxy',
    noProxy: 'localhost'
  })
  await expect(hooks.resolveCodexProxyEnvironment!()).resolves.toBe(fixture.proxyEnvironment)
})

it('requires notebook teardown for policy changes and propagates teardown failure', async () => {
  const settings = await bootstrap()
  const hooks = fixture.settingsOptions!
  const commit = vi.fn(async () => {})
  await expect(hooks.withNotebookFolderPolicyChange!(commit)).rejects.toThrow(
    'lifecycle is not ready'
  )
  await expect(hooks.beforePackageMirrorCaBundleChange!()).rejects.toThrow('lifecycle is not ready')
  expect(commit).not.toHaveBeenCalled()
  const failure = new Error('Kernel still running')
  const shutdownAll = vi.fn().mockRejectedValueOnce(failure)
  settings.notebookPolicyLifecycle.current = { shutdownAll }
  await expect(hooks.beforePackageMirrorCaBundleChange!()).rejects.toBe(failure)
  shutdownAll.mockImplementation(async (options?: { afterShutdown?: () => Promise<void> }) => {
    await options?.afterShutdown?.()
    return { reaped: true }
  })
  await expect(settings.shutdownNotebooksBeforePolicyChange('granted-roots')).resolves.toEqual({
    reaped: true
  })
  await hooks.withNotebookFolderPolicyChange!(commit)
  expect(commit).toHaveBeenCalledOnce()
})

it('retains policy updates and requires a live runtime to refresh existing Shell capabilities', async () => {
  await bootstrap()
  const hooks = fixture.settingsOptions!
  await hooks.applyNotebookNetwork!({
    allowedDomains: ['example.org'],
    disabledOpenScienceDomainGroups: [],
    disabledOpenScienceDomains: []
  })
  expect(fixture.network.applySettings).toHaveBeenCalledWith(
    expect.objectContaining({ allowedDomains: ['example.org'] })
  )
  await hooks.validatePackageMirror!({ caBundle: '/replacement.pem' })
  expect(resolveNotebookTrustBundle).toHaveBeenCalledWith('/replacement.pem')
  const invalidBundle = new Error('Invalid trust bundle')
  vi.mocked(resolveNotebookTrustBundle).mockRejectedValueOnce(invalidBundle)
  await expect(hooks.validatePackageMirror!({ caBundle: '/invalid.pem' })).rejects.toBe(
    invalidBundle
  )
  await hooks.applyPackageMirror!({} as never)
  expect(fixture.network.updateTrustBundle).toHaveBeenCalledOnce()
  await expect(hooks.refreshNotebookShellCapabilities!()).rejects.toThrow('lifecycle is not ready')
  const requestShellCapabilityRefresh = vi.fn(async () => {})
  fixture.runtime.current = { requestShellCapabilityRefresh } as never
  await hooks.refreshNotebookShellCapabilities!()
  expect(requestShellCapabilityRefresh).toHaveBeenCalledOnce()
})

it('releases protection and settings owners on both rollback and normal disposal', async () => {
  await bootstrap()
  for (const handle of fixture.handles) {
    await handle.rollback()
    await handle.dispose()
  }
  expect(fixture.network.dispose).toHaveBeenCalledTimes(2)
  expect(fixture.serviceDispose).toHaveBeenCalledTimes(2)
})

it('keeps conversation creation available when the protected runtime probe fails', async () => {
  fixture.ready.mockRejectedValue(
    new Error('Windows runtime is incompatible with protected execution.', {
      cause: new Error('WINDOWS_ACL_ACCESS_DENIED: write command ACL')
    })
  )
  const settings = await bootstrap()
  await expect(settings.getAvailableShellRuntimeBinding()).resolves.toEqual({
    kind: 'powershell',
    version: '7.6'
  })
})

it.each([
  [false, '5.1'],
  [true, '7.6']
] as const)(
  'retains the configured Shell version when protection is %s',
  async (configured, version) => {
    fixture.configured.mockResolvedValueOnce(configured)
    fixture.ready.mockResolvedValue(configured)
    const settings = await bootstrap()
    await expect(settings.getAvailableShellRuntimeBinding()).resolves.toEqual({
      kind: 'powershell',
      version
    })
  }
)

it('rejects an unreadable protection configuration instead of selecting an unprotected Shell', async () => {
  const error = new Error('Windows protection ownership is inconsistent.')
  fixture.configured.mockRejectedValue(error)
  fixture.ready.mockRejectedValue(error)
  const settings = await bootstrap()
  await expect(settings.getAvailableShellRuntimeBinding()).rejects.toThrow(
    'Windows protection ownership is inconsistent.'
  )
})

it('publishes global network grants through the shared settings snapshot owner', async () => {
  await bootstrap()
  await fixture.settingsOptions!.onNotebookNetworkDomainAllowed!()
  expect(fixture.projectAfter).toHaveBeenCalledOnce()
})

it('reads transition-aware authority and forwards subscriptions without an approval client', async () => {
  await bootstrap()
  const options = fixture.networkOptions!
  expect(options.hasFullAccess!('session')).toBe(false)
  options.subscribeFullAccess!('session', vi.fn())()
  const hasFullAccess = vi.fn((sessionId: string) => sessionId === 'session')
  const unsubscribe = vi.fn()
  const subscribeFullAccess = vi.fn(() => unsubscribe)
  fixture.runtime.current = { hasFullAccess, subscribeFullAccess } as never
  expect(fixture.approvalAvailable()).toBe(false)
  expect(options.hasFullAccess!('session')).toBe(true)
  expect(options.hasFullAccess!('other-session')).toBe(false)
  hasFullAccess.mockReturnValue(false)
  expect(options.hasFullAccess!('session')).toBe(false)
  const listener = vi.fn()
  options.subscribeFullAccess!('session', listener)()
  expect(subscribeFullAccess).toHaveBeenCalledWith('session', listener)
  expect(unsubscribe).toHaveBeenCalledOnce()
})
