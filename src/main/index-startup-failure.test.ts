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
    diagnostics: vi.fn(),
    completedStartup: vi.fn(),
    windowsStartup: vi.fn(),
    verifyRecovery: vi.fn(async () => {}),
    report: vi.fn(async () => undefined),
    app: {
      isPackaged: false,
      setName: vi.fn(),
      setPath: vi.fn(),
      setAppLogsPath: vi.fn(),
      quit: vi.fn(),
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
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
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
  resolveElectronProfile: () => '/test/profile'
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
  showMacInstallationGuidance: vi.fn()
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
  createElectronSessionPersistenceFlush: vi.fn(),
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
  'keeps a window reachable after canceling disconnected native quit without a tray (%s)',
  async (platform) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform })
    try {
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
      const quitListeners = f.app.on.mock.calls.filter(([event]) => event === 'before-quit')
      const onQuit = quitListeners.at(-1)![1]
      const event = { preventDefault: vi.fn() }
      onQuit(event)
      await vi.waitFor(() => expect(f.dialog.showMessageBox).toHaveBeenCalledOnce())
      expect(event.preventDefault).toHaveBeenCalled()
      if (platform === 'darwin') expect(showMainWindow).not.toHaveBeenCalled()
      else await vi.waitFor(() => expect(showMainWindow).toHaveBeenCalledOnce())
      expect(client.close).not.toHaveBeenCalled()
      expect(f.app.exit).not.toHaveBeenCalled()
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

it('refreshes cached package progress when an operation completed while desktop was disconnected', async () => {
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
    const client = {
      ownsRuntime: () => false,
      processId: () => 123,
      runtimeInfo: () => ({ generation: 'reconnect' }),
      invokeHost: async (channel: string) =>
        channel === 'desktop:package-operation-snapshot' ? completed : { locale: 'en' },
      startupState: () => ({ phase: 'checking' }),
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
    await activate(
      client as unknown as Parameters<RecoveryOptions['activate']>[0],
      new AbortController().signal,
      () => undefined
    )
    expect(f.handlers.get('package-presentation:get-state')!(event)).toEqual(completed)
  } finally {
    vi.doUnmock('./desktop-runtime-recovery')
    vi.doUnmock('./desktop-preview-proxy')
  }
})
