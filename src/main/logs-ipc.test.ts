import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the mock factory can mutate the observed log state per test.
const logStatus = vi.hoisted(() => ({
  value: {
    configured: true,
    path: '/logs/main.log' as string | null,
    existing: true,
    lastWriteSucceeded: true as boolean | null,
    lastFailureCategory: null as 'directory' | 'inspect' | 'rotation' | 'append' | null
  }
}))

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
  getLogFileStatus: async () => logStatus.value
}))

const { registerLogsIpcHandlers } = await import('./logs-ipc')
type LogsCommandOwner = import('./logs-ipc').LogsCommandOwner

const invoke = (channel: string): unknown => handlers.get(channel)!(undefined, undefined)

describe('logs IPC handlers', () => {
  beforeEach(() => {
    handlers.clear()
    openPath.mockClear()
    showItemInFolder.mockClear()
    logStatus.value = {
      configured: true,
      path: '/logs/main.log',
      existing: true,
      lastWriteSucceeded: true,
      lastFailureCategory: null
    }
  })

  it('delegates every channel to one injected command owner', async () => {
    const owner: LogsCommandOwner = {
      getStatus: vi.fn(async () => ({
        configured: true,
        path: '/injected/main.log',
        existing: true,
        lastWriteSucceeded: true,
        lastFailureCategory: null
      })),
      openFile: vi.fn().mockResolvedValue({ opened: true }),
      revealInFolder: vi.fn(async () => ({ revealed: true }))
    }

    expect(registerLogsIpcHandlers(owner)).toBe(owner)
    await expect(invoke('logs:get-status')).resolves.toMatchObject({ path: '/injected/main.log' })
    await expect(invoke('logs:open-file')).resolves.toEqual({ opened: true })
    await expect(invoke('logs:reveal-in-folder')).resolves.toEqual({ revealed: true })
  })

  it('registers the diagnostics channels', () => {
    handlers.clear()
    registerLogsIpcHandlers()

    expect(handlers.has('logs:get-status')).toBe(true)
    expect(handlers.has('logs:open-file')).toBe(true)
    expect(handlers.has('logs:reveal-in-folder')).toBe(true)
  })

  it('returns the observed log file status', async () => {
    handlers.clear()
    registerLogsIpcHandlers()

    await expect(invoke('logs:get-status')).resolves.toEqual(logStatus.value)
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

  it('does not ask the OS to open a configured log file that does not exist', async () => {
    logStatus.value = {
      configured: true,
      path: '/logs/main.log',
      existing: false,
      lastWriteSucceeded: null,
      lastFailureCategory: null
    }
    registerLogsIpcHandlers()

    await expect(invoke('logs:open-file')).resolves.toEqual({
      opened: false,
      error: 'No log file is available yet.'
    })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reveals the log file in its containing folder when a path is available', async () => {
    registerLogsIpcHandlers()

    await expect(invoke('logs:reveal-in-folder')).resolves.toEqual({ revealed: true })
    expect(showItemInFolder).toHaveBeenCalledTimes(1)
    expect(showItemInFolder).toHaveBeenCalledWith('/logs/main.log')
  })

  it('reports a missing log file when reveal is requested before one is written', async () => {
    logStatus.value = {
      configured: true,
      path: '/logs/main.log',
      existing: false,
      lastWriteSucceeded: null,
      lastFailureCategory: null
    }
    registerLogsIpcHandlers()

    expect(await invoke('logs:reveal-in-folder')).toEqual({
      revealed: false,
      error: 'No log file is available yet.'
    })
    expect(showItemInFolder).not.toHaveBeenCalled()
  })
})
