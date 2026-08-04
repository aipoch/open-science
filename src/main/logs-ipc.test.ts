import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the mock factory can mutate `logPath` per test.
const logPath = vi.hoisted(() => ({ value: '/logs/main.log' as string | null }))

// Capture ipcMain.handle registrations and stub shell.showItemInFolder / shell.openPath so handlers
// can be invoked directly from tests.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
const openPath = vi.fn<(path: string) => Promise<string>>().mockResolvedValue('')
const showItemInFolder = vi.fn<(path: string) => void>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  shell: {
    openPath: (path: string) => openPath(path),
    showItemInFolder: (path: string) => showItemInFolder(path)
  }
}))

vi.mock('./logger', () => ({
  getLogFilePath: () => logPath.value
}))

const { registerLogsIpcHandlers } = await import('./logs-ipc')
type LogsCommandOwner = import('./logs-ipc').LogsCommandOwner

const invoke = (channel: string): unknown => handlers.get(channel)!(undefined, undefined)

describe('logs IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    openPath.mockClear()
    showItemInFolder.mockClear()
    logPath.value = '/logs/main.log'
  })

  it('delegates every channel to one injected command owner', async () => {
    const owner: LogsCommandOwner = {
      getPath: vi.fn(() => '/injected/main.log'),
      openFile: vi.fn().mockResolvedValue({ opened: true }),
      revealInFolder: vi.fn(() => ({ revealed: true }))
    }

    expect(registerLogsIpcHandlers(owner)).toBe(owner)
    expect(invoke('logs:get-path')).toBe('/injected/main.log')
    await expect(invoke('logs:open-file')).resolves.toEqual({ opened: true })
    expect(invoke('logs:reveal-in-folder')).toEqual({ revealed: true })
  })

  it('registers the diagnostics channels', () => {
    handlers.clear()
    registerLogsIpcHandlers()

    expect(handlers.has('logs:get-path')).toBe(true)
    expect(handlers.has('logs:open-file')).toBe(true)
    expect(handlers.has('logs:reveal-in-folder')).toBe(true)
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

  it('reveals the log file in its containing folder when a path is available', () => {
    registerLogsIpcHandlers()

    expect(invoke('logs:reveal-in-folder')).toEqual({ revealed: true })
    expect(showItemInFolder).toHaveBeenCalledTimes(1)
    expect(showItemInFolder).toHaveBeenCalledWith('/logs/main.log')
  })

  it('reports a missing log file when reveal is requested before one is written', () => {
    logPath.value = null
    registerLogsIpcHandlers()

    expect(invoke('logs:reveal-in-folder')).toEqual({
      revealed: false,
      error: 'No log file is available yet.'
    })
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})
