import { spawn } from 'node:child_process'

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
    setName: vi.fn(),
    getPath: vi.fn(() => 'test-logs'),
    getVersion: vi.fn(() => '0.0.0-test'),
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

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  createRequire: () => () => ({
    app: mocks.app,
    BrowserWindow: {},
    crashReporter: {},
    ipcMain: {},
    nativeImage: {},
    nativeTheme: {},
    protocol: { registerSchemesAsPrivileged: vi.fn() }
  })
}))

vi.mock('./single-instance', () => ({
  acquireSingleInstanceLock: vi.fn(() => true)
}))

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

vi.mock('./diagnostics/startup-storage-probe', () => ({
  timedStartupStorageProbe: vi.fn(async () => ({
    sequentialMs: 0,
    syncWriteMs: 0,
    kind: 'unknown'
  }))
}))

vi.mock('./logger', () => ({
  createLogger: vi.fn(() => mocks.log),
  diagnosticErrorFields: vi.fn((error: unknown) => ({ error })),
  flushLogs: vi.fn(async () => undefined),
  writeFatalLogSync: mocks.writeFatalLogSync
}))

vi.mock('./renderer-diagnostics', () => ({
  createRendererFailureReporter: vi.fn(() => vi.fn()),
  registerRendererDiagnosticsIpc: mocks.registerRendererDiagnosticsIpc
}))

type ProcessFailureListener = (reason: unknown, origin?: string) => void

type ChildResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderr: string
  stdout: string
}

const runFatalChild = (
  eventName: 'uncaughtException' | 'unhandledRejection'
): Promise<ChildResult> =>
  new Promise((resolve, reject) => {
    const script = `
      process.on('uncaughtExceptionMonitor', (error, origin) => {
        process.stderr.write('MONITORED:' + origin + ':' + error.message + '\\n')
      })
      setTimeout(() => process.stdout.write('POST_FATAL_SENTINEL\\n'), 100)
      if (${JSON.stringify(eventName)} === 'uncaughtException') {
        setImmediate(() => { throw new Error('fatal uncaughtException') })
      } else {
        void Promise.reject(new Error('fatal unhandledRejection'))
      }
    `
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    let stdout = ''
    child.stderr.setEncoding('utf8')
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stderr, stdout }))
  })

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
  it('observes both fatal origins without installing a consuming listener', async () => {
    const listeners = await bootUntilFailureHandlersAreInstalled()
    const monitor = listeners.get('uncaughtExceptionMonitor')

    expect(monitor).toBeTypeOf('function')
    expect(listeners.has('uncaughtException')).toBe(false)
    expect(listeners.has('unhandledRejection')).toBe(false)

    for (const eventName of ['uncaughtException', 'unhandledRejection'] as const) {
      const error = new Error(`fatal ${eventName}`)
      monitor?.(error, eventName)
      expect(mocks.writeFatalLogSync).toHaveBeenCalledWith(
        'main',
        eventName,
        expect.objectContaining({ error })
      )
    }

    expect(mocks.log.error).not.toHaveBeenCalled()
    expect(mocks.app.quit).not.toHaveBeenCalled()
    expect(mocks.app.exit).not.toHaveBeenCalled()
  })

  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    'preserves Node fail-fast termination for %s',
    async (eventName) => {
      const result = await runFatalChild(eventName)

      expect(result.signal).toBeNull()
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(`MONITORED:${eventName}:fatal ${eventName}`)
      expect(result.stdout).not.toContain('POST_FATAL_SENTINEL')
    }
  )
})
