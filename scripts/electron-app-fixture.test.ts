import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { dirname, join, resolve, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import type { ElectronApplication } from 'playwright'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

import {
  closeElectronApplicationForCleanup,
  disconnectFixtureServiceConnection,
  hasFixtureReconnected,
  launchEnvironment,
  installRestartPersistenceRetry,
  observeElectronFlushDiagnostics
} from '../e2e/fixtures/electron-app'

describe('fixture service connection evidence', () => {
  it('disconnects only the unique ws-owned Desktop service pipe', () => {
    const unrelated = {
      readable: true,
      writable: true,
      _handle: { constructor: { name: 'Pipe' } },
      destroy: vi.fn()
    }
    const socket = { ...unrelated, destroyed: false, destroy: vi.fn() }
    socket.destroy.mockImplementation(() => {
      socket.destroyed = true
    })
    Object.assign(socket, {
      [Symbol('websocket')]: { _socket: socket, url: 'ws://localhost/desktop', readyState: 1 }
    })
    const target = process as NodeJS.Process & { _getActiveHandles(): unknown[] }
    const handles = vi.spyOn(target, '_getActiveHandles').mockReturnValue([unrelated, socket])
    let result: ReturnType<typeof disconnectFixtureServiceConnection>
    try {
      result = disconnectFixtureServiceConnection()
    } finally {
      handles.mockRestore()
    }
    expect(result!).toEqual({ url: 'ws://localhost/desktop', destroyed: true })
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(unrelated.destroy).not.toHaveBeenCalled()
  })

  it('rejects an unrelated pipe instead of pretending the service was disconnected', () => {
    const destroy = vi.fn()
    const target = process as NodeJS.Process & { _getActiveHandles(): unknown[] }
    const handles = vi
      .spyOn(target, '_getActiveHandles')
      .mockReturnValue([
        { readable: true, writable: true, _handle: { constructor: { name: 'Pipe' } }, destroy }
      ])
    try {
      expect(() => disconnectFixtureServiceConnection()).toThrow('found 0')
    } finally {
      handles.mockRestore()
    }
    expect(destroy).not.toHaveBeenCalled()
  })

  it('requires a newer connected epoch of the same service rather than old connected or a no-op', () => {
    const before = { phase: 'connected', epoch: 4 }
    expect(hasFixtureReconnected(before, before, 'generation-A', 'generation-A')).toBe(false)
    expect(
      hasFixtureReconnected(
        before,
        { phase: 'reconnecting', epoch: 5 },
        'generation-A',
        'generation-A'
      )
    ).toBe(false)
    expect(
      hasFixtureReconnected(
        before,
        { phase: 'connected', epoch: 5 },
        'generation-A',
        'generation-B'
      )
    ).toBe(false)
    expect(
      hasFixtureReconnected(
        before,
        { phase: 'connected', epoch: 5 },
        'generation-A',
        'generation-A'
      )
    ).toBe(true)
  })
})

it('keeps the Linux test desktop session while isolating home and provider credentials', () => {
  const environment = launchEnvironment(resolve('fixture/storage'), undefined, {
    OPEN_SCIENCE_E2E_ISOLATE_HOME: '1',
    HOME: '/operator',
    OPENAI_API_KEY: 'operator-secret',
    DISPLAY: ':99',
    XAUTHORITY: '/tmp/test-display/Xauthority',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/test-bus',
    XDG_RUNTIME_DIR: '/tmp/test-runtime',
    XDG_CURRENT_DESKTOP: 'GNOME'
  })
  expect(environment).toMatchObject({
    DISPLAY: ':99',
    XAUTHORITY: '/tmp/test-display/Xauthority',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/test-bus',
    XDG_RUNTIME_DIR: '/tmp/test-runtime',
    XDG_CURRENT_DESKTOP: 'GNOME',
    HOME: resolve('fixture/isolated home'),
    OPEN_SCIENCE_CONFIG_ROOT: resolve('fixture/storage')
  })
  expect(environment.OPENAI_API_KEY).toBeUndefined()
})

it('isolates credentials, preload options, home and installation state by default', () => {
  const storageRoot = resolve('fixture/storage')
  const environment = launchEnvironment(storageRoot, undefined, {
    PATH: '/os/bin',
    HOME: '/operator',
    USERPROFILE: '/operator',
    OPENAI_API_KEY: 'operator-secret',
    NODE_OPTIONS: '--require=/operator/preload.cjs',
    OPEN_SCIENCE_CONFIG_ROOT: '/operator/config',
    OPEN_SCIENCE_INSTALLATION_STATE_ROOT: '/operator/installations',
    OPEN_SCIENCE_E2E_BUILD_ID: 'fixture-build'
  })
  expect(environment).toMatchObject({
    PATH: '/os/bin',
    HOME: resolve('fixture/isolated home'),
    USERPROFILE: resolve('fixture/isolated home'),
    OPEN_SCIENCE_CONFIG_ROOT: storageRoot,
    OPEN_SCIENCE_INSTALLATION_STATE_ROOT: resolve('fixture/storage/installation-state'),
    OPEN_SCIENCE_E2E_BUILD_ID: 'fixture-build'
  })
  expect(environment.OPENAI_API_KEY).toBeUndefined()
  expect(environment.NODE_OPTIONS).toBeUndefined()
})

it('keeps Windows system tools while excluding host PowerShell modules and credentials', () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const environment = launchEnvironment(resolve('fixture/storage'), undefined, {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files',
      PSModulePath: 'C:\\operator\\custom-modules',
      OPENAI_API_KEY: 'operator-secret',
      USERPROFILE: 'C:\\operator'
    })
    expect(environment).toMatchObject({
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files',
      PSModulePath:
        'C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
      USERPROFILE: resolve('fixture/isolated home')
    })
    expect(environment.OPENAI_API_KEY).toBeUndefined()
  } finally {
    Object.defineProperty(process, 'platform', { value: platform })
  }
})

it.skipIf(process.platform !== 'win32')(
  'runs real PowerShell identity and compiler queries inside the isolated launch environment',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fixture-powershell-'))
    try {
      const environment = launchEnvironment(join(root, 'storage'))
      for (const path of [environment.USERPROFILE, environment.APPDATA, environment.LOCALAPPDATA])
        await mkdir(path, { recursive: true })
      // This smoke verifies system-tool availability in a fresh isolated profile, not a startup
      // latency SLA. Production identity reads still stop after 2s and may report unknown.
      const query = (script: string, timeout: number): string =>
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          env: environment,
          encoding: 'utf8',
          timeout,
          windowsHide: true
        }).trim()
      expect(
        query(
          `$p = Get-Process -Id ${process.pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToFileTimeUtc()`,
          15_000
        )
      ).toMatch(/^\d+$/)
      expect(
        query(
          "Add-Type -TypeDefinition 'public class FixtureProbe { public static int Value() { return 17; } }'; [FixtureProbe]::Value()",
          30_000
        )
      ).toBe('17')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)

it.each([undefined, 'enabled'])(
  'initializes Electron OS paths for default isolated launches (micromamba events: %s)',
  async (micromambaEvents) => {
    const source = await readFile('e2e/fixtures/node-runtime-preload.cjs', 'utf8')
    const environment = launchEnvironment(resolve('fixture/storage'), undefined, {
      OPEN_SCIENCE_E2E_MICROMAMBA_EVENTS: micromambaEvents
    })
    const created = new Set<string>()
    const setPath = vi.fn((_key: string, value: string) => {
      // Electron requires the target directory to exist before accepting the override.
      expect(created.has(value)).toBe(true)
    })
    runInNewContext(source, {
      require: (name: string) => {
        if (name === 'electron') return { app: { isPackaged: false, setPath } }
        if (name === 'node:path') return { dirname, join, resolve, sep }
        if (name === 'node:fs')
          return { readFileSync: vi.fn(), mkdirSync: (path: string) => created.add(path) }
        if (name === 'node:module') return { _load: vi.fn() }
        throw new Error(`Unexpected module: ${name}`)
      },
      process: { platform: 'win32', versions: { electron: 'test' }, env: environment },
      __dirname: resolve('e2e/fixtures')
    })
    expect(setPath.mock.calls).toEqual([
      ['home', environment.USERPROFILE],
      ['appData', environment.APPDATA],
      ['cache', environment.LOCALAPPDATA],
      ['downloads', join(environment.USERPROFILE, 'Downloads')]
    ])
  }
)

it.each([true, false])(
  'requires an explicit Linux test vault before restoring it: %s',
  async (explicit) => {
    const source = await readFile('e2e/fixtures/node-runtime-preload.cjs', 'utf8')
    const appendSwitch = vi.fn()
    const load = (name: string): unknown => {
      if (name === 'electron') return { app: { isPackaged: false, commandLine: { appendSwitch } } }
      if (name === 'node:path') return { join: resolve }
      if (name === 'node:fs') return { readFileSync: vi.fn() }
      if (name === 'node:module') return { _load: vi.fn() }
      throw new Error(`Unexpected module: ${name}`)
    }
    const run = (): void =>
      runInNewContext(source, {
        require: load,
        process: {
          platform: 'linux',
          versions: { electron: 'test' },
          argv: explicit ? ['--password-store=gnome-libsecret'] : [],
          env: { OPEN_SCIENCE_E2E_STORAGE_ROOT: resolve('fixture/storage') }
        },
        __dirname: resolve('e2e/fixtures')
      })
    if (explicit) {
      run()
      expect(appendSwitch).toHaveBeenCalledExactlyOnceWith('password-store', 'gnome-libsecret')
    } else {
      expect(run).toThrow('requires an explicit Secret Service backend')
      expect(appendSwitch).not.toHaveBeenCalled()
    }
  }
)

describe('source macOS mock Keychain metadata', () => {
  it('replaces only the native probe path for an explicit source mock launch', async () => {
    const source = await readFile('e2e/fixtures/mock-credential-identity.cjs', 'utf8')
    const probe = { executablePath: 'native-probe', validatorExecutablePath: 'native-validator' }
    const load = vi.fn((name: string) => {
      if (name === 'electron')
        return { app: { isPackaged: false, commandLine: { hasSwitch: () => true } } }
      if (name === 'node:path') return { join: resolve }
      if (name === '@aipoch/credential-identity-probe-native') return probe
      throw new Error(`Unexpected module: ${name}`)
    })
    runInNewContext(source, {
      require: load,
      process: { platform: 'darwin', env: {} },
      __dirname: resolve('e2e/fixtures')
    })
    expect(probe.executablePath).toBe(resolve('e2e/fixtures/mock-credential-identity.sh'))
    expect(probe.validatorExecutablePath).toBe('native-validator')
  })

  it.each([
    ['darwin', true, true],
    ['darwin', false, false],
    ['linux', false, true],
    ['win32', false, true]
  ])(
    'rejects platform=%s packaged=%s mock=%s before replacing the probe',
    async (platform, isPackaged, mock) => {
      const source = await readFile('e2e/fixtures/mock-credential-identity.cjs', 'utf8')
      const load = vi.fn((name: string) => {
        if (name === 'electron')
          return { app: { isPackaged, commandLine: { hasSwitch: () => mock } } }
        if (name === 'node:path') return { join: resolve }
        throw new Error(`Unexpected module: ${name}`)
      })
      expect(() => runInNewContext(source, { require: load, process: { platform } })).toThrow(
        'requires a source macOS mock-Keychain launch'
      )
      expect(load).not.toHaveBeenCalledWith('@aipoch/credential-identity-probe-native')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'returns the native metadata protocol for the fixed mock key and rejects unknown identities',
    () => {
      const executable = resolve('e2e/fixtures/mock-credential-identity.sh')
      for (const identity of [
        'Open-Science',
        'Open-Science (DEV)',
        'Open Science',
        'Open Science (DEV)'
      ]) {
        expect(JSON.parse(execFileSync(executable, [identity], { encoding: 'utf8' }))).toEqual({
          schemaVersion: 1,
          platform: 'darwin',
          identity,
          status: 'exists'
        })
      }
      expect(() => execFileSync(executable, ['unknown'])).toThrow()
    }
  )
})

const deferred = (): {
  promise: Promise<void>
  resolve: () => void
} => {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('Electron E2E cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a graceful close on the normal path', async () => {
    const forceClose = vi.fn(async () => undefined)

    await closeElectronApplicationForCleanup(
      { close: () => Promise.resolve(), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    )

    expect(forceClose).not.toHaveBeenCalled()
  })

  it('force-closes a fixture-owned process after the graceful budget', async () => {
    vi.useFakeTimers()
    const closing = deferred()
    const forceClose = vi.fn(async () => closing.resolve())
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => closing.promise, forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    )

    await vi.advanceTimersByTimeAsync(100)
    await cleanup

    expect(forceClose).toHaveBeenCalledOnce()
  })

  it('reaps a blocked restart without treating forced termination as a successful save', async () => {
    vi.useFakeTimers()
    const forceClose = vi.fn(async () => undefined)
    const closing = closeElectronApplicationForCleanup(
      { close: () => new Promise<void>(() => undefined), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100, requireGraceful: true }
    )
    await Promise.all([
      expect(closing).rejects.toThrow('graceful close did not finish within 100ms'),
      vi.advanceTimersByTimeAsync(100)
    ])
    expect(forceClose).toHaveBeenCalledOnce()
  })

  it('awaits forced reaping before propagating a graceful close error', async () => {
    const reaping = deferred()
    const forceClose = vi.fn(() => reaping.promise)
    let cleanupError: unknown
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => Promise.reject(new Error('close failed')), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    ).catch((error: unknown) => {
      cleanupError = error
    })

    await vi.waitFor(() => expect(forceClose).toHaveBeenCalledOnce())
    expect(cleanupError).toBeUndefined()

    reaping.resolve()
    await cleanup
    expect(cleanupError).toEqual(new Error('close failed'))
  })

  it('fails within a second bound when forced cleanup cannot reap the process', async () => {
    vi.useFakeTimers()
    const forceClose = vi.fn(() => new Promise<void>(() => undefined))
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => new Promise<void>(() => undefined), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 50 }
    )
    const rejection = expect(cleanup).rejects.toThrow('forced close did not finish within 50ms')

    await vi.advanceTimersByTimeAsync(150)
    await rejection
    expect(forceClose).toHaveBeenCalledOnce()
  })
})

describe('Electron E2E restart persistence recovery', () => {
  afterEach(() => vi.useRealTimers())

  const setup = vi.fn(async () => {
    const app = new EventEmitter()
    const ipcMain = new EventEmitter()
    const send = vi.fn()
    const contents = { send }
    const electron = { app, ipcMain, BrowserWindow: { fromId: () => ({ webContents: contents }) } }
    const application = {
      evaluate: async (script: (electron: unknown, arg: unknown) => unknown, arg: unknown) =>
        script(electron, arg)
    } as unknown as Pick<ElectronApplication, 'evaluate'>
    await installRestartPersistenceRetry(application, 1, 100)
    const answers = vi.fn()
    ipcMain.on('window:close-confirm-response', answers)
    const prompt = (): void =>
      contents.send('window:close-confirm-request', {
        requestId: 'confirmation',
        variant: 'persistence-failed'
      })
    const respond = (requestId: string, status: string, sender: unknown = contents): boolean =>
      ipcMain.emit('sessions:flush-response', { sender }, { requestId, status })
    return { app, ipcMain, contents, send, answers, prompt, respond }
  })

  it('retries once only after the matching window and request finish saving', async () => {
    const h = await setup()
    h.contents.send('sessions:flush-request', { requestId: 'closing' })
    expect(h.send).toHaveBeenCalledWith('sessions:flush-request', { requestId: 'closing' })
    h.prompt()
    expect(h.answers).toHaveBeenCalledWith(
      { sender: h.contents },
      {
        requestId: 'confirmation',
        ack: true
      }
    )
    h.respond('old', 'completed')
    h.respond('closing', 'completed', {})
    h.contents.send('sessions:flush-request', { requestId: 'unrelated' })
    h.respond('unrelated', 'completed')
    await Promise.resolve()
    expect(h.answers).toHaveBeenCalledOnce()
    h.respond('closing', 'completed')
    await Promise.resolve()
    expect(h.answers).toHaveBeenLastCalledWith(
      { sender: h.contents },
      {
        requestId: 'confirmation',
        choice: 'retry'
      }
    )
    expect(h.contents.send).toBe(h.send)
    expect(h.ipcMain.listenerCount('sessions:flush-response')).toBe(0)
    expect(h.app.listenerCount('will-quit')).toBe(0)
    h.prompt()
    expect(h.send).toHaveBeenLastCalledWith('window:close-confirm-request', {
      requestId: 'confirmation',
      variant: 'persistence-failed'
    })
    expect(h.answers).toHaveBeenCalledTimes(2)
  })

  it('accepts a late completion delivered just before the confirmation opens', async () => {
    const h = await setup()
    h.contents.send('sessions:flush-request', { requestId: 'closing' })
    h.respond('closing', 'completed')
    h.prompt()
    expect(h.answers.mock.calls.at(-1)?.[1]).toMatchObject({ choice: 'retry' })
  })

  it.each(['conflict', 'failed'])('does not retry a %s acknowledgement', async (status) => {
    const h = await setup()
    h.contents.send('sessions:flush-request', { requestId: 'closing' })
    h.prompt()
    h.respond('closing', status)
    await Promise.resolve()
    expect(h.answers.mock.calls.at(-1)?.[1]).toMatchObject({ choice: 'cancel' })
    expect(h.contents.send).toBe(h.send)
  })

  it('bounds missing acknowledgements and does not reuse an earlier successful flush', async () => {
    vi.useFakeTimers()
    const h = await setup()
    h.contents.send('sessions:flush-request', { requestId: 'previous' })
    h.respond('previous', 'completed')
    h.contents.send('sessions:flush-request', { requestId: 'closing' })
    h.prompt()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.answers.mock.calls.at(-1)?.[1]).toMatchObject({ choice: 'cancel' })
    expect(h.ipcMain.listenerCount('sessions:flush-response')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves other confirmations and ordinary shutdown untouched', async () => {
    const h = await setup()
    h.prompt()
    h.contents.send('sessions:flush-request', { requestId: 'closing' })
    h.contents.send('window:close-confirm-request', { requestId: 'active', variant: 'quit' })
    expect(h.send).toHaveBeenCalledTimes(3)
    expect(h.answers).not.toHaveBeenCalled()
    h.app.emit('will-quit')
    expect(h.contents.send).toBe(h.send)
    expect(h.ipcMain.listenerCount('sessions:flush-response')).toBe(0)
  })
})

describe('Electron E2E flush diagnostics', () => {
  it('collects split stdout lines after inspector loss and detaches without closing the pipe', async () => {
    const stdout = new PassThrough()
    const existingConsumer = vi.fn()
    stdout.on('data', existingConsumer)
    const evaluate = vi.fn().mockResolvedValue(undefined)
    const record = vi.fn()
    const stop = await observeElectronFlushDiagnostics(
      { process: () => ({ stdout }) as ReturnType<ElectronApplication['process']>, evaluate },
      { evaluate: vi.fn().mockResolvedValue(undefined) },
      record
    )
    try {
      evaluate.mockRejectedValue(new Error('inspector disconnected'))
      stdout.write('ordinary application log\nE2E_FLUSH {"requestId":"one",')
      stdout.write(
        '"status":"renderer-received"}\nE2E_FLUSH {"requestId":"one","status":"completed"}\n'
      )
      expect(record.mock.calls.map(([line]) => line)).toEqual([
        '{"requestId":"one","status":"renderer-received"}',
        '{"requestId":"one","status":"completed"}'
      ])
      stop()
      stdout.write('E2E_FLUSH late\n')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(existingConsumer).toHaveBeenLastCalledWith(Buffer.from('E2E_FLUSH late\n'))
      expect(record).toHaveBeenCalledTimes(2)
      expect(stdout.destroyed).toBe(false)
    } finally {
      stop()
      stdout.destroy()
    }
  })

  it('retains the original close error when observation cannot be installed', async () => {
    const stdout = new PassThrough()
    const record = vi.fn()
    const stop = await observeElectronFlushDiagnostics(
      {
        process: () => ({ stdout }) as ReturnType<ElectronApplication['process']>,
        evaluate: vi.fn().mockRejectedValue(new Error('inspector unavailable'))
      },
      { evaluate: vi.fn() },
      record
    )
    const failure = new Error('original close error')
    try {
      expect(record).toHaveBeenCalledWith(expect.stringContaining('observer-installation-failed'))
      expect(() => stdout.emit('error', new Error('pipe unavailable'))).not.toThrow()
      expect(record).toHaveBeenCalledWith(expect.stringContaining('stdout-error'))
      await expect(
        closeElectronApplicationForCleanup(
          {
            close: async () => {
              throw failure
            },
            forceClose: async () => undefined
          },
          { gracefulTimeoutMs: 100, forcedTimeoutMs: 100, requireGraceful: true }
        )
      ).rejects.toBe(failure)
    } finally {
      stop()
      stdout.destroy()
    }
  })
})
