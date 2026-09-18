import type { CredentialIdentity } from './credential-identity/selection'
vi.mock('./credential-identity/bootstrap', () => ({
  selectStartupCredentialIdentity: (...args: unknown[]) =>
    fixture.selectCredentialIdentity(...args),
  prepareCredentialValidation: (...args: unknown[]) => {
    const prepared: unknown = fixture.prepareCredentialValidation(...args)
    return typeof prepared === 'function' ? prepared : fixture.validateCredentials
  }
}))
vi.mock('./storage/electron-profile', () => ({
  resolveBootstrapConfigRoot: () => '/isolated-test',
  resolveElectronProfile: (...args: unknown[]) => fixture.resolveProfile(...args)
}))
vi.mock('./storage/initialize-location', () => ({
  prepareApplicationLocations: async () => {
    await fixture.prepareLocations()
    return {
      settingsStore: {},
      repository: { getSettings: async () => ({}) }
    }
  },
  initializeDataLocation: vi.fn()
}))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// Native integration stays behind filesystem/process doubles, even in packaged/no-override cases.
// Import the real startup entry; mocking the removed brand helper would conceal a lingering call.
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: string) => fixture.bundles.has(path) || actual.existsSync(path),
    renameSync: (...args: unknown[]) => fixture.renameBundle(...args)
  }
})
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: (...args: unknown[]) => fixture.systemCommand(...args),
  spawnSync: (...args: unknown[]) => fixture.nativeProbe(...args)
}))

it.each([
  ['Open-Science.app', true],
  ['Open Science.app', true],
  ['Open Science.app', false],
  ['OpenScience.app', false]
] as const)(
  'starts from %s with old/new coexistence=%s without changing system entries',
  async (name, coexist) => {
    fixture.failAt = 'none'
    fixture.headless = false
    const bundle = `/virtual/Applications/${name}`
    fixture.bundles.add(bundle)
    if (coexist) {
      fixture.bundles.add('/virtual/Applications/Open Science.app')
      fixture.bundles.add('/virtual/Applications/Open-Science.app')
    }
    const before = [...fixture.bundles]
    vi.stubGlobal(
      'process',
      Object.defineProperties(Object.create(process), {
        platform: { value: 'darwin' },
        execPath: { value: `${bundle}/Contents/MacOS/Open-Science` },
        // Simulate ordinary packaged startup, without invoking any real native integration.
        env: {
          value: {
            ...process.env,
            OPEN_SCIENCE_CONFIG_ROOT: '',
            OPEN_SCIENCE_USER_DATA: '',
            OPEN_SCIENCE_E2E_STORAGE_ROOT: ''
          }
        }
      })
    )
    await import('./index')
    await Promise.race([fixture.ready, fixture.exited])
    expect.soft(fixture.configureDesktop).toHaveBeenCalledOnce()
    expect.soft(fixture.electron.app.setName).toHaveBeenLastCalledWith('Open-Science')
    expect.soft(fixture.electron.dialog.showErrorBox).not.toHaveBeenCalled()
    expect.soft(fixture.electron.app.relaunch).not.toHaveBeenCalled()
    expect.soft(fixture.electron.app.exit).not.toHaveBeenCalled()
    expect.soft(fixture.systemCommand).not.toHaveBeenCalled()
    expect.soft(fixture.renameBundle).not.toHaveBeenCalled()
    expect([...fixture.bundles]).toEqual(before)
  }
)

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
    selectCredentialIdentity: vi.fn((...args: unknown[]): CredentialIdentity => {
      void args
      return {
        backend: 'mac-keychain',
        appName: 'Open-Science',
        exists: true
      }
    }),
    prepareCredentialValidation: vi.fn((...args: unknown[]) => {
      void args
    }),
    nativeProbe: vi.fn((...args: unknown[]): unknown => {
      void args
      throw new Error('Unexpected native process in startup fixture')
    }),
    validateCredentials: vi.fn(),
    resolveProfile: vi.fn((...args: unknown[]) => {
      void args
      return '/isolated-test/profile'
    }),
    bundles: new Set<string>(),
    renameBundle: vi.fn((...args: unknown[]) => {
      void args
    }),
    systemCommand: vi.fn((...args: unknown[]) => {
      void args
      return 'com.aipoch.open-science'
    }),
    prepareLocations: vi.fn(async () => {}),
    initializeDiagnostics: vi.fn(),
    routeSecondInstance: vi.fn(),
    openSessionPackageFile: vi.fn(),
    startupFailure: vi.fn(),
    disposeLocaleIpc: vi.fn(),
    disposeDatabaseGuard: vi.fn(),
    disposeDatabaseIpc: vi.fn(),
    disposePreviewProtocol: vi.fn(),
    disposeTrayLocale: vi.fn(),
    disposeRegistry: vi.fn(),
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
        setPath: vi.fn(),
        setAppLogsPath: vi.fn(),
        requestSingleInstanceLock: vi.fn(() => true),
        getPath: () => '/isolated-test',
        getVersion: () => '0.0.0',
        on: vi.fn(),
        whenReady: async () => {},
        getPreferredSystemLanguages: () => ['en'],
        quit: vi.fn(),
        relaunch: vi.fn(),
        exit: vi.fn(),
        setBadgeCount: vi.fn(),
        isUnityRunning: () => false
      },
      dialog: { showErrorBox: vi.fn() },
      Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
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
vi.mock('./logger', async (importOriginal) => ({
  errorLogFields: (await importOriginal<typeof import('./logger')>()).errorLogFields,
  createLogger: () => fixture.log,
  diagnosticErrorFields: vi.fn((e: unknown) => e),
  flushLogs: vi.fn(),
  writeFatalLogSync: vi.fn()
}))
vi.mock('./diagnostics/startup', () => ({
  initializeApplicationDiagnostics: () => {
    fixture.initializeDiagnostics()
    return {
      log: fixture.log,
      operation: { phase: vi.fn(), fail: vi.fn(), complete: vi.fn() },
      flush: vi.fn()
    }
  },
  reportApplicationStartupFailure: fixture.startupFailure
}))
vi.mock('./settings/credential-store-mode', () => ({
  configureCredentialStore: vi.fn(),
  getCredentialStore: () => 'os'
}))
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
vi.mock('./web-service/options', () => ({
  parseWebModeOptions: (argv: string[]) => ({
    headless: fixture.headless,
    enabled: !argv.some((arg) => arg.endsWith('.science')),
    port: 44100
  })
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
    subscribe = (): ReturnType<typeof vi.fn> => fixture.disposeTrayLocale
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
    openSessionPackageFile: fixture.openSessionPackageFile,
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
vi.mock('./ipc-handler-registry', () => ({ disposeIpcHandlerRegistry: fixture.disposeRegistry }))
vi.mock('./web-service', () => ({
  createWebServiceController: () => ({
    ensureStarted: async () => {
      if (fixture.failAt === 'web') throw fixture.failure
    },
    dispose: fixture.disposeWeb
  }),
  buildAuthenticatedWebUrl: vi.fn()
}))
vi.mock('./second-instance-router', () => ({ routeSecondInstance: fixture.routeSecondInstance }))
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
  fixture.bundles.clear()
  fixture.renameBundle.mockReset().mockImplementation((from, to) => {
    fixture.bundles.delete(String(from))
    fixture.bundles.add(String(to))
  })
  ipcEvents.removeAllListeners()
  fixture.exited = new Promise<void>((resolve) => {
    fixture.finishExit = resolve
  })
  fixture.electron.app.exit.mockImplementation(() => fixture.finishExit())
  fixture.ready = new Promise<void>((resolve) => {
    fixture.finishReady = resolve
  })
  fixture.shutdownBackends = undefined
  fixture.selectCredentialIdentity.mockClear()
  fixture.prepareCredentialValidation.mockClear()
  fixture.validateCredentials.mockClear()
  fixture.resolveProfile.mockReset().mockReturnValue('/isolated-test/profile')
  fixture.prepareLocations.mockReset().mockResolvedValue()
  fixture.electron.app.requestSingleInstanceLock.mockReset().mockReturnValue(true)
  fixture.electron.app.isPackaged = true
  fixture.failAt = 'web'
  fixture.headless = true
  fixture.disposeDatabaseGuard.mockReset()
  fixture.disposeDatabaseIpc.mockReset()
  fixture.disposePreviewProtocol.mockReset()
  fixture.disposeTrayLocale.mockReset()
  fixture.disposeRegistry.mockReset()
  startupWindow.destroy.mockReset()
  startupWindow.removeAllListeners()
  startupWindow.webContents.removeAllListeners()
  fixture.disposeLocaleIpc.mockReset()
  fixture.disposeWeb.mockReset().mockResolvedValue()
  fixture.disposeRuntime.mockReset().mockResolvedValue()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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

it.each([
  'tray locale',
  'locale IPC',
  'preview protocol',
  'database IPC',
  'registry',
  'none'
] as const)(
  'attempts all IPC cleanup on lifecycle shutdown when %s cleanup fails',
  async (stage) => {
    fixture.failAt = 'none'
    await import('./index')
    await fixture.ready
    const cleanupFailure = new Error(`${stage} cleanup failed`)
    const cleanup = {
      'tray locale': fixture.disposeTrayLocale,
      'locale IPC': fixture.disposeLocaleIpc,
      'preview protocol': fixture.disposePreviewProtocol,
      'database IPC': fixture.disposeDatabaseIpc,
      registry: fixture.disposeRegistry
    }
    if (stage !== 'none') {
      cleanup[stage].mockImplementation(() => {
        throw cleanupFailure
      })
    }

    const expectedOutcome = stage === 'none' ? 'completed' : 'failed'
    await expect(fixture.shutdownBackends!()).resolves.toBe(expectedOutcome)
    await expect(fixture.shutdownBackends!()).resolves.toBe(expectedOutcome)

    const orderedCleanup = [
      fixture.disposeWeb,
      fixture.disposeRuntime,
      fixture.shutdownRemote,
      ...Object.values(cleanup)
    ]
    for (const dispose of orderedCleanup) expect(dispose).toHaveBeenCalledOnce()
    for (let i = 1; i < orderedCleanup.length; i++) {
      expect(orderedCleanup[i - 1].mock.invocationCallOrder[0]).toBeLessThan(
        orderedCleanup[i].mock.invocationCallOrder[0]
      )
    }
    expect(fixture.startupFailure).not.toHaveBeenCalled()
    if (stage !== 'none') {
      expect(fixture.log.error).toHaveBeenCalledWith(
        'application surface shutdown failed',
        expect.objectContaining({ surface: 'ipc-handlers', result: 'failed' })
      )
    }
  }
)

it('reports each IPC cleanup failure and still attempts registry disposal on lifecycle shutdown', async () => {
  fixture.failAt = 'none'
  await import('./index')
  await fixture.ready
  fixture.disposeLocaleIpc.mockImplementation(() => {
    throw new Error('locale cleanup failed')
  })
  fixture.disposePreviewProtocol.mockImplementation(() => {
    throw new Error('protocol cleanup failed')
  })

  await expect(fixture.shutdownBackends!()).resolves.toBe('failed')

  expect(fixture.disposeRegistry).toHaveBeenCalledOnce()
  expect(fixture.disposeDatabaseIpc).toHaveBeenCalledOnce()
  const errors = fixture.log.error.mock.calls.filter(
    ([message, fields]) =>
      message === 'application surface shutdown failed' && fields?.surface === 'ipc-handlers'
  )
  expect(errors).toHaveLength(2)
})

it.each(['Open Science.app', 'Open-Science.app'])(
  'a losing second instance launched from %s shares the profile and never initializes writers',
  async (name) => {
    const { mkdtemp, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'profile-lock-'))
    const legacy = join(root, 'Open Science')
    await mkdir(legacy)
    const actual = await vi.importActual<typeof import('./storage/electron-profile')>(
      './storage/electron-profile'
    )
    fixture.resolveProfile.mockImplementationOnce(() =>
      actual.resolveElectronProfile({
        appData: root,
        configRoot: join(root, 'config'),
        packaged: true,
        env: {}
      })
    )
    try {
      vi.stubGlobal(
        'process',
        Object.defineProperty(Object.create(process), 'execPath', {
          value: `/virtual/Applications/${name}/Contents/MacOS/Open-Science`
        })
      )
      fixture.electron.app.requestSingleInstanceLock.mockReturnValue(false)
      await import('./index')
      expect(fixture.electron.app.setPath).toHaveBeenCalledWith('userData', legacy)
      expect(fixture.electron.app.quit).toHaveBeenCalledOnce()
      expect(fixture.prepareLocations).not.toHaveBeenCalled()
      expect(fixture.electron.app.setAppLogsPath).not.toHaveBeenCalled()
      expect(fixture.initializeDiagnostics).not.toHaveBeenCalled()
      expect(fixture.prepareCredentialValidation).not.toHaveBeenCalled()
      expect(fixture.validateCredentials).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([false, true])(
  'allows multiple isolated instances only in development (packaged=%s)',
  async (packaged) => {
    vi.stubEnv('OPEN_SCIENCE_ALLOW_MULTI_INSTANCE', '1')
    fixture.electron.app.isPackaged = packaged
    fixture.electron.app.requestSingleInstanceLock.mockReturnValue(false)
    await import('./index')
    if (packaged) {
      expect(fixture.electron.app.quit).toHaveBeenCalledOnce()
      expect(fixture.prepareLocations).not.toHaveBeenCalled()
    } else {
      await fixture.exited
      expect(fixture.electron.app.requestSingleInstanceLock).not.toHaveBeenCalled()
      expect(fixture.prepareLocations).toHaveBeenCalledOnce()
    }
  }
)

it('forwards second-instance arguments received during synchronous credential preflight', async () => {
  fixture.failAt = 'none'
  const argv = ['electron', 'open-science', '--serve', '--port=44123']
  fixture.prepareCredentialValidation.mockImplementationOnce(() => {
    const listener = fixture.electron.app.on.mock.calls.find(
      ([event]) => event === 'second-instance'
    )![1]
    listener({}, argv, '/isolated-test/cli')
    listener({}, ['electron', 'relative.science'], '/isolated-test/packages')
  })
  await import('./index')
  await fixture.ready
  await vi.waitFor(() =>
    expect(fixture.routeSecondInstance).toHaveBeenCalledWith(argv, expect.any(Object))
  )
  const { resolve } = await import('node:path')
  await vi.waitFor(() =>
    expect(fixture.openSessionPackageFile).toHaveBeenCalledWith(
      resolve('/isolated-test/packages', 'relative.science')
    )
  )
})

it.each([
  ['invalid JSON', '{invalid'],
  ['invalid dataRoot', '{"version":2,"dataRoot":"relative"}'],
  ['unsupported version', '{"version":99,"providers":[]}'],
  ['unreadable file', null]
])(
  'shows a native recovery error for %s before renderer and file logging',
  async (_name, contents) => {
    const { mkdtemp, writeFile, mkdir, rm, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const fixtureDir = await mkdtemp(join(tmpdir(), 'startup-settings-error-'))
    const path = join(fixtureDir, 'settings.json')
    if (contents === null) await mkdir(path)
    else await writeFile(path, contents)
    try {
      const { readCredentialCiphertexts } = await vi.importActual<
        typeof import('./credential-identity/ciphertext-inventory')
      >('./credential-identity/ciphertext-inventory')
      fixture.prepareCredentialValidation.mockImplementation(() => {
        readCredentialCiphertexts({
          configRoot: fixtureDir,
          profilePath: join(fixtureDir, 'profile')
        })
      })
      await import('./index')
      await fixture.exited
      expect(fixture.electron.dialog.showErrorBox).toHaveBeenCalledWith(
        'Open-Science',
        expect.stringContaining(path)
      )
      expect(fixture.electron.dialog.showErrorBox.mock.calls[0][1]).toMatch(/restore|recover/i)
      expect(fixture.configureDesktop).not.toHaveBeenCalled()
      expect(fixture.initializeDiagnostics).not.toHaveBeenCalled()
      expect(fixture.validateCredentials).not.toHaveBeenCalled()
      expect(fixture.startupFailure).not.toHaveBeenCalled()
      if (contents !== null) expect(await readFile(path, 'utf8')).toBe(contents)
    } finally {
      await rm(fixtureDir, { recursive: true, force: true })
    }
  }
)

it('selects and validates the credential identity before any settings writer', async () => {
  await import('./index')
  await fixture.exited
  expect(fixture.selectCredentialIdentity).toHaveBeenCalledOnce()
  expect(fixture.prepareCredentialValidation).toHaveBeenCalledOnce()
  expect(fixture.validateCredentials).toHaveBeenCalledOnce()
  expect(fixture.selectCredentialIdentity.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.electron.app.setPath.mock.invocationCallOrder[0]
  )
  expect(fixture.prepareCredentialValidation.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.prepareLocations.mock.invocationCallOrder[0]
  )
  expect(fixture.validateCredentials.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.prepareLocations.mock.invocationCallOrder[0]
  )
})

it('keeps second-instance arguments while credential validation waits for Electron ready', async () => {
  fixture.failAt = 'none'
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const readiness = vi.spyOn(fixture.electron.app, 'whenReady').mockReturnValue(ready)
  try {
    await import('./index')
    const listener = fixture.electron.app.on.mock.calls.find(
      ([event]) => event === 'second-instance'
    )![1]
    const argv = ['electron', 'open-science', '--serve', '--port=44123']
    listener({}, argv, '/isolated-test/cli')
    expect(fixture.prepareLocations).not.toHaveBeenCalled()
    expect(fixture.validateCredentials).not.toHaveBeenCalled()
    release()
    await fixture.ready
    await vi.waitFor(() =>
      expect(fixture.routeSecondInstance).toHaveBeenCalledWith(argv, expect.any(Object))
    )
  } finally {
    readiness.mockRestore()
    release()
  }
})

it('stops synchronously on a failed credential preflight before Electron ready or profile writers', async () => {
  const { CredentialIdentityError } = await import('./credential-identity/selection')
  fixture.prepareCredentialValidation.mockImplementationOnce(() => {
    throw new CredentialIdentityError('windows-profile-key-unavailable')
  })
  const readiness = vi.spyOn(fixture.electron.app, 'whenReady')
  try {
    await import('./index')
    await fixture.exited
    expect(readiness).not.toHaveBeenCalled()
    expect(fixture.prepareLocations).not.toHaveBeenCalled()
    expect(fixture.electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Open-Science',
      expect.stringContaining('windows-profile-key-unavailable')
    )
  } finally {
    readiness.mockRestore()
  }
})

it.each([
  'fresh',
  'existing',
  'missing key',
  'locked',
  'decrypt failure',
  'backend unavailable',
  'second instance'
])('runs the real Linux credential bootstrap at the startup boundary: %s', async (scenario) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'linux-startup-'))
  try {
    const paths = { configRoot: join(root, 'config'), profilePath: join(root, 'profile') }
    await mkdir(paths.configRoot)
    await mkdir(paths.profilePath)
    const settingsPath = join(paths.configRoot, 'settings.json')
    const settings = JSON.stringify({
      version: 2,
      providers: [{ keyRef: `enc:${Buffer.from('v11original').toString('base64')}` }]
    })
    if (scenario !== 'fresh') await writeFile(settingsPath, settings)
    vi.stubGlobal(
      'process',
      Object.defineProperty(Object.create(process), 'platform', { value: 'linux' })
    )
    vi.stubEnv('XDG_CURRENT_DESKTOP', 'GNOME')
    const metadata = await import('./credential-identity/linux-secret-service')
    vi.spyOn(metadata, 'probeLinuxCredentialIdentity').mockReturnValue({
      status:
        scenario === 'locked'
          ? 'access-blocked'
          : ['fresh', 'missing key'].includes(scenario)
            ? 'not-found'
            : 'exists'
    })
    const real = await vi.importActual<typeof import('./credential-identity/bootstrap')>(
      './credential-identity/bootstrap'
    )
    fixture.selectCredentialIdentity.mockImplementationOnce((options) =>
      real.selectStartupCredentialIdentity(
        options as Parameters<typeof real.selectStartupCredentialIdentity>[0]
      )
    )
    fixture.prepareCredentialValidation.mockImplementationOnce((identity) =>
      real.prepareCredentialValidation(
        identity as Parameters<typeof real.prepareCredentialValidation>[0],
        paths
      )
    )
    const cipher = {
      getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
      isEncryptionAvailable: vi.fn(() => scenario !== 'backend unavailable'),
      encryptString: vi.fn(),
      decryptString: vi.fn(() => {
        if (scenario === 'decrypt failure') throw Error('denied')
        return 'original'
      })
    }
    Object.assign(fixture.electron, { safeStorage: cipher })
    fixture.failAt = 'none'
    fixture.headless = false
    if (scenario === 'second instance')
      fixture.electron.app.requestSingleInstanceLock.mockReturnValue(false)
    await import('./index')
    if (scenario === 'second instance') {
      await vi.waitFor(() => expect(fixture.electron.app.quit).toHaveBeenCalled())
      expect(fixture.prepareCredentialValidation).not.toHaveBeenCalled()
      expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled()
    } else {
      await Promise.race([fixture.ready, fixture.exited])
      if (['fresh', 'existing'].includes(scenario)) {
        expect(fixture.configureDesktop).toHaveBeenCalledOnce()
        expect(fixture.electron.app.setName).toHaveBeenNthCalledWith(1, 'Open Science')
        expect(fixture.electron.app.setName).toHaveBeenLastCalledWith('Open-Science')
        expect(fixture.electron.dialog.showErrorBox).not.toHaveBeenCalled()
        if (scenario === 'existing')
          expect(cipher.decryptString).toHaveBeenCalledWith(Buffer.from('v11original'))
      } else {
        expect(fixture.electron.dialog.showErrorBox).toHaveBeenCalledWith(
          'Open-Science',
          expect.stringContaining('CREDENTIAL_IDENTITY')
        )
        expect(fixture.prepareLocations).not.toHaveBeenCalled()
        expect(fixture.configureDesktop).not.toHaveBeenCalled()
        if (['missing key', 'locked'].includes(scenario)) {
          expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled()
        }
      }
    }
    expect(cipher.encryptString).not.toHaveBeenCalled()
    if (scenario !== 'fresh') expect(await readFile(settingsPath, 'utf8')).toBe(settings)
  } finally {
    Reflect.deleteProperty(fixture.electron, 'safeStorage')
    await rm(root, { recursive: true, force: true })
  }
})

it('prints credential failure details before a native recovery dialog can be shown', async () => {
  const { CredentialIdentityError } = await import('./credential-identity/selection')
  fixture.selectCredentialIdentity.mockReset().mockImplementationOnce(() => {
    throw new CredentialIdentityError('probe-access-blocked')
  })
  await import('./index')
  await fixture.exited
  expect(fixture.log.error).toHaveBeenCalledWith(
    'application startup failed',
    expect.objectContaining({
      phase: 'credential-identity',
      name: 'CredentialIdentityError',
      recoveryReason: 'probe-access-blocked',
      error: expect.stringContaining('Credential storage needs recovery'),
      stack: expect.stringContaining('CredentialIdentityError')
    })
  )
})

it('redacts secrets in detailed startup errors and identifies their phase', async () => {
  fixture.selectCredentialIdentity.mockReset().mockReturnValue({
    backend: 'mac-keychain',
    appName: 'Open-Science',
    exists: true
  })
  fixture.prepareCredentialValidation.mockReset().mockImplementationOnce(() => {
    throw new Error('credential preflight failed: password=local-test-secret')
  })
  await import('./index')
  await fixture.exited
  const entry = fixture.log.error.mock.calls.find(
    ([message]) => message === 'application startup failed'
  )
  expect(entry?.[1]).toMatchObject({
    phase: 'credential-validation-preflight',
    name: 'Error',
    error: expect.stringContaining('credential preflight failed:')
  })
  const { formatLine } = await vi.importActual<typeof import('./logger')>('./logger')
  expect(formatLine('error', 'bootstrap', 'application startup failed', entry?.[1])).not.toContain(
    'local-test-secret'
  )
})

it.each([
  [false, 'metadata-query-failed', -25308],
  [true, 'metadata-query-failed', -25308],
  [false, 'keychain-locked', 0],
  [false, 'keychain-search-incomplete', 0],
  [false, 'keychain-state-changed', 0]
] as const)(
  'logs native probe diagnostics through startup (legacy=%s, reason=%s)',
  async (legacy, reason, osStatus) => {
    vi.stubGlobal(
      'process',
      Object.defineProperties(Object.create(process), {
        platform: { value: 'darwin' },
        mas: { value: false }
      })
    )
    const realLogger = await vi.importActual<typeof import('./logger')>('./logger')
    const mockedLogger = await import('./logger')
    vi.mocked(mockedLogger.diagnosticErrorFields).mockImplementationOnce(
      realLogger.diagnosticErrorFields
    )
    const { selectStartupCredentialIdentity, prepareCredentialValidation } = await vi.importActual<
      typeof import('./credential-identity/bootstrap')
    >('./credential-identity/bootstrap')
    const inventory = await import('./credential-identity/ciphertext-inventory')
    const readInventory = vi
      .spyOn(inventory, 'readCredentialCiphertexts')
      .mockReturnValue([Buffer.from('v10-existing')])
    fixture.prepareCredentialValidation.mockReset().mockImplementationOnce((identity) =>
      prepareCredentialValidation(identity as CredentialIdentity, {
        configRoot: '/isolated-test',
        profilePath: '/isolated-test/profile'
      })
    )
    fixture.selectCredentialIdentity
      .mockReset()
      .mockImplementationOnce(() =>
        selectStartupCredentialIdentity({ platform: 'darwin', packaged: false })
      )
    fixture.nativeProbe.mockReset().mockImplementation((_executable, args) => {
      const identity = (args as string[])[0]
      const absent = legacy && identity === 'Open-Science (DEV)'
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          schemaVersion: 1,
          platform: 'darwin',
          identity,
          status: absent ? 'not-found' : 'access-blocked',
          reason: absent ? 'account-not-found' : reason,
          osStatus,
          secret: 'private-native-secret'
        })
      }
    })
    await import('./index')
    await fixture.exited
    const entry = fixture.log.error.mock.calls.find(
      ([message]) => message === 'application startup failed'
    )
    expect(entry?.[1]).toMatchObject({
      phase: 'credential-validation-preflight',
      recoveryReason: 'key-missing-for-existing-ciphertext'
    })
    const { formatLine } = await vi.importActual<typeof import('./logger')>('./logger')
    expect(fixture.nativeProbe).toHaveBeenCalledTimes(2)
    const summary = fixture.log.info.mock.calls.find(
      ([message]) => message === 'identity selection completed'
    )
    expect(summary?.[1]).toMatchObject({
      outcome: 'selected',
      appName: 'Open-Science (DEV)',
      exists: false,
      reason: 'no-identity-confirmed',
      probes: [
        { appName: 'Open-Science (DEV)', status: legacy ? 'not-found' : 'access-blocked' },
        { appName: 'Open Science (DEV)', status: 'access-blocked' }
      ]
    })
    const line = formatLine(
      'info',
      'credential-identity',
      'identity selection completed',
      summary?.[1]
    )
    expect(JSON.parse(line).data.probes[1]).toMatchObject({ reason, osStatus })
    expect(line).not.toContain('private-native-secret')
    expect(fixture.prepareCredentialValidation).toHaveBeenCalledOnce()
    readInventory.mockRestore()
  }
)

it.each(['access-blocked', 'error', 'unsupported'] as const)(
  'blocks unconfirmed empty-profile initialization after selection: %s',
  async (status) => {
    const legacy = false
    const reason = 'keychain-locked'
    const osStatus = 0
    vi.stubGlobal(
      'process',
      Object.defineProperties(Object.create(process), {
        platform: { value: 'darwin' },
        mas: { value: false }
      })
    )
    const realLogger = await vi.importActual<typeof import('./logger')>('./logger')
    const mockedLogger = await import('./logger')
    vi.mocked(mockedLogger.diagnosticErrorFields).mockImplementationOnce(
      realLogger.diagnosticErrorFields
    )
    const { selectStartupCredentialIdentity, prepareCredentialValidation } = await vi.importActual<
      typeof import('./credential-identity/bootstrap')
    >('./credential-identity/bootstrap')
    const inventory = await import('./credential-identity/ciphertext-inventory')
    const readInventory = vi.spyOn(inventory, 'readCredentialCiphertexts').mockReturnValue([])
    fixture.prepareCredentialValidation.mockReset().mockImplementationOnce((identity) =>
      prepareCredentialValidation(identity as CredentialIdentity, {
        configRoot: '/isolated-test',
        profilePath: '/isolated-test/profile'
      })
    )
    fixture.selectCredentialIdentity
      .mockReset()
      .mockImplementationOnce(() =>
        selectStartupCredentialIdentity({ platform: 'darwin', packaged: false })
      )
    fixture.nativeProbe.mockReset().mockImplementation((_executable, args) => {
      const identity = (args as string[])[0]
      const absent = legacy && identity === 'Open-Science (DEV)'
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          schemaVersion: 1,
          platform: 'darwin',
          identity,
          status: absent ? 'not-found' : status,
          reason: absent ? 'account-not-found' : reason,
          osStatus,
          secret: 'private-native-secret'
        })
      }
    })
    await import('./index')
    await fixture.exited
    const entry = fixture.log.error.mock.calls.find(
      ([message]) => message === 'application startup failed'
    )
    expect(entry?.[1]).toMatchObject({
      phase: 'credential-validation-preflight',
      recoveryReason: `initialization-probe-${status}`
    })
    const { formatLine } = await vi.importActual<typeof import('./logger')>('./logger')
    expect(fixture.nativeProbe).toHaveBeenCalledTimes(3)
    const summary = fixture.log.info.mock.calls.find(
      ([message]) => message === 'identity selection completed'
    )
    expect(summary?.[1]).toMatchObject({
      outcome: 'selected',
      appName: 'Open-Science (DEV)',
      exists: false,
      reason: 'no-identity-confirmed',
      probes: [
        { appName: 'Open-Science (DEV)', status },
        { appName: 'Open Science (DEV)', status }
      ]
    })
    const line = formatLine(
      'info',
      'credential-identity',
      'identity selection completed',
      summary?.[1]
    )
    expect(JSON.parse(line).data.probes[1]).toMatchObject({ reason, osStatus })
    expect(line).not.toContain('private-native-secret')
    expect(fixture.prepareLocations).not.toHaveBeenCalled()
    expect(fixture.configureDesktop).not.toHaveBeenCalled()
    expect(fixture.prepareCredentialValidation).toHaveBeenCalledOnce()
    readInventory.mockRestore()
  }
)

it('logs later credential recovery with concrete diagnostics after normal startup', async () => {
  fixture.failAt = 'none'
  await import('./index')
  await fixture.ready
  const { CredentialIdentityError } = await import('./credential-identity/selection')
  const recover = fixture.validateCredentials.mock.calls[0][1] as (error: Error) => void
  recover(
    new CredentialIdentityError('access-access-blocked', {
      appName: 'Open-Science',
      status: 'access-blocked',
      reason: 'keychain-locked',
      osStatus: 0
    })
  )
  await fixture.exited
  const entry = fixture.log.error.mock.calls.find(
    ([message]) => message === 'credential access failed'
  )
  const { formatLine } = await vi.importActual<typeof import('./logger')>('./logger')
  const line = formatLine('error', 'bootstrap', 'credential access failed', entry?.[1])
  expect(JSON.parse(line).data).toMatchObject({
    recoveryReason: 'access-access-blocked',
    identityProbe: {
      appName: 'Open-Science',
      status: 'access-blocked',
      reason: 'keychain-locked',
      osStatus: 0
    }
  })
  expect(fixture.electron.app.exit).toHaveBeenCalledWith(1)
})
