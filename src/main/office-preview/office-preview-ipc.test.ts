import { beforeEach, describe, expect, it, vi } from 'vitest'

type TestSender = {
  id: number
  once: (event: string, listener: () => void) => void
}

const handlers = new Map<string, (event: { sender: TestSender }, ...args: unknown[]) => unknown>()
const listeners = new Map<string, (event: { sender: TestSender }, ...args: unknown[]) => unknown>()
const windowHarness = vi.hoisted(() => ({
  resizeListener: undefined as (() => void) | undefined,
  isDestroyed: vi.fn(() => false),
  getContentSize: vi.fn(() => [1400, 900] as [number, number]),
  on: vi.fn((event: string, listener: () => void) => {
    if (event === 'resize') windowHarness.resizeListener = listener
  }),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => windowHarness)
  },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: typeof handlers extends Map<string, infer T> ? T : never) => {
        handlers.set(channel, handler)
      }
    ),
    on: vi.fn(
      (channel: string, listener: typeof listeners extends Map<string, infer T> ? T : never) => {
        listeners.set(channel, listener)
      }
    )
  }
}))

const { registerOfficePreviewIpcHandlers } = await import('./office-preview-ipc')
const { OfficePreviewOpenSupersededError } = await import('./office-preview-supervisor')

describe('registerOfficePreviewIpcHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listeners.clear()
    windowHarness.resizeListener = undefined
    windowHarness.isDestroyed.mockClear()
    windowHarness.getContentSize.mockClear()
    windowHarness.on.mockClear()
    windowHarness.removeListener.mockClear()
  })

  it('derives Office preview ownership from the sending webContents', async () => {
    const supervisor = {
      open: vi.fn().mockResolvedValue({ kind: 'started', sessionId: 'session-1' }),
      setBounds: vi.fn(),
      resizeOwner: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      closeOwner: vi.fn().mockResolvedValue(undefined)
    }
    registerOfficePreviewIpcHandlers(supervisor)
    let destroyed: (() => void) | undefined
    let renderProcessGone: (() => void) | undefined
    const event = {
      sender: {
        id: 7,
        once: vi.fn((event: string, listener: () => void) => {
          if (event === 'destroyed') destroyed = listener
          if (event === 'render-process-gone') renderProcessGone = listener
        })
      }
    }
    const request = {
      source: 'artifact' as const,
      path: 'project/session/report.xlsx',
      name: 'report.xlsx',
      extension: 'xlsx' as const,
      attempt: 0
    }
    const bounds = {
      x: 1,
      y: 2,
      width: 300,
      height: 200,
      visible: true,
      sequence: 1,
      viewportWidth: 1280,
      viewportHeight: 800
    }

    await handlers.get('office-preview:open')?.(event, request)
    listeners.get('office-preview:set-bounds')?.(event, 'session-1', bounds)
    await handlers.get('office-preview:close')?.(event, 'session-1')

    expect(supervisor.open).toHaveBeenCalledWith(7, request)
    expect(supervisor.setBounds).toHaveBeenCalledWith(7, 'session-1', bounds)
    expect(supervisor.close).toHaveBeenCalledWith(7, 'session-1')

    windowHarness.resizeListener?.()
    expect(supervisor.resizeOwner).toHaveBeenCalledWith(7, { width: 1400, height: 900 })

    renderProcessGone?.()
    await Promise.resolve()
    expect(supervisor.closeOwner).toHaveBeenCalledWith(7)
    expect(windowHarness.removeListener).toHaveBeenCalledWith('resize', expect.any(Function))

    destroyed?.()
    await Promise.resolve()
    expect(supervisor.closeOwner).toHaveBeenCalledTimes(1)
  })

  it('returns an explicit cancellation for a superseded development remount', async () => {
    const supervisor = {
      open: vi.fn().mockRejectedValue(new OfficePreviewOpenSupersededError()),
      setBounds: vi.fn(),
      resizeOwner: vi.fn(),
      close: vi.fn(),
      closeOwner: vi.fn()
    }
    registerOfficePreviewIpcHandlers(supervisor)
    const sender = { id: 8, once: vi.fn() }

    await expect(
      handlers.get('office-preview:open')?.(
        { sender },
        {
          source: 'artifact',
          path: 'report.xlsx',
          name: 'report.xlsx',
          extension: 'xlsx',
          attempt: 0
        }
      )
    ).resolves.toEqual({ kind: 'cancelled' })
  })

  it('ignores malformed one-way bounds messages', () => {
    const supervisor = {
      open: vi.fn(),
      setBounds: vi.fn(),
      resizeOwner: vi.fn(),
      close: vi.fn(),
      closeOwner: vi.fn()
    }
    registerOfficePreviewIpcHandlers(supervisor)
    const event = { sender: { id: 7, once: vi.fn() } }
    const listener = listeners.get('office-preview:set-bounds')

    expect(() => listener?.(event, 'session-1', { x: 'invalid' })).not.toThrow()
    expect(() => listener?.(event, 123, undefined)).not.toThrow()
    expect(supervisor.setBounds).not.toHaveBeenCalled()
  })

  it('contains unexpected failures from the one-way bounds handler', () => {
    const supervisor = {
      open: vi.fn(),
      setBounds: vi.fn(() => {
        throw new Error('unexpected bounds failure')
      }),
      resizeOwner: vi.fn(),
      close: vi.fn(),
      closeOwner: vi.fn()
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registerOfficePreviewIpcHandlers(supervisor)
    const event = { sender: { id: 7, once: vi.fn() } }
    const listener = listeners.get('office-preview:set-bounds')
    let thrown: unknown

    try {
      listener?.(event, 'session-1', {
        x: 640,
        y: 72,
        width: 620,
        height: 708,
        visible: true,
        sequence: 1,
        viewportWidth: 1280,
        viewportHeight: 800
      })
    } catch (caught) {
      thrown = caught
    }
    error.mockRestore()

    expect(thrown).toBeUndefined()
    expect(supervisor.setBounds).toHaveBeenCalledOnce()
  })

  it('contains owner resize failures inside the native window callback', async () => {
    const failure = new Error('native resize failed')
    const supervisor = {
      open: vi.fn().mockResolvedValue({ kind: 'started', sessionId: 'session-1' }),
      setBounds: vi.fn(),
      resizeOwner: vi.fn(() => {
        throw failure
      }),
      close: vi.fn(),
      closeOwner: vi.fn()
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    registerOfficePreviewIpcHandlers(supervisor)
    const event = { sender: { id: 7, once: vi.fn() } }

    await handlers.get('office-preview:open')?.(event, {
      requestId: 'request-1',
      source: 'artifact',
      path: 'report.xlsx',
      name: 'report.xlsx',
      extension: 'xlsx',
      attempt: 0
    })
    let thrown: unknown
    try {
      windowHarness.resizeListener?.()
    } catch (caught) {
      thrown = caught
    }
    error.mockRestore()

    expect(thrown).toBeUndefined()
  })
})
