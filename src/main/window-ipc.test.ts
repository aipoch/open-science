import { describe, expect, it, vi } from 'vitest'

// Capture ipcMain.handle registrations so the handler can be invoked directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: {}
}))

const { registerWindowIpcHandlers } = await import('./window-ipc')
const { WINDOW_CLOSE_CHANNEL } = await import('../shared/window-controls')
const ZOOM_CHANNEL = 'window:set-zoom-factor'

const invoke = (sender: unknown): unknown => handlers.get(WINDOW_CLOSE_CHANNEL)!({ sender })

describe('window IPC handler', () => {
  it('registers the close channel', () => {
    handlers.clear()
    registerWindowIpcHandlers()
    expect(handlers.has(WINDOW_CLOSE_CHANNEL)).toBe(true)
    expect(handlers.has(ZOOM_CHANNEL)).toBe(true)
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

  it('sets an allowed zoom factor on the owning window', () => {
    handlers.clear()
    const setZoomFactor = vi.fn()
    const sender = {}
    const resolveWindow = vi.fn().mockReturnValue({
      close: vi.fn(),
      webContents: { getZoomFactor: () => 1, setZoomFactor }
    })
    registerWindowIpcHandlers({ resolveWindow })

    handlers.get(ZOOM_CHANNEL)!({ sender }, 1.25)

    expect(setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('avoids resetting an already matching zoom factor', () => {
    handlers.clear()
    const setZoomFactor = vi.fn()
    registerWindowIpcHandlers({
      resolveWindow: () => ({
        close: vi.fn(),
        webContents: { getZoomFactor: () => 1, setZoomFactor }
      })
    })

    handlers.get(ZOOM_CHANNEL)!({ sender: {} }, 1)

    expect(setZoomFactor).not.toHaveBeenCalled()
  })

  it('rejects zoom factors outside the shared allow-list', () => {
    handlers.clear()
    const setZoomFactor = vi.fn()
    registerWindowIpcHandlers({
      resolveWindow: () => ({ close: vi.fn(), webContents: { setZoomFactor } })
    })

    handlers.get(ZOOM_CHANNEL)!({ sender: {} }, 1.2)

    expect(setZoomFactor).not.toHaveBeenCalled()
  })
})
