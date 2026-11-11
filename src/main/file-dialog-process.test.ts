import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BaseWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showFileDialogInHelper } from './file-dialog-process'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  rm: vi.fn(async () => {}),
  app: {
    isPackaged: false,
    getPath: vi.fn(),
    getAppPath: () => '/application',
    getLocale: () => 'en',
    getVersion: () => 'test',
    once: vi.fn(),
    removeListener: vi.fn()
  },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', () => ({ mkdtempSync: () => '/temporary-dialog-profile' }))
vi.mock('node:fs/promises', () => ({ rm: mocks.rm }))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('@aipoch/diagnostics/node', async (original) => ({
  ...(await original<typeof import('@aipoch/diagnostics/node')>()),
  createLogger: () => mocks.log
}))

class Helper extends EventEmitter {
  pid = 123
  exitCode: number | null = null
  signalCode: string | null = null
  send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => callback(null))
  kill = vi.fn()
  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}
class Window extends EventEmitter {
  destroyed = false
  enabled = true
  isDestroyed = (): boolean => this.destroyed
  isEnabled = (): boolean => this.enabled
  setEnabled = vi.fn((enabled: boolean) => {
    this.enabled = enabled
  })
  focus = vi.fn()
  asParent(): BaseWindow {
    return this as unknown as BaseWindow
  }
}

let child: Helper
let window: Window
let lifecycle: EventEmitter
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  child = new Helper()
  window = new Window()
  lifecycle = new EventEmitter()
  mocks.spawn.mockReturnValue(child)
  mocks.app.isPackaged = false
  mocks.app.getPath.mockReturnValue(tmpdir())
  mocks.app.once.mockImplementation(lifecycle.once.bind(lifecycle))
  mocks.app.removeListener.mockImplementation(lifecycle.removeListener.bind(lifecycle))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
const filePath = join(tmpdir(), 'private-selected-name.json')
const saveRequest = { kind: 'save' as const, options: { defaultPath: filePath } }

const assertReleased = (): void => {
  expect(window.enabled).toBe(true)
  expect(window.listenerCount('closed')).toBe(0)
  expect(lifecycle.listenerCount('will-quit')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(mocks.rm).toHaveBeenCalledWith('/temporary-dialog-profile', expect.any(Object))
}

describe('isolated native file dialogs', () => {
  it.each([
    { kind: 'save' as const, options: {}, presentation: 'html' },
    { kind: 'open' as const, options: { properties: ['openDirectory'] }, presentation: 'html' },
    { kind: 'open' as const, options: { properties: ['openFile'] }, presentation: 'native' },
    {
      kind: 'open' as const,
      options: { properties: ['openDirectory', 'multiSelections'] },
      presentation: 'native'
    }
  ])(
    'routes Windows $kind $options.properties to $presentation and retains IPC diagnostics',
    async ({ kind, options, presentation }) => {
      vi.stubGlobal('process', { ...process, platform: 'win32' })
      const pending = showFileDialogInHelper(
        { kind, options } as Parameters<typeof showFileDialogInHelper>[0],
        window.asParent()
      )
      child.emit('message', { type: 'ready' })
      expect(child.send).toHaveBeenCalledWith(
        expect.objectContaining({ presentation }),
        expect.any(Function)
      )
      child.emit('message', { type: 'selection-error', errorCode: 'EACCES' })
      expect(mocks.log.info).toHaveBeenCalledWith(
        'operation phase',
        expect.objectContaining({ phase: 'selection-rejected', errorCode: 'EACCES', presentation })
      )
      child.emit('message', { type: 'result', result: { canceled: true } })
      child.exit(0)
      await pending
      assertReleased()
    }
  )
  it('publishes only after clean helper exit and sends private options through inherited IPC', async () => {
    vi.stubEnv('NODE_OPTIONS', '--inspect')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const settled = vi.fn()
    const result = showFileDialogInHelper(saveRequest, window.asParent()).then(settled)
    expect(window.enabled).toBe(false)
    const [, args, options] = mocks.spawn.mock.calls[0]
    expect(args).toEqual(['/application', '--open-science-file-dialog-helper', '--lang=en'])
    expect(JSON.stringify(args)).not.toContain(filePath)
    expect(options.env.NODE_OPTIONS).toBeUndefined()
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(options.stdio).toContain('ipc')
    child.emit('message', { type: 'ready' })
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining(saveRequest),
      expect.any(Function)
    )
    child.emit('message', { type: 'result', result: { canceled: false, filePath } })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    child.exit(0)
    await result
    expect(settled).toHaveBeenCalledWith({ canceled: false, filePath })
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain(filePath)
    expect(child.kill).not.toHaveBeenCalled()
    assertReleased()
  })

  it.each(['before-selection', 'after-selection'] as const)(
    'rejects a native crash %s without an in-process fallback',
    async (stage) => {
      const pending = showFileDialogInHelper(saveRequest, window.asParent())
      const rejection = expect(pending).rejects.toThrow('exited unexpectedly')
      child.emit('message', { type: 'ready' })
      if (stage === 'after-selection')
        child.emit('message', { type: 'result', result: { canceled: false, filePath } })
      child.emit('disconnect')
      child.exit(0xc0000374)
      await rejection
      expect(mocks.log.info).toHaveBeenCalledWith(
        'operation phase',
        expect.objectContaining({ phase: 'helper-exited', exitCode: 0xc0000374 })
      )
      expect(mocks.log.error).toHaveBeenCalledWith(
        'operation failed',
        expect.objectContaining({ reason: 'unexpected-exit' })
      )
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
      assertReleased()
    }
  )

  it.each(['abort', 'window-close', 'quit'] as const)(
    'terminates the helper and rejects late selection on %s',
    async (reason) => {
      const controller = new AbortController()
      const pending = showFileDialogInHelper(saveRequest, window.asParent(), controller.signal)
      const rejection = expect(pending).rejects.toThrow()
      child.emit('message', { type: 'ready' })
      if (reason === 'abort') controller.abort()
      else if (reason === 'quit') lifecycle.emit('will-quit')
      else {
        window.destroyed = true
        window.emit('closed')
      }
      child.emit('message', { type: 'result', result: { canceled: false, filePath } })
      await rejection
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      if (reason !== 'window-close') assertReleased()
      expect(window.focus).not.toHaveBeenCalled()
    }
  )

  it('rejects malformed selection and suppresses concurrent dialogs for the same window', async () => {
    const pending = showFileDialogInHelper(saveRequest, window.asParent())
    const rejection = expect(pending).rejects.toThrow('invalid selection')
    await expect(showFileDialogInHelper(saveRequest, window.asParent())).rejects.toThrow(
      'already open'
    )
    child.emit('message', { type: 'ready' })
    child.emit('message', {
      type: 'result',
      result: { canceled: false, filePath: '../unexpected' }
    })
    await rejection
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    assertReleased()
  })

  it('times out startup and restores the window when the helper cannot become ready', async () => {
    const pending = showFileDialogInHelper(saveRequest, window.asParent())
    const rejection = expect(pending).rejects.toThrow('did not start')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejection
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    assertReleased()
  })

  it('uses the packaged executable without a development app argument and preserves a disabled parent', async () => {
    mocks.app.isPackaged = true
    window.enabled = false
    const pending = showFileDialogInHelper(
      { kind: 'open', options: { properties: ['openDirectory'] } },
      window.asParent()
    )
    expect(mocks.spawn.mock.calls[0][1]).toEqual(['--open-science-file-dialog-helper', '--lang=en'])
    child.emit('message', { type: 'ready' })
    child.emit('message', { type: 'result', result: { canceled: true, filePaths: [] } })
    child.exit(0)
    await expect(pending).resolves.toEqual({ canceled: true, filePaths: [] })
    expect(window.setEnabled).not.toHaveBeenCalled()
    expect(mocks.log.warn).toHaveBeenCalledWith('operation cancelled', expect.any(Object))
  })
})
