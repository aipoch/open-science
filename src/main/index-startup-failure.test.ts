import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Exercise the real production entry up to the process boundary. Database/runtime failures belong
// to Node's startup owner; Electron must not construct a second store while handling those failures.
const f = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    log,
    initLogs: vi.fn(),
    fatalLog: vi.fn(),
    ready: false,
    lock: true,
    fail: undefined as unknown,
    leaseRelease: vi.fn(),
    select: vi.fn(),
    validate: vi.fn(),
    inventory: vi.fn(() => [Buffer.from('synthetic-profile-ciphertext')]),
    key: vi.fn(),
    launch: vi.fn(),
    connect: vi.fn(),
    lifecycle: vi.fn(),
    windowCreated: vi.fn(),
    diagnostics: vi.fn(),
    completedStartup: vi.fn(),
    windowsStartup: vi.fn(),
    verifyRecovery: vi.fn(async () => {}),
    processAlive: true,
    mainWindows: [] as import('electron').BrowserWindow[],
    readLifetime: vi.fn(
      async () => undefined as import('./local-service-lifetime').ServiceLifetimeRecord | undefined
    ),
    flush: vi.fn(
      async () =>
        'completed' as import('./session-persistence/flush-protocol').RendererSessionPersistenceFlushOutcome
    ),
    completeMacHandoff: vi.fn(),
    report: vi.fn(async () => undefined),
    app: {
      isPackaged: false,
      setName: vi.fn(),
      setPath: vi.fn(),
      setAppLogsPath: vi.fn(),
      quit: vi.fn(),
      relaunch: vi.fn(),
      exit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      getPath: vi.fn(() => '/test/home'),
      getAppPath: () => '/test/app',
      getVersion: () => 'test',
      getLocale: () => 'en',
      getPreferredSystemLanguages: () => ['en'],
      commandLine: { getSwitchValue: () => '', appendSwitch: vi.fn() },
      isReady: (): boolean => false,
      whenReady: vi.fn(async () => {}),
      requestSingleInstanceLock: vi.fn(() => true)
    },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    handlers: new Map<string, (...args: unknown[]) => unknown>()
  }
})
vi.mock('electron', () => ({
  app: f.app,
  dialog: f.dialog,
  protocol: f.protocol,
  BrowserWindow: class {
    static getAllWindows(): import('electron').BrowserWindow[] {
      return f.mainWindows
    }
    static fromWebContents(): null {
      return null
    }
    webContents = { setWindowOpenHandler: vi.fn() }
    constructor() {
      f.windowCreated()
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return false
    }
    destroy = vi.fn()
    showInactive = vi.fn()
  },
  Menu: { getApplicationMenu: () => null, setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
  Notification: {},
  crashReporter: { start: vi.fn() },
  ipcMain: {},
  nativeImage: {},
  nativeTheme: {},
  net: { fetch: vi.fn() },
  powerMonitor: {},
  session: {
    defaultSession: { protocol: f.protocol },
    fromPartition: () => ({ protocol: f.protocol })
  }
}))
vi.mock('./update/windows-update-handoff', async (original) => ({
  ...(await original<typeof import('./update/windows-update-handoff')>()),
  resolveWindowsUpdateStartup: f.windowsStartup
}))
vi.mock('./desktop-recovery-readiness', () => ({
  verifyDesktopRecoveryReadiness: f.verifyRecovery
}))
vi.mock('./runtime-metadata', () => ({ configureRuntimeMetadata: vi.fn() }))
vi.mock('./ipc-handler-registry', () => ({
  configureIpcHandlerRegistry: vi.fn(),
  ipcMainHandle: (name: string, fn: (...args: unknown[]) => unknown) => f.handlers.set(name, fn)
}))
vi.mock('./runtime-ownership', () => ({
  acquireCredentialBootstrapLease: () => ({ release: f.leaseRelease })
}))
vi.mock('./runtime-stop-confirmation', async (original) => ({
  ...(await original<typeof import('./runtime-stop-confirmation')>()),
  isRuntimeProcessAlive: () => f.processAlive
}))
vi.mock('./local-service-lifetime', async (original) => ({
  ...(await original<typeof import('./local-service-lifetime')>()),
  readServiceLifetime: f.readLifetime
}))
vi.mock('./settings/credential-store-mode', () => ({
  configureCredentialStore: vi.fn(),
  getCredentialStore: () => 'os'
}))
vi.mock('./credential-identity/bootstrap', () => ({
  selectStartupCredentialIdentity: f.select,
  prepareCredentialValidation: f.validate
}))
vi.mock('./credential-identity/node-cipher', () => ({ initializeNodeWindowsProfileKey: f.key }))
vi.mock('./credential-identity/ciphertext-inventory', () => ({
  readCredentialCiphertexts: f.inventory
}))
vi.mock('./storage/electron-profile', () => ({
  resolveBootstrapConfigRoot: () => '/test/config',
  resolveElectronProfile: (options: { env?: NodeJS.ProcessEnv }) =>
    options.env?.OPEN_SCIENCE_USER_DATA ?? '/test/profile'
}))
vi.mock('./desktop-runtime-launcher', () => ({
  desktopBackendPaths: () => ({ command: '/test/node', entry: '/test/backend.cjs' }),
  startOrAttachDesktopBackend: f.launch
}))
vi.mock('./desktop-runtime-client', () => ({ connectDesktopRuntime: f.connect }))
vi.mock('./desktop-runtime-electron-adapter', () => ({
  installDesktopRuntimeElectronAdapter: () => ({ uninstall: vi.fn() })
}))
vi.mock('./cli-install/ipc', () => ({
  createCliCommandOwner: () => ({ ensureCurrent: vi.fn() }),
  registerCliInstallIpcHandlers: vi.fn()
}))
vi.mock('./update/create-strategy', () => ({ createUpdateStrategy: vi.fn() }))
vi.mock('./update/ipc', () => ({ registerUpdateIpcHandlers: vi.fn() }))
vi.mock('./update/scheduler', () => ({ startUpdateScheduler: vi.fn() }))
vi.mock('./runtime-network-electron', () => ({ installElectronNetwork: vi.fn() }))
vi.mock('./renderer-broadcast-electron', () => ({ installElectronBroadcast: vi.fn() }))
vi.mock('./mac-installation', () => ({
  isReadOnlyMacInstallation: () => false,
  showMacInstallationGuidance: vi.fn(),
  completeMacInstallationHandoff: f.completeMacHandoff
}))
vi.mock('./desktop-native-electron', () => ({ createDesktopNativeHandler: vi.fn() }))
vi.mock('@aipoch/diagnostics/node', async (original) => ({
  ...(await original<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => f.log,
  flushLogs: vi.fn(async () => {}),
  initLogger: f.initLogs,
  writeFatalLogSync: f.fatalLog
}))
vi.mock('./diagnostics/startup', () => ({
  initializeApplicationDiagnostics: () => {
    f.diagnostics()
    return { log: f.log, operation: { phase: vi.fn(), complete: f.completedStartup } }
  },
  reportApplicationStartupFailure: f.report
}))
vi.mock('./crash-diagnostics', () => ({
  installChildProcessGoneLogging: vi.fn(),
  startLocalCrashReporting: vi.fn()
}))
vi.mock('./renderer-diagnostics', () => ({
  registerRendererDiagnosticsIpc: vi.fn(),
  createRendererFailureReporter: vi.fn()
}))
vi.mock('@electron-toolkit/utils', () => ({ electronApp: { setAppUserModelId: vi.fn() } }))
vi.mock('../../resources/icon.png?asset', () => ({ default: 'icon' }))
vi.mock('../../resources/icon-dark.png?asset', () => ({ default: 'icon' }))
vi.mock('../../resources/icon-light.ico?asset', () => ({ default: 'icon' }))
vi.mock('../../resources/icon-dark.ico?asset', () => ({ default: 'icon' }))
vi.mock('../../resources/trayTemplate.png?asset', () => ({ default: 'icon' }))
vi.mock('../../resources/tray-light.ico?asset', () => ({ default: 'icon' }))
vi.mock('../../resources/tray-dark.ico?asset', () => ({ default: 'icon' }))
vi.mock('../../resources/tray.png?asset', () => ({ default: 'icon' }))
vi.mock('./windows', () => ({
  createMainWindow: vi.fn(() => ({ once: vi.fn(), show: vi.fn(), isDestroyed: () => false })),
  configureMainWindow: vi.fn(),
  isMainWindow: vi.fn()
}))
vi.mock('./window-shortcuts', () => ({
  applyInterfaceScaleShortcut: vi.fn(),
  installWindowShortcuts: vi.fn()
}))
vi.mock('./window-ipc', () => ({
  registerWindowCloseIpcHandler: vi.fn(),
  registerWindowZoomIpcHandler: vi.fn()
}))
vi.mock('./windows-titlebar', () => ({ registerWindowsTitleBarIpc: vi.fn() }))
vi.mock('./window-find-ipc', () => ({ registerWindowFindIpcHandlers: vi.fn() }))
vi.mock('./app-icon', () => ({ createAppIconController: vi.fn(), buildAppIconPreviews: vi.fn() }))
vi.mock('./tray', () => ({
  createAppTray: vi.fn(),
  refreshAppTrayLocale: vi.fn(),
  refreshAppTrayNavigation: vi.fn(),
  setTrayIconVariant: vi.fn()
}))
vi.mock('./notifications/electron-wiring', () => ({
  createDesktopNotificationHandler: () => ({ handle: vi.fn(), dispose: vi.fn() })
}))
vi.mock('./notifications/desktop-attention', () => ({
  createDesktopAttentionController: () => ({ request: vi.fn(), clear: vi.fn() })
}))
vi.mock('./notifications/desktop-badge', () => ({
  createDesktopBadgeAdapter: () => ({ setCount: vi.fn() }),
  createWindowsBadgeBitmap: vi.fn()
}))
vi.mock('./notifications/unread-task-ipc', () => ({
  registerUnreadTaskIpc: () => ({ confirmSessionVisible: vi.fn(), dispose: vi.fn() })
}))
vi.mock('./window-close-confirm', () => ({ createElectronCloseConfirm: vi.fn() }))
vi.mock('./app-lifecycle', () => ({ installAppLifecycle: f.lifecycle }))
vi.mock('./session-persistence/renderer-flush', () => ({
  createElectronSessionPersistenceFlush: vi.fn(() => f.flush),
  notifyRendererSessionPersistenceFlushAborted: vi.fn(),
  rendererSessionPersistenceFlushBlocksShutdown: vi.fn()
}))
vi.mock('./system-lifecycle-adapters', () => ({
  installSystemLifecycleAdapters: () => ({
    installPowerMonitorListeners: vi.fn(),
    bindWindow: vi.fn()
  })
}))
vi.mock('./office-preview/office-preview-runtime-protocol', () => ({
  OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG: { scheme: 'runtime' },
  registerOfficePreviewRuntimeProtocol: vi.fn()
}))

beforeEach(() => {
  vi.resetModules()
  // Single-instance policy is mocked here; task isolation may enable real parallel instances.
  vi.stubEnv('OPEN_SCIENCE_ALLOW_MULTI_INSTANCE', '0')
  vi.clearAllMocks()
  f.ready = false
  f.processAlive = true
  f.mainWindows = []
  f.readLifetime.mockResolvedValue(undefined)
  f.flush.mockResolvedValue('completed')
  f.windowsStartup.mockResolvedValue(undefined)
  f.handlers.clear()
  f.select.mockReturnValue({ backend: 'mac-keychain', appName: 'Open-Science (DEV)', exists: true })
  f.validate.mockReturnValue(vi.fn())
  f.app.isReady = () => f.ready
  f.app.whenReady.mockImplementation(async () => {
    f.ready = true
  })
  f.app.requestSingleInstanceLock.mockReturnValue(true)
  f.launch.mockRejectedValue(new Error('authenticated backend refused the connection'))
  vi.spyOn(process, 'on').mockImplementation(() => process)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('keeps credential authorization headless until backend startup completes', async () => {
  let rejectLaunch!: (error: Error) => void
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.launch.mockImplementation((options) => {
    options.onStatus({
      protocolVersion: 1,
      attemptId: '9706f945-efc7-4fe8-b52e-cd1978a126a7',
      stage: 'credentials',
      kind: 'progress',
      elapsedMs: 0
    })
    entered()
    return new Promise((_resolve, reject) => {
      rejectLaunch = reject
    })
  })
  await import('./index')
  await waiting
  try {
    await new Promise((resolve) => setTimeout(resolve, 1800))
    expect(f.windowCreated).not.toHaveBeenCalled()
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(f.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(f.lifecycle).not.toHaveBeenCalled()
  } finally {
    rejectLaunch(new Error('fixture startup stopped'))
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(1))
  }
})

it.each(['mac-keychain', 'windows-dpapi'] as const)(
  'completes %s identity preflight before yielding to Electron, without acquiring business ownership',
  async (backend) => {
    f.select.mockReturnValue({ backend, appName: 'Open-Science (DEV)', exists: true })
    await import('./index')
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(1))
    expect(f.inventory).toHaveBeenCalledWith({
      configRoot: '/test/config',
      profilePath: '/test/profile'
    })
    expect(f.validate).toHaveBeenCalledWith(
      expect.objectContaining({ backend }),
      { configRoot: '/test/config', profilePath: '/test/profile' },
      [Buffer.from('synthetic-profile-ciphertext')]
    )
    expect(f.leaseRelease.mock.invocationCallOrder[0]).toBeLessThan(
      f.app.whenReady.mock.invocationCallOrder[0]
    )
    expect(f.key).toHaveBeenCalledTimes(backend === 'windows-dpapi' ? 1 : 0)
    if (backend === 'windows-dpapi')
      expect(f.key.mock.invocationCallOrder[0]).toBeLessThan(
        f.app.whenReady.mock.invocationCallOrder[0]
      )
    expect(f.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        configRoot: '/test/config',
        command: '/test/node',
        entry: '/test/backend.cjs',
        credentialInventory: [Buffer.from('synthetic-profile-ciphertext')]
      })
    )
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'authenticated backend refused the connection' })
      })
    )
  }
)
it('displays inventory details without persisting them or initializing the profile', async () => {
  const { CredentialIdentityError } = await import('./credential-identity/selection')
  f.inventory.mockImplementationOnce(() => {
    throw new CredentialIdentityError('ciphertext-inventory-unavailable', undefined, {
      code: 'inventory-failed',
      source: 'application-database',
      stage: 'check-journal',
      reason: 'journal-incomplete'
    })
  })
  await import('./index')
  expect(f.dialog.showErrorBox).toHaveBeenCalledWith(
    'Open-Science',
    expect.stringContaining('Affected data: Application database')
  )
  for (const sink of [f.log.error, f.fatalLog]) {
    expect(sink).toHaveBeenCalled()
    expect(JSON.stringify(sink.mock.calls)).not.toContain('inventory-failed')
    expect(JSON.stringify(sink.mock.calls)).not.toContain('journal-incomplete')
  }
  expect(f.app.exit).toHaveBeenCalledWith(1)
  expect(f.app.whenReady).not.toHaveBeenCalled()
  expect(f.key).not.toHaveBeenCalled()
  expect(f.launch).not.toHaveBeenCalled()
})

it('releases credential preflight and exits without yielding or initializing the profile after recovery failure', async () => {
  // beforeEach resets module identity; use the same error class as this entry import.
  const { CredentialIdentityError } = await import('./credential-identity/selection')
  f.validate.mockImplementationOnce(() => {
    throw new CredentialIdentityError('windows-profile-key-unavailable', undefined, {
      code: 'profile-read-failed',
      systemCode: 'EBUSY'
    })
  })
  await import('./index')
  expect(f.app.exit).toHaveBeenCalledWith(1)
  expect(f.dialog.showErrorBox).toHaveBeenCalledWith(
    'Open-Science',
    expect.stringContaining('SYSTEM_ERROR: EBUSY')
  )
  expect(f.log.error).toHaveBeenCalledWith(
    'desktop startup failed',
    expect.objectContaining({
      validationDiagnostic: { code: 'profile-read-failed', systemCode: 'EBUSY' }
    })
  )
  expect(f.initLogs).toHaveBeenCalledWith({
    logDir: expect.stringMatching(/profile[/\\]desktop-logs$/)
  })
  expect(f.initLogs.mock.invocationCallOrder[0]).toBeLessThan(
    f.validate.mock.invocationCallOrder[0]
  )
  expect(f.fatalLog).toHaveBeenCalledWith(
    'desktop-bootstrap',
    'desktop startup failed',
    expect.objectContaining({
      validationDiagnostic: { code: 'profile-read-failed', systemCode: 'EBUSY' }
    })
  )
  expect(f.fatalLog.mock.invocationCallOrder[0]).toBeLessThan(
    f.app.exit.mock.invocationCallOrder[0]
  )
  expect(f.leaseRelease).toHaveBeenCalledOnce()
  expect(f.app.whenReady).not.toHaveBeenCalled()
  expect(f.key).not.toHaveBeenCalled()
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.diagnostics).not.toHaveBeenCalled()
  expect(f.log.error.mock.invocationCallOrder[0]).toBeLessThan(
    f.dialog.showErrorBox.mock.invocationCallOrder[0]
  )
})
it('selects the requested profile before checking its single-instance lock', async () => {
  let selectedPaths: unknown
  f.app.requestSingleInstanceLock.mockImplementation(() => {
    selectedPaths = f.app.setPath.mock.calls.map((call) => [...call])
    return false
  })
  await import('./index')
  expect(selectedPaths).toEqual([
    ['userData', '/test/profile'],
    ['sessionData', '/test/profile']
  ])
  expect(f.inventory).not.toHaveBeenCalled()
  expect(f.app.whenReady).not.toHaveBeenCalled()
})
it('a secondary desktop never starts or stops a business runtime', async () => {
  f.app.requestSingleInstanceLock.mockReturnValue(false)
  await import('./index')
  expect(f.app.quit).toHaveBeenCalledOnce()
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.app.whenReady).not.toHaveBeenCalled()
})
it('flushes startup diagnostics before presenting a post-ready failure and exiting', async () => {
  let finish!: () => void
  f.report.mockImplementationOnce(
    () =>
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined)
      })
  )
  await import('./index')
  await vi.waitFor(() => expect(f.report).toHaveBeenCalledOnce())
  expect(f.dialog.showErrorBox).not.toHaveBeenCalled()
  expect(f.app.exit).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(1))
})

it.each(['win32', 'linux', 'darwin'] as const)(
  'delegates disconnected quit to the existing lifecycle without another native decision (%s)',
  async (platform) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      const { isMainWindow } = await import('./windows')
      const { BrowserWindow } = await import('electron')
      const destroyedWindow = { isDestroyed: () => true }
      const showMainWindow = vi.fn()
      f.lifecycle.mockReturnValue({
        showMainWindow,
        getMainWindow: () => destroyedWindow,
        isMainWindowHidden: () => false,
        onSystemShutdown: vi.fn()
      })
      const client = {
        ownsRuntime: () => false,
        processId: () => 123,
        runtimeInfo: () => ({ generation: 'disconnected-quit-test' }),
        invokeHost: async () => ({ locale: 'en' }),
        startupState: () => ({ phase: 'checking' }),
        close: vi.fn()
      }
      let disconnect!: () => void
      f.connect.mockImplementation(async (options) => {
        disconnect = options.onDisconnect
        return client
      })
      f.launch.mockResolvedValue({})
      f.dialog.showMessageBox.mockResolvedValue({ response: 0 })
      await import('./index')
      await vi.waitFor(() => {
        expect(f.report.mock.calls).toEqual([])
        expect(f.lifecycle).toHaveBeenCalledOnce()
      })
      expect(f.app.exit).not.toHaveBeenCalled()
      disconnect()
      vi.spyOn(BrowserWindow, 'fromWebContents').mockReturnValue(
        destroyedWindow as InstanceType<typeof BrowserWindow>
      )
      vi.mocked(isMainWindow).mockReturnValue(true)
      const frame = {}
      f.handlers.get('desktop-runtime:quit')!({ sender: { mainFrame: frame }, senderFrame: frame })
      expect(f.app.quit).toHaveBeenCalledOnce()
      expect(f.dialog.showMessageBox).not.toHaveBeenCalled()
      const lifecycleOptions = f.lifecycle.mock.calls[0][0]
      expect(lifecycleOptions.flushSessionPersistence).toBeTypeOf('function')
      expect(lifecycleOptions.createConfirmClose).toBeTypeOf('function')
      expect(client.close).not.toHaveBeenCalled()
      expect(f.app.exit).not.toHaveBeenCalled()
      // The mocked lifecycle does not perform quit admission; stop its reconnect timer here.
      lifecycleOptions.holdSettingsInstallAdmission()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
)

it('stops the backend it started when quitting from the attach-retry blocked page', async () => {
  const exitHandlers: Array<() => void> = []
  const child = {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(() => {
      child.exitCode = 0
      exitHandlers.splice(0).forEach((handler) => handler())
      return true
    }),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'exit') exitHandlers.push(handler)
    })
  }
  f.launch.mockResolvedValue({ startedProcess: child })
  f.connect.mockRejectedValue(new Error('control could not be confirmed'))
  await import('./index')
  await vi.waitFor(() => expect(f.handlers.size).toBeGreaterThan(0))
  const hold = f.app.on.mock.calls.find(([event]) => event === 'before-quit')![1]
  await vi.waitFor(() => {
    const event = { preventDefault: vi.fn() }
    hold(event)
    expect(child.kill).toHaveBeenCalled()
  })
  await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(0))
  expect(child.kill.mock.invocationCallOrder[0]).toBeLessThan(
    f.app.exit.mock.invocationCallOrder[0]
  )
})

it('rejects a missing update configuration before selecting a fallback profile or credentials', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    f.windowsStartup.mockRejectedValue(new Error('Missing update request'))
    await import('./index')
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(1))
    expect(f.app.setPath).not.toHaveBeenCalled()
    expect(f.select).not.toHaveBeenCalled()
    expect(f.launch).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

it('allows a normal relaunch after confirmed upgrade to read newly committed data settings', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const oldOptions = {
      configRoot: '/test/config',
      profilePath: '/test/profile',
      dataRoot: '/test/old-data',
      port: 44100,
      host: '127.0.0.1',
      credentialStore: 'file'
    }
    f.windowsStartup.mockResolvedValue({ startupOptions: oldOptions, confirmed: true })
    f.lifecycle.mockReturnValue({
      showMainWindow: vi.fn(),
      getMainWindow: () => ({ isDestroyed: () => false, isVisible: () => true }),
      isMainWindowHidden: () => false,
      onSystemShutdown: vi.fn()
    })
    const client = {
      ownsRuntime: () => false,
      processId: () => 123,
      runtimeInfo: () => ({
        generation: 'migrated-data',
        startupOptions: { ...oldOptions, dataRoot: '/test/new-data' }
      }),
      invokeHost: async () => ({ locale: 'en' }),
      startupState: () => ({ phase: 'checking' }),
      close: vi.fn()
    }
    f.connect.mockResolvedValue(client)
    f.launch.mockResolvedValue({})
    await import('./index')
    await vi.waitFor(() => expect(f.lifecycle).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(f.completedStartup).toHaveBeenCalled())
    expect(f.verifyRecovery).not.toHaveBeenCalled()
    expect(f.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        configRoot: oldOptions.configRoot,
        profilePath: oldOptions.profilePath,
        args: ['--credential-store=file', '--serve=44100']
      })
    )
    expect(f.app.exit).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

it('replays cold import preparation before attachment and adopts its shell without recreating it', async () => {
  const argv = process.argv
  process.argv = [
    'app',
    'open-science://import?' +
      new URLSearchParams({
        version: '1',
        origin: 'https://example.com',
        secret: 'ab'.repeat(32),
        port: '49231',
        name: 'cold.science',
        size: '5'
      })
  ]
  try {
    const { createMainWindow, isMainWindow } = await import('./windows')
    const { BrowserWindow } = await import('electron')
    f.launch.mockResolvedValue({})
    let attach!: (client: unknown) => void
    f.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          attach = resolve
        })
    )
    f.lifecycle.mockReturnValue({
      showMainWindow: vi.fn(),
      getMainWindow: () => undefined,
      isMainWindowHidden: () => false,
      onSystemShutdown: vi.fn()
    })
    await import('./index')
    await vi.waitFor(() => expect(createMainWindow).toHaveBeenCalledOnce())
    const window = vi.mocked(createMainWindow).mock.results[0].value as ReturnType<
      typeof createMainWindow
    >
    vi.spyOn(BrowserWindow, 'fromWebContents').mockReturnValue(window)
    vi.mocked(isMainWindow).mockReturnValue(true)
    const frame = {}
    const event = { sender: { mainFrame: frame }, senderFrame: frame }
    const snapshot = f.handlers.get('package-presentation:get-state')!(event)
    expect(snapshot).toMatchObject({
      browserTransfers: [{ filename: 'cold.science', state: 'preparing' }]
    })
    expect(() =>
      f.handlers.get('package-presentation:get-state')!({ ...event, senderFrame: {} })
    ).toThrow('main application frame')
    expect(f.lifecycle).not.toHaveBeenCalled()
    attach({
      ownsRuntime: () => false,
      processId: () => 123,
      runtimeInfo: () => ({ generation: 'cold-import' }),
      invokeHost: async () => ({ locale: 'en' }),
      startupState: () => ({ phase: 'checking' }),
      close: vi.fn()
    })
    await vi.waitFor(() => expect(f.completedStartup).toHaveBeenCalledOnce())
    expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ initialWindow: window }))
    expect(createMainWindow).toHaveBeenCalledOnce()
  } finally {
    process.argv = argv
  }
})

it('reports startup failure for the early import and exits when its reused recovery window closes', async () => {
  const argv = process.argv
  process.argv = [
    'app',
    'open-science://import?' +
      new URLSearchParams({
        version: '1',
        origin: 'https://example.com',
        secret: 'cd'.repeat(32),
        port: '49232',
        name: 'blocked.science',
        size: '5'
      })
  ]
  try {
    const { createMainWindow, isMainWindow } = await import('./windows')
    const { BrowserWindow } = await import('electron')
    f.launch.mockResolvedValue({})
    f.connect.mockRejectedValue(new Error('control could not be confirmed'))
    await import('./index')
    await vi.waitFor(() => expect(createMainWindow).toHaveBeenCalledOnce())
    const window = vi.mocked(createMainWindow).mock.results[0].value as ReturnType<
      typeof createMainWindow
    >
    vi.spyOn(BrowserWindow, 'fromWebContents').mockReturnValue(window)
    vi.mocked(isMainWindow).mockReturnValue(true)
    const frame = {}
    const event = { sender: { mainFrame: frame }, senderFrame: frame }
    await vi.waitFor(() =>
      expect(f.handlers.get('runtime-startup:get-state')!(event)).toMatchObject({
        phase: 'blocked'
      })
    )
    expect(f.handlers.get('package-presentation:get-state')!(event)).toMatchObject({
      browserTransfers: [{ filename: 'blocked.science', state: 'failed' }]
    })
    const closed = (vi.mocked(window.once).mock.calls as unknown as [string, () => void][]).find(
      ([name]) => name === 'closed'
    )![1]
    closed()
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(0))
    expect(createMainWindow).toHaveBeenCalledOnce()
  } finally {
    process.argv = argv
  }
})

it.each(['ready', 'checking-to-ready', 'checking-abort'] as const)(
  'refreshes cached package progress with %s recovery activation',
  async (mode) => {
    type RecoveryOptions = Parameters<
      typeof import('./desktop-runtime-recovery').createDesktopRuntimeRecovery
    >[0]
    let activate!: RecoveryOptions['activate']
    vi.doMock('./desktop-runtime-recovery', async (original) => ({
      ...(await original<typeof import('./desktop-runtime-recovery')>()),
      createDesktopRuntimeRecovery: (options: RecoveryOptions) => {
        activate = options.activate
        return { state: () => ({ phase: 'connected', epoch: 0 }), setClosing: vi.fn() }
      }
    }))
    vi.doMock('./desktop-preview-proxy', () => ({
      createDesktopPreviewProxy: async () => ({ dispose: vi.fn(), port: 49151 })
    }))
    try {
      const { isMainWindow } = await import('./windows')
      const { BrowserWindow } = await import('electron')
      const current = {
        id: 'import',
        kind: 'import',
        state: 'running',
        progress: { phase: 'validating' }
      }
      const completed = { ...current, state: 'succeeded' }
      let startupPhase: 'ready' | 'checking' = 'ready'
      const invokeHost = vi.fn(async (channel: string) =>
        channel === 'desktop:package-operation-snapshot' ? completed : { locale: 'en' }
      )
      const client = {
        ownsRuntime: () => false,
        processId: () => 123,
        runtimeInfo: () => ({ generation: 'reconnect' }),
        invokeHost,
        startupState: () => ({ phase: startupPhase }),
        close: vi.fn(),
        notificationView: vi.fn(),
        loadSessionForEvent: vi.fn()
      }
      let deliver!: (event: { channel: string; payload: unknown }) => void
      f.connect.mockImplementation(async (options) => {
        deliver = options.onEvent
        return client
      })
      f.launch.mockResolvedValue({})
      f.lifecycle.mockReturnValue({
        showMainWindow: vi.fn(),
        getMainWindow: () => undefined,
        isMainWindowHidden: () => false,
        onSystemShutdown: vi.fn()
      })
      await import('./index')
      await vi.waitFor(() => {
        expect(f.report.mock.calls).toEqual([])
        expect(f.completedStartup).toHaveBeenCalledOnce()
      })
      deliver({ channel: 'sessions:package-operation-changed', payload: current })
      vi.spyOn(BrowserWindow, 'fromWebContents').mockReturnValue(
        {} as InstanceType<typeof BrowserWindow>
      )
      vi.mocked(isMainWindow).mockReturnValue(true)
      const frame = {}
      const event = { sender: { mainFrame: frame }, senderFrame: frame }
      expect(f.handlers.get('package-presentation:get-state')!(event)).toEqual(current)
      invokeHost.mockClear()
      startupPhase = mode === 'ready' ? 'ready' : 'checking'
      const controller = new AbortController()
      const announce = vi.fn()
      const activation = activate(
        client as unknown as Parameters<RecoveryOptions['activate']>[0],
        controller.signal,
        announce
      )
      if (mode !== 'ready') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(invokeHost).not.toHaveBeenCalled()
        expect(announce).not.toHaveBeenCalled()
        if (mode === 'checking-abort') {
          const aborted = expect(activation).rejects.toMatchObject({ name: 'AbortError' })
          controller.abort()
          await aborted
          expect(invokeHost).not.toHaveBeenCalled()
          expect(announce).not.toHaveBeenCalled()
          expect(f.handlers.get('package-presentation:get-state')!(event)).toEqual(current)
          return
        }
        startupPhase = 'ready'
      }
      await activation
      expect(invokeHost).toHaveBeenCalledWith('desktop:package-operation-snapshot')
      expect(f.handlers.get('package-presentation:get-state')!(event)).toEqual(completed)
    } finally {
      vi.doUnmock('./desktop-runtime-recovery')
      vi.doUnmock('./desktop-preview-proxy')
    }
  }
)

const restartConfiguration = {
  configRoot: '/test/config',
  profilePath: '/test/profile',
  port: 44123,
  credentialStore: 'os' as const,
  passwordStore: 'basic'
}
const restartGeneration = 'a64f6d2b-5bc3-41fb-b63b-55ffb43af30b'

type RecoverableDesktopFixture = {
  window: import('electron').BrowserWindow
  event: { sender: import('electron').WebContents; senderFrame: object }
  callbacks: Parameters<typeof import('./desktop-runtime-client').connectDesktopRuntime>[0]
  lifecycle: import('./app-lifecycle').AppLifecycleDeps
  getState(): import('../shared/desktop-runtime-recovery').DesktopRuntimeRecoveryState
  failReplacement(): Promise<void>
  restart(): Promise<'blocked' | 'restarting'>
}

const startRecoverableDesktop = async (
  source: 'cookies' | 'application-database' = 'cookies'
): Promise<RecoverableDesktopFixture> => {
  const { BrowserWindow } = await import('electron')
  const { isMainWindow } = await import('./windows')
  const { DesktopBackendStartupError } = await import('./backend-startup')
  const frame = {}
  const window = {
    isDestroyed: () => false,
    webContents: { id: 11, mainFrame: frame, isDestroyed: () => false, send: vi.fn() }
  } as unknown as import('electron').BrowserWindow
  f.mainWindows = [window]
  vi.spyOn(BrowserWindow, 'fromWebContents').mockReturnValue(window)
  vi.mocked(isMainWindow).mockReturnValue(true)
  f.lifecycle.mockReturnValue({
    showMainWindow: vi.fn(),
    getMainWindow: () => window,
    isMainWindowHidden: () => false,
    onSystemShutdown: vi.fn()
  })
  const client = {
    ownsRuntime: () => false,
    processId: () => 123,
    runtimeInfo: () => ({
      generation: restartGeneration,
      control: 'granted',
      startupOptions: { ...restartConfiguration, dataRoot: '/test/current-data', host: '127.0.0.1' }
    }),
    startupState: () => ({ phase: 'checking' }),
    invokeHost: async () => ({ locale: 'en' }),
    close: vi.fn(),
    waitForStopped: vi.fn(async () => ({ release: vi.fn() }))
  }
  let callbacks!: Parameters<typeof import('./desktop-runtime-client').connectDesktopRuntime>[0]
  f.connect.mockImplementation(async (options) => {
    callbacks = options
    return client
  })
  f.launch.mockResolvedValue({})
  await import('./index')
  await vi.waitFor(() => expect(f.completedStartup).toHaveBeenCalledOnce())
  expect(f.report).not.toHaveBeenCalled()
  const event = { sender: window.webContents, senderFrame: frame }
  const getState = (): import('../shared/desktop-runtime-recovery').DesktopRuntimeRecoveryState =>
    f.handlers.get('desktop-runtime:get-state')!(
      event
    ) as import('../shared/desktop-runtime-recovery').DesktopRuntimeRecoveryState
  const lifecycle = f.lifecycle.mock.calls[0][0] as import('./app-lifecycle').AppLifecycleDeps
  const failReplacement = async (): Promise<void> => {
    f.launch.mockRejectedValue(
      new DesktopBackendStartupError(
        'Profile inventory is busy.',
        'credentials',
        true,
        '/test/logs',
        {
          protocolVersion: 1,
          attemptId: restartGeneration,
          stage: 'credentials',
          kind: 'failed',
          code: 'credential-unavailable',
          reason: 'ciphertext-inventory-unavailable',
          diagnostic: {
            code: 'inventory-failed',
            source,
            stage: 'read-files',
            reason: 'operation-failed',
            systemCode: 'EBUSY'
          }
        }
      )
    )
    f.processAlive = false
    callbacks.onDisconnect(new Error('Fixture service exited.'))
    await vi.waitFor(() => expect(getState().reason).toBe('startup-failed'))
  }
  return {
    window,
    event,
    callbacks,
    lifecycle,
    getState,
    failReplacement,
    restart: () =>
      f.handlers.get('desktop-runtime:restart-app')!(event) as Promise<'blocked' | 'restarting'>
  }
}

it('keeps the desktop open when any recovery restart save fails', async () => {
  const desktop = await startRecoverableDesktop()
  await desktop.failReplacement()
  const second = {
    isDestroyed: () => false,
    webContents: { id: 12, mainFrame: {}, isDestroyed: () => false, send: vi.fn() }
  } as unknown as import('electron').BrowserWindow
  f.mainWindows.push(second)
  f.flush.mockResolvedValueOnce('completed').mockResolvedValueOnce('renderer-failed')
  expect(await desktop.restart()).toBe('blocked')
  const { createElectronSessionPersistenceFlush } =
    await import('./session-persistence/renderer-flush')
  expect(createElectronSessionPersistenceFlush).toHaveBeenCalledWith(
    expect.any(Function),
    undefined,
    'recovery-restart'
  )
  expect(f.flush).toHaveBeenCalledTimes(2)
  expect(f.app.quit).not.toHaveBeenCalled()
  expect(f.app.relaunch).not.toHaveBeenCalled()
  expect(desktop.getState().closing).toBe(false)
  await desktop.lifecycle.beforeExit?.()
  expect(f.app.relaunch).not.toHaveBeenCalled()
})

it('admits a saved recovery restart through quit and schedules its successor only before exit', async () => {
  const desktop = await startRecoverableDesktop()
  await desktop.failReplacement()
  const authorization = {
    version: 1 as const,
    generation: restartGeneration,
    explicit: false,
    stopping: true,
    reason: 'disconnect' as const
  }
  f.readLifetime.mockResolvedValue(authorization)
  expect(await desktop.restart()).toBe('restarting')
  expect(f.app.quit).toHaveBeenCalledOnce()
  expect(f.app.relaunch).not.toHaveBeenCalled()
  expect(await desktop.lifecycle.flushSessionPersistence()).toBe('completed')
  expect(f.flush).toHaveBeenCalledTimes(2)
  await desktop.lifecycle.beforeExit?.()
  const { readDesktopRecoveryLaunch } = await import('./desktop-recovery-restart')
  expect(f.app.relaunch).toHaveBeenCalledOnce()
  const relaunch = f.app.relaunch.mock.calls[0][0] as { args: string[] }
  expect(readDesktopRecoveryLaunch(relaunch.args)).toEqual({
    configuration: restartConfiguration,
    authorization
  })
  expect(JSON.stringify(relaunch)).not.toContain('synthetic-profile-ciphertext')
  expect(JSON.stringify(relaunch)).not.toContain('dataRoot')
  await desktop.lifecycle.beforeExit?.()
  expect(f.app.relaunch).toHaveBeenCalledOnce()
})

it.each(['connected', 'application-database'] as const)(
  'does not expose application restart for a %s recovery state',
  async (state) => {
    const desktop = await startRecoverableDesktop(state === 'connected' ? 'cookies' : state)
    if (state !== 'connected') await desktop.failReplacement()
    expect(await desktop.restart()).toBe('blocked')
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.app.quit).not.toHaveBeenCalled()
    expect(f.app.relaunch).not.toHaveBeenCalled()
  }
)

it.each(['abort', 'error', 'cancelled', 'admission-release'] as const)(
  'clears the recovery restart intention after quit %s',
  async (cancellation) => {
    const desktop = await startRecoverableDesktop()
    await desktop.failReplacement()
    expect(await desktop.restart()).toBe('restarting')
    if (cancellation === 'abort') await desktop.lifecycle.abortQuitPreparation()
    else if (cancellation === 'error')
      desktop.lifecycle.onQuitError?.(new Error('Fixture quit failed.'))
    else if (cancellation === 'cancelled') desktop.lifecycle.onQuitCancelled?.()
    else desktop.lifecycle.holdSettingsInstallAdmission()()
    f.handlers.get('desktop-runtime:quit')!(desktop.event)
    await desktop.lifecycle.beforeExit?.()
    expect(f.app.relaunch).not.toHaveBeenCalled()
    expect(desktop.getState().closing).toBe(false)
  }
)

it('honors Quit chosen while recovery restart authorization is still being read', async () => {
  const desktop = await startRecoverableDesktop()
  await desktop.failReplacement()
  let read!: (value: undefined) => void
  f.readLifetime.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        read = resolve
      })
  )
  const restarting = desktop.restart()
  f.handlers.get('desktop-runtime:quit')!(desktop.event)
  read(undefined)
  expect(await restarting).toBe('blocked')
  expect(f.app.quit).toHaveBeenCalledOnce()
  expect(f.flush).not.toHaveBeenCalled()
  await desktop.lifecycle.beforeExit?.()
  expect(f.app.relaunch).not.toHaveBeenCalled()
})

it('cancels the successor when the lifecycle persistence drain fails after restart admission', async () => {
  const desktop = await startRecoverableDesktop()
  await desktop.failReplacement()
  expect(await desktop.restart()).toBe('restarting')
  f.flush.mockResolvedValueOnce('renderer-failed')
  expect(await desktop.lifecycle.flushSessionPersistence()).toBe('renderer-failed')
  await desktop.lifecycle.beforeExit?.()
  expect(f.app.relaunch).not.toHaveBeenCalled()
})

it.each(['system', 'update'] as const)(
  'does not reopen the application during %s shutdown',
  async (trigger) => {
    const desktop = await startRecoverableDesktop()
    await desktop.failReplacement()
    expect(await desktop.restart()).toBe('restarting')
    const { markApplicationShutdownTrigger, clearApplicationShutdownTrigger } =
      await import('./application-shutdown-trigger')
    markApplicationShutdownTrigger(trigger)
    await desktop.lifecycle.beforeExit?.()
    expect(f.app.relaunch).not.toHaveBeenCalled()
    clearApplicationShutdownTrigger()
    f.handlers.get('desktop-runtime:quit')!(desktop.event)
    await desktop.lifecycle.beforeExit?.()
    expect(f.app.relaunch).not.toHaveBeenCalled()
  }
)

it('starts a recovery successor with its reviewed profile and newly captured inventory', async () => {
  const argv = process.argv
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const configuration = {
    ...restartConfiguration,
    configRoot: '/test/reviewed-config',
    profilePath: '/test/reviewed-profile',
    port: 44189
  }
  const authorization = {
    version: 1 as const,
    generation: restartGeneration,
    explicit: false,
    stopping: true,
    reason: 'disconnect' as const
  }
  const launch = { configuration, authorization }
  process.argv = [
    'app',
    '--credential-store=file',
    '--open-science-recovery-launch=' + Buffer.from(JSON.stringify(launch)).toString('base64url')
  ]
  const fresh = Buffer.from('fresh-current-inventory')
  f.inventory.mockReturnValueOnce([fresh])
  f.readLifetime.mockResolvedValue(authorization)
  f.launch.mockImplementation(async (options) => {
    await options.beforeLaunch?.()
    throw new Error('Fixture successor launch completed its admission checks.')
  })
  try {
    await import('./index')
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(1))
    expect(f.app.setPath).toHaveBeenCalledWith('userData', configuration.profilePath)
    expect(f.inventory).toHaveBeenCalledExactlyOnceWith({
      configRoot: configuration.configRoot,
      profilePath: configuration.profilePath
    })
    expect(f.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        configRoot: configuration.configRoot,
        profilePath: configuration.profilePath,
        credentialInventory: [fresh],
        args: ['--credential-store=os', '--password-store=basic', '--serve=44189']
      })
    )
    expect(f.readLifetime).toHaveBeenCalledWith(configuration.configRoot)
    expect(f.app.commandLine.appendSwitch).toHaveBeenCalledWith('password-store', 'basic')
    expect(f.inventory.mock.invocationCallOrder[0]).toBeLessThan(
      f.app.whenReady.mock.invocationCallOrder[0]
    )
  } finally {
    process.argv = argv
    Object.defineProperty(process, 'platform', platform)
  }
})

it('removes an earlier recovery authorization from a later ordinary runtime relaunch', async () => {
  const argv = process.argv
  const authorization = {
    version: 1 as const,
    generation: restartGeneration,
    explicit: false,
    stopping: true,
    reason: 'disconnect' as const
  }
  process.argv = [
    'app',
    '--open-science-recovery-launch=' +
      Buffer.from(JSON.stringify({ configuration: restartConfiguration, authorization })).toString(
        'base64url'
      )
  ]
  try {
    const desktop = await startRecoverableDesktop()
    const request = { request: { operation: 'runtime-relaunch' } } as Parameters<
      NonNullable<typeof desktop.callbacks.onNativeRequest>
    >[0]
    expect(await desktop.callbacks.onNativeRequest?.(request, new AbortController().signal)).toBe(
      true
    )
    desktop.callbacks.onNativeResponseSent?.(request, true)
    await vi.waitFor(() => expect(f.app.relaunch).toHaveBeenCalledOnce())
    const { readDesktopRecoveryLaunch } = await import('./desktop-recovery-restart')
    expect(
      readDesktopRecoveryLaunch((f.app.relaunch.mock.calls[0][0] as { args: string[] }).args)
    ).toEqual({ configuration: restartConfiguration, mode: 'ordinary' })
  } finally {
    process.argv = argv
  }
})
