import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    log,
    startupFailure: vi.fn(),
    disposeRuntime: vi.fn(async () => {}),
    disposeWeb: vi.fn(async () => {}),
    shutdownRemote: vi.fn(async () => {}),
    failAt: 'web' as 'icon' | 'remote' | 'web',
    failure: Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }),
    electron: {
      app: {
        isPackaged: true,
        setName: vi.fn(),
        getPath: () => '/isolated-test',
        getVersion: () => '0.0.0',
        on: vi.fn(),
        whenReady: async () => {},
        getPreferredSystemLanguages: () => ['en'],
        quit: vi.fn(),
        exit: vi.fn(),
        setBadgeCount: vi.fn(),
        isUnityRunning: () => false
      },
      BrowserWindow: { getAllWindows: () => [] },
      protocol: { registerSchemesAsPrivileged: vi.fn() },
      nativeImage: {},
      nativeTheme: {},
      ipcMain: {},
      powerMonitor: {},
      crashReporter: {}
    }
  }
})
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string) => {
      const require = actual.createRequire(url)
      return (id: string) => (id === 'electron' ? fixture.electron : require(id))
    }
  }
})
vi.mock('./logger', () => ({
  createLogger: () => fixture.log,
  diagnosticErrorFields: (e: unknown) => e,
  flushLogs: vi.fn(),
  writeFatalLogSync: vi.fn()
}))
vi.mock('./diagnostics/startup', () => ({
  initializeApplicationDiagnostics: () => ({
    log: fixture.log,
    operation: { phase: vi.fn(), fail: vi.fn(), complete: vi.fn() },
    flush: vi.fn()
  }),
  reportApplicationStartupFailure: fixture.startupFailure
}))
vi.mock('./settings/credential-store-mode', () => ({ configureCredentialStore: vi.fn() }))
vi.mock('./crash-diagnostics', () => ({
  installChildProcessGoneLogging: vi.fn(),
  startLocalCrashReporting: () => ({ enabled: false })
}))
vi.mock('./managed-preview-resources', () => ({ MANAGED_PREVIEW_SCHEME: {} }))
vi.mock('./office-preview/office-preview-runtime-protocol', () => ({
  OFFICE_PREVIEW_RUNTIME_SCHEME_CONFIG: {}
}))
vi.mock('./renderer-diagnostics', () => ({
  createRendererFailureReporter: vi.fn(),
  registerRendererDiagnosticsIpc: vi.fn()
}))
vi.mock('./single-instance', () => ({ acquireSingleInstanceLock: () => true }))
vi.mock('./web-service/options', () => ({
  parseWebModeOptions: () => ({ headless: true, enabled: true, port: 44100 })
}))
vi.mock('./system-lifecycle-adapters', () => ({
  installSystemLifecycleAdapters: () => ({
    bindWindow: vi.fn(),
    installPowerMonitorListeners: vi.fn()
  })
}))
vi.mock('./diagnostics/startup-storage-probe', () => ({ timedStartupStorageProbe: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ electronApp: { setAppUserModelId: vi.fn() } }))
vi.mock('./managed-preview-protocol', () => ({
  createManagedPreviewProtocolBridge: () => ({ registrar: {}, dispose: vi.fn() })
}))
vi.mock('./windows', () => ({ configureMainWindow: vi.fn(), createMainWindow: vi.fn() }))
vi.mock('./locale/owner', () => ({
  LocalePreferenceOwner: class {
    t = (key: string): string => key
    subscribe = (): ReturnType<typeof vi.fn> => vi.fn()
  }
}))
vi.mock('./locale/ipc', () => ({ registerLocalePreferenceIpc: () => vi.fn() }))
vi.mock('./window-shortcuts', () => ({ installWindowShortcuts: vi.fn() }))
vi.mock('./network-ipc', () => ({ registerNetworkIpcHandlers: vi.fn() }))
vi.mock('./database/database-startup-logging', () => ({
  createDatabaseStartupLogging: () => ({ migrationOptions: vi.fn(), reportBlocked: vi.fn() })
}))
vi.mock('./database/database-startup-ipc', () => ({
  registerDatabaseStartupIpc: () => vi.fn(),
  installDatabaseStartupQuitGuard: () => ({ dispose: vi.fn(), release: vi.fn() })
}))
vi.mock('./database/startup-diagnostics', () => ({ buildStartupDiagnostics: vi.fn() }))
vi.mock('./projects/prisma-client', () => ({ getProjectDbClient: async () => ({}) }))
vi.mock('./storage-root', () => ({ resolveConfigRoot: () => '/isolated-test' }))
vi.mock('./settings/document-store', () => ({ SettingsDocumentStore: class {} }))
vi.mock('./settings/repository', () => ({
  SettingsRepository: class {
    getSettings = async (): Promise<Record<string, never>> => ({})
  }
}))
vi.mock('./ipc', () => ({
  registerIpcHandlers: async () => ({
    dispose: fixture.disposeRuntime,
    notificationInbox: { configureDesktop: vi.fn() },
    settingsService: {
      getAppIconVariant: async () => {
        if (fixture.failAt === 'icon') throw fixture.failure
        return 'light'
      }
    },
    bindRemoteAccess: vi.fn()
  })
}))
vi.mock('./storage/migration-state', () => ({
  installMigrationQuitGuard: vi.fn(),
  isMigrationInProgress: () => false
}))
vi.mock('./tray', () => ({
  createAppTray: vi.fn(),
  refreshAppTrayLocale: vi.fn(),
  setTrayIconVariant: vi.fn()
}))
vi.mock('./app-lifecycle', () => ({ installAppLifecycle: vi.fn() }))
vi.mock('./ipc-handler-registry', () => ({ disposeIpcHandlerRegistry: vi.fn() }))
vi.mock('./web-service', () => ({
  createWebServiceController: () => ({
    ensureStarted: async () => {
      throw fixture.failure
    },
    dispose: fixture.disposeWeb
  }),
  buildAuthenticatedWebUrl: vi.fn()
}))
vi.mock('./second-instance-router', () => ({ routeSecondInstance: vi.fn() }))
vi.mock('./window-close-confirm', () => ({ createElectronCloseConfirm: vi.fn() }))
vi.mock('./session-persistence/renderer-flush', () => ({
  createElectronSessionPersistenceFlush: vi.fn(),
  notifyRendererSessionPersistenceFlushAborted: vi.fn(),
  rendererSessionPersistenceFlushBlocksShutdown: vi.fn()
}))
vi.mock('./app-icon', () => ({
  createAppIconController: () => ({}),
  buildAppIconPreviews: vi.fn()
}))
vi.mock('./remote-access', () => ({
  RemoteAccessService: {
    create: async () => {
      if (fixture.failAt === 'remote') throw fixture.failure
      return {
        webAccess: {},
        attachWebController: vi.fn(),
        shutdown: fixture.shutdownRemote,
        restore: vi.fn()
      }
    }
  },
  registerRemoteAccessIpcHandlers: vi.fn()
}))
vi.mock('./notifications/desktop-attention', () => ({
  createDesktopAttentionController: vi.fn(),
  wireDesktopAttention: vi.fn()
}))
vi.mock('./notifications/desktop-badge', () => ({
  createDesktopBadgeAdapter: vi.fn(),
  createWindowsBadgeBitmap: vi.fn()
}))
vi.mock('./notifications/notification-inbox-controller', () => ({
  wireNotificationInboxController: vi.fn()
}))
vi.mock('./notifications/unread-task-ipc', () => ({
  registerUnreadTaskIpc: () => ({ confirmSessionVisible: async () => false })
}))

const monitorListeners = process.listeners('uncaughtExceptionMonitor')
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.failAt = 'web'
  fixture.disposeWeb.mockReset().mockResolvedValue()
  fixture.disposeRuntime.mockReset().mockResolvedValue()
})
afterEach(() => {
  for (const listener of process.listeners('uncaughtExceptionMonitor')) {
    if (!monitorListeners.includes(listener))
      process.removeListener('uncaughtExceptionMonitor', listener)
  }
})

it('disposes acquired application surfaces when explicit web startup fails before context handoff', async () => {
  // Exercise the real process entry, startup orchestration and database owner; replace only
  // environmental services so the existing web-start boundary deterministically rejects.
  await import('./index')
  await vi.waitFor(() => expect(fixture.electron.app.exit).toHaveBeenCalledWith(1))
  expect(fixture.startupFailure).toHaveBeenCalledWith(
    expect.objectContaining({ error: fixture.failure })
  )
  expect.soft(fixture.disposeRuntime).toHaveBeenCalledOnce()
  expect.soft(fixture.disposeWeb).toHaveBeenCalledOnce()
  expect.soft(fixture.shutdownRemote).toHaveBeenCalledOnce()
})

it.each(['icon', 'remote'] as const)(
  'cleans the runtime when %s preparation fails without disposing uncreated services',
  async (stage) => {
    fixture.failAt = stage
    await import('./index')
    await vi.waitFor(() => expect(fixture.electron.app.exit).toHaveBeenCalledWith(1))
    expect(fixture.startupFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: fixture.failure })
    )
    expect(fixture.disposeRuntime).toHaveBeenCalledOnce()
    expect(fixture.disposeWeb).not.toHaveBeenCalled()
    expect(fixture.shutdownRemote).not.toHaveBeenCalled()
  }
)

it.each(['reject', 'hang'] as const)(
  'preserves the startup error and continues cleanup when Web disposal will %s',
  async (failure) => {
    if (failure === 'reject') fixture.disposeWeb.mockRejectedValue(new Error('cleanup failed'))
    else fixture.disposeWeb.mockImplementation(() => new Promise(() => {}))
    await import('./index')
    await vi.waitFor(() => expect(fixture.electron.app.exit).toHaveBeenCalledWith(1), {
      timeout: 4000
    })
    expect(fixture.startupFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: fixture.failure })
    )
    expect(fixture.disposeWeb).toHaveBeenCalledOnce()
    expect(fixture.disposeRuntime).toHaveBeenCalledOnce()
    expect(fixture.shutdownRemote).toHaveBeenCalledOnce()
    expect(fixture.disposeWeb.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.disposeRuntime.mock.invocationCallOrder[0]
    )
    expect(fixture.disposeRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.shutdownRemote.mock.invocationCallOrder[0]
    )
  }
)
