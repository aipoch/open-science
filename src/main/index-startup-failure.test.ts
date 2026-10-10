import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CredentialIdentityError } from './credential-identity/selection'

// Exercise the real production entry up to the process boundary. Database/runtime failures belong
// to Node's startup owner; Electron must not construct a second store while handling those failures.
const f = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    log,
    ready: false,
    lock: true,
    fail: undefined as unknown,
    leaseRelease: vi.fn(),
    select: vi.fn(),
    validate: vi.fn(),
    key: vi.fn(),
    launch: vi.fn(),
    diagnostics: vi.fn(),
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
      getPath: vi.fn(() => '/test/home'),
      getAppPath: () => '/test/app',
      getVersion: () => 'test',
      getLocale: () => 'en',
      getPreferredSystemLanguages: () => ['en'],
      commandLine: { getSwitchValue: () => '' },
      isReady: (): boolean => false,
      whenReady: vi.fn(async () => {}),
      requestSingleInstanceLock: vi.fn(() => true)
    },
    dialog: { showErrorBox: vi.fn() },
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
vi.mock('./runtime-metadata', () => ({ configureRuntimeMetadata: vi.fn() }))
vi.mock('./ipc-handler-registry', () => ({
  configureIpcHandlerRegistry: vi.fn(),
  ipcMainHandle: (name: string, fn: (...args: unknown[]) => unknown) => f.handlers.set(name, fn)
}))
vi.mock('./runtime-ownership', () => ({
  acquireRuntimeDirectorySync: () => ({ release: f.leaseRelease })
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
vi.mock('./storage/electron-profile', () => ({
  resolveBootstrapConfigRoot: () => '/test/config',
  resolveElectronProfile: () => '/test/profile'
}))
vi.mock('./desktop-runtime-launcher', () => ({
  desktopBackendPaths: () => ({ command: '/test/node', entry: '/test/backend.cjs' }),
  startOrAttachDesktopBackend: f.launch
}))
vi.mock('./desktop-native-electron', () => ({ createDesktopNativeHandler: vi.fn() }))
vi.mock('./logger', async (original) => ({
  ...(await original<typeof import('./logger')>()),
  createLogger: () => f.log,
  flushLogs: vi.fn(async () => {}),
  writeFatalLogSync: vi.fn()
}))
vi.mock('./diagnostics/startup', () => ({
  initializeApplicationDiagnostics: () => {
    f.diagnostics()
    return { log: f.log, operation: { phase: vi.fn(), complete: vi.fn() } }
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
  createMainWindow: vi.fn(),
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
vi.mock('./app-lifecycle', () => ({ installAppLifecycle: vi.fn() }))
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
  vi.clearAllMocks()
  f.ready = false
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
afterEach(() => vi.restoreAllMocks())

it.each(['mac-keychain', 'windows-dpapi'] as const)(
  'completes %s identity preflight before yielding to Electron, without acquiring business ownership',
  async (backend) => {
    f.select.mockReturnValue({ backend, appName: 'Open-Science (DEV)', exists: true })
    await import('./index')
    await vi.waitFor(() => expect(f.app.exit).toHaveBeenCalledWith(1))
    expect(f.validate).toHaveBeenCalledWith(expect.objectContaining({ backend }), {
      configRoot: '/test/config',
      profilePath: '/test/profile'
    })
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
        entry: '/test/backend.cjs'
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
  f.validate.mockImplementationOnce(() => {
    throw new CredentialIdentityError('windows-profile-key-unavailable')
  })
  await import('./index')
  expect(f.app.exit).toHaveBeenCalledWith(1)
  expect(f.leaseRelease).toHaveBeenCalledOnce()
  expect(f.app.whenReady).not.toHaveBeenCalled()
  expect(f.key).not.toHaveBeenCalled()
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.diagnostics).not.toHaveBeenCalled()
  expect(f.log.error.mock.invocationCallOrder[0]).toBeLessThan(
    f.dialog.showErrorBox.mock.invocationCallOrder[0]
  )
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
