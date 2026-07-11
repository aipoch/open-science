import { describe, expect, it, vi } from 'vitest'

// Capture ipcMain.handle registrations and stub shell.openPath so handlers can be invoked directly.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
const openPath = vi.fn<(path: string) => Promise<string>>().mockResolvedValue('')

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  shell: {
    openPath: (path: string) => openPath(path)
  }
}))

vi.mock('./logger', () => ({
  getLogFilePath: () => '/logs/main.log'
}))

const { registerLogsIpcHandlers } = await import('./logs-ipc')

const invoke = (channel: string): unknown => handlers.get(channel)!(undefined, undefined)

describe('logs IPC handlers', () => {
  it('registers the diagnostics channels', () => {
    handlers.clear()
    registerLogsIpcHandlers()

    expect(handlers.has('logs:get-path')).toBe(true)
    expect(handlers.has('logs:open-file')).toBe(true)
  })

  it('returns the log file path', () => {
    handlers.clear()
    registerLogsIpcHandlers()

    expect(invoke('logs:get-path')).toBe('/logs/main.log')
  })

  it('opens the log file (not its folder) and reports success', async () => {
    handlers.clear()
    openPath.mockClear()
    registerLogsIpcHandlers()

    await expect(invoke('logs:open-file')).resolves.toEqual({ opened: true })
    expect(openPath).toHaveBeenCalledWith('/logs/main.log')
  })

  it('reports failure text when the OS cannot open the file', async () => {
    handlers.clear()
    openPath.mockResolvedValueOnce('no application')
    registerLogsIpcHandlers()

    await expect(invoke('logs:open-file')).resolves.toEqual({
      opened: false,
      error: 'no application'
    })
  })
})
