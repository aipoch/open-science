import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { ipcEvents, startupWindow } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcEvents: new EventEmitter(),
    startupWindow: Object.assign(new EventEmitter(), {
      webContents: new EventEmitter(),
      isDestroyed: () => false,
      destroy: vi.fn()
    })
  }
})

const fixture = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    log,
    startupFailure: vi.fn(),
    disposeLocaleIpc: vi.fn(),
    disposeDatabaseGuard: vi.fn(),
    disposeDatabaseIpc: vi.fn(),
    disposePreviewProtocol: vi.fn(),
    headless: true,
    disposeRuntime: vi.fn(async () => {}),
    disposeWeb: vi.fn(async () => {}),
    shutdownRemote: vi.fn(async () => {}),
    exited: Promise.resolve(),
    finishExit: () => {},
    failAt: 'web' as 'icon' | 'remote' | 'web' | 'none',
    ready: Promise.resolve(),
    finishReady: () => {},
    shutdownBackends: undefined as (() => Promise<unknown>) | undefined,
    configureDesktop: vi.fn(),
    syncViewState: vi.fn(async () => {}),
    sender: { id: 7, send: vi.fn(), isDestroyed: () => false },
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
      ipcMain: ipcEvents,
      powerMonitor: {},
      crashReporter: {}
    }
  }
})
vi.mock('electron', () => fixture.electron)
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
  parseWebModeOptions: () => ({ headless: fixture.headless, enabled: true, port: 44100 })
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
  createManagedPreviewProtocolBridge: () => ({
    registrar: {},
    dispose: fixture.disposePreviewProtocol
  })
}))
vi.mock('./windows', () => ({
  configureMainWindow: vi.fn(),
  createMainWindow: () => {
    queueMicrotask(() => startupWindow.emit('ready-to-show'))
    return startupWindow
  }
}))
vi.mock('./locale/owner', () => ({
  LocalePreferenceOwner: class {
    t = (key: string): string => key
    subscribe = (): ReturnType<typeof vi.fn> => vi.fn()
  }
}))
vi.mock('./locale/ipc', () => ({ registerLocalePreferenceIpc: () => fixture.disposeLocaleIpc }))
vi.mock('./window-shortcuts', () => ({ installWindowShortcuts: vi.fn() }))
vi.mock('./network-ipc', () => ({ registerNetworkIpcHandlers: vi.fn() }))
vi.mock('./database/database-startup-logging', () => ({
  createDatabaseStartupLogging: () => ({ migrationOptions: vi.fn(), reportBlocked: vi.fn() })
}))
vi.mock('./database/database-startup-ipc', () => ({
  registerDatabaseStartupIpc: () => fixture.disposeDatabaseIpc,
  installDatabaseStartupQuitGuard: () => ({
    dispose: fixture.disposeDatabaseGuard,
    release: vi.fn()
  })
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
    notificationInbox: {
      configureDesktop: fixture.configureDesktop,
      syncViewState: fixture.syncViewState,
      refreshBadge: vi.fn()
    },
    taskNotifications: { setActivationHandler: () => fixture.finishReady() },
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
vi.mock('./app-lifecycle', () => ({
  installAppLifecycle: (options: { shutdownBackends: () => Promise<unknown> }) => {
    fixture.shutdownBackends = options.shutdownBackends
    return {
      showMainWindow: vi.fn(),
      getMainWindow: () => ({ webContents: fixture.sender, isFocused: () => true }),
      isMainWindowHidden: () => false,
      onSystemShutdown: vi.fn()
    }
  }
}))
vi.mock('./ipc-handler-registry', () => ({ disposeIpcHandlerRegistry: vi.fn() }))
vi.mock('./web-service', () => ({
  createWebServiceController: () => ({
    ensureStarted: async () => {
      if (fixture.failAt === 'web') throw fixture.failure
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

const monitorListeners = process.listeners('uncaughtExceptionMonitor')
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  ipcEvents.removeAllListeners()
  fixture.exited = new Promise<void>((resolve) => {
    fixture.finishExit = resolve
  })
  fixture.electron.app.exit.mockImplementation(() => fixture.finishExit())
  fixture.ready = new Promise<void>((resolve) => {
    fixture.finishReady = resolve
  })
  fixture.shutdownBackends = undefined
  fixture.failAt = 'web'
  fixture.headless = true
  fixture.disposeDatabaseGuard.mockReset()
  fixture.disposeDatabaseIpc.mockReset()
  fixture.disposePreviewProtocol.mockReset()
  startupWindow.destroy.mockReset()
  startupWindow.removeAllListeners()
  startupWindow.webContents.removeAllListeners()
  fixture.disposeLocaleIpc.mockReset()
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
  await fixture.exited
  expect(fixture.electron.app.exit).toHaveBeenCalledWith(1)
  expect(fixture.startupFailure).toHaveBeenCalledWith(
    expect.objectContaining({ error: fixture.failure })
  )
  expect.soft(fixture.disposeRuntime).toHaveBeenCalledOnce()
  expect.soft(fixture.disposeWeb).toHaveBeenCalledOnce()
  expect.soft(fixture.shutdownRemote).toHaveBeenCalledOnce()
})

it('reports the original startup failure when shell IPC cleanup throws', async () => {
  const cleanupFailure = new Error('locale IPC cleanup failed')
  fixture.disposeLocaleIpc.mockImplementation(() => {
    throw cleanupFailure
  })
  await import('./index')
  await fixture.exited

  expect(fixture.disposeLocaleIpc).toHaveBeenCalledOnce()
  expect(fixture.electron.app.exit).toHaveBeenCalledWith(1)
  expect(fixture.startupFailure).toHaveBeenCalledWith(
    expect.objectContaining({ error: fixture.failure })
  )
})

it.each([
  'locale IPC',
  'database guard',
  'preview protocol',
  'database IPC',
  'startup window',
  'none'
] as const)('continues shell rollback after %s cleanup throws', async (stage) => {
  fixture.headless = false
  const cleanupFailure = new Error(`${stage} cleanup failed`)
  const failingCleanup = {
    'locale IPC': fixture.disposeLocaleIpc,
    'database guard': fixture.disposeDatabaseGuard,
    'preview protocol': fixture.disposePreviewProtocol,
    'database IPC': fixture.disposeDatabaseIpc,
    'startup window': startupWindow.destroy,
    none: undefined
  }[stage]
  if (stage === 'preview protocol') failingCleanup?.mockImplementationOnce(() => undefined)
  failingCleanup?.mockImplementation(() => {
    throw cleanupFailure
  })
  await import('./index')
  await fixture.exited

  const cleanup = [
    fixture.disposeLocaleIpc,
    fixture.disposeDatabaseGuard,
    fixture.disposeDatabaseIpc,
    startupWindow.destroy,
    fixture.electron.app.quit
  ]
  for (const dispose of cleanup) expect(dispose).toHaveBeenCalledOnce()
  expect(fixture.disposePreviewProtocol).toHaveBeenCalledTimes(2)
  expect(fixture.disposeDatabaseGuard.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.disposePreviewProtocol.mock.invocationCallOrder[1]
  )
  expect(fixture.disposePreviewProtocol.mock.invocationCallOrder[1]).toBeLessThan(
    fixture.disposeDatabaseIpc.mock.invocationCallOrder[0]
  )
  for (let i = 1; i < cleanup.length; i++) {
    expect
      .soft(cleanup[i - 1].mock.invocationCallOrder[0])
      .toBeLessThan(cleanup[i].mock.invocationCallOrder[0])
  }
  if (stage !== 'none') {
    expect(fixture.log.warn).toHaveBeenCalledWith('Startup shell cleanup failed', cleanupFailure)
  }
  expect(fixture.electron.app.exit).toHaveBeenCalledWith(1)
  expect(fixture.startupFailure).toHaveBeenCalledWith(
    expect.objectContaining({ error: fixture.failure })
  )
})

it.each(['icon', 'remote'] as const)(
  'cleans the runtime when %s preparation fails without disposing uncreated services',
  async (stage) => {
    fixture.failAt = stage
    await import('./index')
    await fixture.exited
    expect(fixture.electron.app.exit).toHaveBeenCalledWith(1)
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
    await fixture.exited
    expect(fixture.electron.app.exit).toHaveBeenCalledWith(1)
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

it.each(['icon', 'remote', 'web'] as const)(
  'removes the real visibility IPC listener when %s startup fails',
  async (stage) => {
    fixture.failAt = stage
    const external = vi.fn()
    ipcEvents.on('notifications:sync-unread-view', external)
    await import('./index')
    await fixture.exited
    expect(fixture.startupFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: fixture.failure })
    )
    expect(ipcEvents.listeners('notifications:sync-unread-view')).toEqual([external])
  }
)

it('stops visibility writes before runtime disposal and fails pending probes closed on shutdown', async () => {
  fixture.failAt = 'none'
  const external = vi.fn()
  ipcEvents.on('notifications:sync-unread-view', external)
  const emitView = (): void => {
    ipcEvents.emit(
      'notifications:sync-unread-view',
      { sender: fixture.sender },
      { visibleSessionId: 'session-1' }
    )
  }
  await import('./index')
  await fixture.ready
  emitView()
  await Promise.resolve()
  expect(fixture.syncViewState).toHaveBeenCalledOnce()
  const desktop = fixture.configureDesktop.mock.calls[0][0] as {
    confirmSessionVisible: (sessionId: string) => Promise<boolean>
  }
  const settled = vi.fn()
  void desktop.confirmSessionVisible('session-1').then(settled)
  expect(fixture.sender.send).toHaveBeenCalledWith(
    'notifications:probe-unread-view',
    expect.any(Number)
  )
  let finishRuntime!: () => void
  const runtimePaused = new Promise<void>((resolve) => {
    finishRuntime = resolve
  })
  let enterRuntime!: () => void
  const runtimeEntered = new Promise<void>((resolve) => {
    enterRuntime = resolve
  })
  fixture.disposeRuntime.mockImplementation(async () => {
    emitView()
    enterRuntime()
    await runtimePaused
  })
  const shutdown = fixture.shutdownBackends!()
  await runtimeEntered
  expect.soft(fixture.syncViewState).toHaveBeenCalledOnce()
  expect.soft(settled).toHaveBeenCalledExactlyOnceWith(false)
  expect.soft(ipcEvents.listeners('notifications:sync-unread-view')).toEqual([external])
  finishRuntime()
  await shutdown
  await fixture.shutdownBackends!()
  await Promise.resolve()
  expect.soft(fixture.syncViewState).toHaveBeenCalledOnce()
  expect.soft(settled).toHaveBeenCalledExactlyOnceWith(false)
  expect.soft(ipcEvents.listeners('notifications:sync-unread-view')).toEqual([external])
  expect(fixture.disposeRuntime).toHaveBeenCalledOnce()
  fixture.sender.send.mockClear()
  emitView()
  const retired = vi.fn()
  void desktop.confirmSessionVisible('session-2').then(retired)
  await Promise.resolve()
  expect.soft(retired).toHaveBeenCalledExactlyOnceWith(false)
  expect.soft(fixture.sender.send).not.toHaveBeenCalled()
  expect(fixture.syncViewState).toHaveBeenCalledOnce()
})
