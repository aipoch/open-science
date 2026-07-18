import { describe, expect, it, vi } from 'vitest'

// Capture ipcMain.handle registrations so the handler can be invoked directly.
const handlers = new Map<string, (event: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: {}
}))

const { registerWindowIpcHandlers } = await import('./window-ipc')
const { WINDOW_CLOSE_CHANNEL } = await import('../shared/window-controls')

const invoke = (sender: unknown): unknown => handlers.get(WINDOW_CLOSE_CHANNEL)!({ sender })

describe('window IPC handler', () => {
  it('registers the close channel', () => {
    handlers.clear()
    registerWindowIpcHandlers()
    expect(handlers.has(WINDOW_CLOSE_CHANNEL)).toBe(true)
  })

  it('closes the window that owns the invoking web contents', () => {
    handlers.clear()
    const close = vi.fn()
    const sender = {}
    const resolveWindow = vi.fn().mockReturnValue({ close })
    registerWindowIpcHandlers({ resolveWindow })

    invoke(sender)

    expect(resolveWindow).toHaveBeenCalledWith(sender)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('no-ops when the sender has no owning window', () => {
    handlers.clear()
    registerWindowIpcHandlers({ resolveWindow: () => null })

    expect(() => invoke({})).not.toThrow()
  })
})
