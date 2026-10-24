import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  ready: vi.fn<() => Promise<boolean>>(),
  configured: vi.fn(async () => true)
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
  startDiagnosticOperation: vi.fn()
}))
vi.mock('../lifecycle-shutdown', () => ({ QUIT_SHUTDOWN_BUDGET_MS: 1000 }))
vi.mock('../notebook/network-sandbox-owner', () => ({
  NotebookNetworkSandboxOwner: class {
    windowsProtectionReady = fixture.ready
    windowsProtectionConfigured = fixture.configured
  }
}))
vi.mock('../notebook/trust-bundle', () => ({ resolveNotebookTrustBundle: vi.fn() }))
vi.mock('../settings/network-proxy-runtime', () => ({ NetworkProxyRuntime: class {} }))
vi.mock('../settings/repository', () => ({
  SettingsRepository: class {
    getSettings = async (): Promise<{ localShellRuntime: 'powershell' }> => ({
      localShellRuntime: 'powershell'
    })
  }
}))
vi.mock('../settings/service', () => ({ SettingsService: class {} }))
vi.mock('../settings/settings-install-coordinator', () => ({
  SettingsInstallCoordinator: class {}
}))
vi.mock('../settings/settings-snapshot-commit-owner', () => ({
  SettingsSnapshotCommitOwner: class {}
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

beforeEach(() => {
  fixture.ready.mockReset()
  fixture.configured.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

const bootstrap = async (): ReturnType<typeof composeSettingsBootstrap> => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  return composeSettingsBootstrap({
    applicationEvents: {} as never,
    permissionApprovalPresence: {} as never,
    getRuntimeRef: () => ({ current: undefined }),
    getSpecialistDomain: vi.fn(),
    getSpecialistService: vi.fn(),
    mainEntryPath: '/app/main.js',
    settingsStore: undefined,
    headless: true,
    modules: {
      add: async (_name: unknown, create: () => { capability: unknown }) => create().capability
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
