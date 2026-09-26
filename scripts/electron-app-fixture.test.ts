import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import type { ElectronApplication } from 'playwright'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  closeElectronApplicationForCleanup,
  installRestartPersistenceRetry,
  observeElectronFlushDiagnostics
} from '../e2e/fixtures/electron-app'

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
      process: { platform: 'darwin' },
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
