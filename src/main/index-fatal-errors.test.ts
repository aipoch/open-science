vi.mock('./runtime-ownership', async (original) => ({
  ...(await original<typeof import('./runtime-ownership')>()),
  acquireCredentialBootstrapLease: () => ({ release: vi.fn() }),
  RuntimeDirectoryOwnership: class {
    acquireSync = vi.fn()
  },
  configureRuntimeDirectoryOwnership: vi.fn()
}))
vi.mock('./runtime-control', () => ({ startRuntimeControl: async () => ({ close: vi.fn() }) }))
vi.mock('./desktop-interaction-electron', () => ({ installElectronInteraction: vi.fn() }))
vi.mock('./runtime-network-electron', () => ({ installElectronNetwork: vi.fn() }))
vi.mock('./credential-identity/bootstrap', () => ({
  selectStartupCredentialIdentity: () => ({
    backend: 'mac-keychain',
    appName: 'Open-Science (DEV)',
    exists: true
  }),
  prepareCredentialValidation: () => () => {}
}))
vi.mock('./storage/electron-profile', () => ({
  resolveBootstrapConfigRoot: () => '/isolated-test',
  resolveElectronProfile: () => '/isolated-test/profile'
}))
vi.mock('./storage/initialize-location', () => ({
  prepareApplicationLocations: async () => ({
    settingsStore: {},
    repository: { getSettings: async () => ({}) }
  }),
  initializeDataLocation: vi.fn()
}))

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const log = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
  const app = {
    isPackaged: false,
    isReady: () => true,
    commandLine: { getSwitchValue: () => '' },
    whenReady: async () => {},
    setName: vi.fn(),
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    getPath: vi.fn(() => 'test-logs'),
    getVersion: vi.fn(() => '0.0.0-test'),
    getAppPath: () => '/isolated-test/application',
    getLocale: () => 'en',
    once: vi.fn(),
    on: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn()
  }

  return {
    app,
    log,
    writeFatalLogSync: vi.fn(),
    registerRendererDiagnosticsIpc: vi.fn(() => {
      throw new Error('stop after process failure handlers are installed')
    }),
    reportApplicationStartupFailure: vi.fn(async () => undefined)
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  dialog: { showErrorBox: vi.fn() },
  BrowserWindow: {},
  crashReporter: {},
  ipcMain: {},
  nativeImage: {},
  nativeTheme: {},
  protocol: { registerSchemesAsPrivileged: vi.fn() }
}))
vi.mock('./desktop-native-electron', () => ({ createDesktopNativeHandler: vi.fn() }))
vi.mock('./desktop-runtime-launcher', () => ({
  startOrAttachDesktopBackend: vi.fn(),
  desktopBackendPaths: vi.fn(() => ({
    command: '/isolated-test/node',
    entry: '/isolated-test/application/backend.cjs'
  }))
}))
vi.mock('./credential-identity/node-cipher', () => ({ initializeNodeWindowsProfileKey: vi.fn() }))

vi.mock('./app-startup', () => ({
  createSecondInstanceRelay: vi.fn(() => ({
    bind: vi.fn(),
    signal: vi.fn()
  })),
  createStartupWindowCloseOptions: vi.fn(),
  createStartupWindowSecondInstanceHandler: vi.fn(),
  orchestrateAppStartup: vi.fn(),
  prepareVisibleStartupRuntime: vi.fn(),
  waitForStartupShell: vi.fn()
}))

vi.mock('./crash-diagnostics', () => ({
  installChildProcessGoneLogging: vi.fn(),
  startLocalCrashReporting: vi.fn()
}))

vi.mock('./diagnostics/startup', () => ({
  initializeApplicationDiagnostics: vi.fn(() => ({
    log: mocks.log,
    operation: { phase: vi.fn() },
    flush: vi.fn(async () => undefined)
  })),
  reportApplicationStartupFailure: mocks.reportApplicationStartupFailure
}))

vi.mock('@aipoch/diagnostics/node', async (importOriginal) => ({
  timedStartupStorageProbe: vi.fn(async () => ({
    sequentialMs: 0,
    syncWriteMs: 0,
    kind: 'unknown'
  })),
  errorLogFields: (await importOriginal<typeof import('@aipoch/diagnostics/node')>())
    .errorLogFields,
  createLogger: vi.fn(() => mocks.log),
  initLogger: vi.fn(),
  diagnosticErrorFields: vi.fn((error: unknown) => ({ error })),
  flushLogs: vi.fn(async () => undefined),
  writeFatalLogSync: mocks.writeFatalLogSync
}))

vi.mock('./renderer-diagnostics', () => ({
  createRendererFailureReporter: vi.fn(() => vi.fn()),
  registerRendererDiagnosticsIpc: mocks.registerRendererDiagnosticsIpc
}))

type ProcessFailureListener = (reason: unknown, origin?: string) => void

const bootUntilFailureHandlersAreInstalled = async (): Promise<
  Map<NodeJS.Signals | string, ProcessFailureListener>
> => {
  vi.resetModules()
  mocks.app.quit.mockClear()
  mocks.app.exit.mockClear()
  mocks.log.error.mockClear()
  mocks.writeFatalLogSync.mockClear()
  mocks.registerRendererDiagnosticsIpc.mockClear()
  mocks.reportApplicationStartupFailure.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)

  const listeners = new Map<NodeJS.Signals | string, ProcessFailureListener>()
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: ProcessFailureListener) => {
    listeners.set(event, listener)
    return process
  }) as typeof process.on)

  await import('./index')
  await vi.waitFor(() => expect(mocks.registerRendererDiagnosticsIpc).toHaveBeenCalledOnce())
  mocks.log.error.mockClear()

  return listeners
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('main-process fatal errors', () => {
  it('exits Electron after reporting a UI startup failure', async () => {
    const originalExitCode = process.exitCode
    let finishReporting!: () => void
    mocks.reportApplicationStartupFailure.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishReporting = () => resolve(undefined)
        })
    )

    try {
      await bootUntilFailureHandlersAreInstalled()

      await vi.waitFor(() => expect(mocks.reportApplicationStartupFailure).toHaveBeenCalledOnce())
      expect(mocks.app.exit).not.toHaveBeenCalled()

      finishReporting()
      await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1))
    } finally {
      process.exitCode = originalExitCode
    }
  })

  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    'writes only the first fatal record and exits Electron for %s',
    async (origin) => {
      const listeners = await bootUntilFailureHandlersAreInstalled()
      await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1))
      mocks.app.exit.mockClear()
      mocks.writeFatalLogSync.mockClear()

      const fail = listeners.get('uncaughtException')!
      const first = new Error('first failure')
      mocks.writeFatalLogSync.mockImplementationOnce(() => fail(new Error('reentrant'), origin))
      fail(first, origin)
      fail(new Error('later failure'), origin)

      expect(mocks.writeFatalLogSync).toHaveBeenCalledExactlyOnceWith('main', origin, {
        error: first
      })
      expect(mocks.app.exit).toHaveBeenCalledExactlyOnceWith(1)
    }
  )
})

vi.mock('./ipc-handler-registry', () => ({
  configureIpcHandlerRegistry: vi.fn(),
  disposeIpcHandlerRegistry: vi.fn()
}))
