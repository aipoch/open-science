import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

vi.mock('@aipoch/diagnostics/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aipoch/diagnostics/node')>()),
  getLogFileStatus: async () => logStatus.value
}))

const { registerLogsIpcHandlers, createLogsCommandOwner } = await import('./logs-ipc')
type LogsCommandOwner = import('./logs-ipc').LogsCommandOwner

const invoke = (channel: string, name?: string): unknown => handlers.get(channel)!(undefined, name)

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

  it('lists all startup logs newest first and opens/reveals the selected historical file safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'settings-logs-'))
    try {
      const logs = join(root, 'logs')
      await mkdir(logs)
      const older = 'desktop-backend-42-1700000000000.log'
      const newer = 'desktop-backend-43-1700000000001.log'
      await writeFile(join(logs, older), 'failed startup')
      await writeFile(join(logs, newer), 'started')
      await writeFile(join(root, 'private.log'), 'private')
      await symlink(join(root, 'private.log'), join(logs, 'desktop-backend-44-1700000000002.log'))
      await mkdir(join(logs, 'desktop-backend-45-1700000000003.log'))
      vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
      const owner = createLogsCommandOwner()
      expect((await owner.getStatus()).startupFiles?.map((file) => file.name)).toEqual([
        newer,
        older
      ])
      await expect(owner.openFile(older)).resolves.toEqual({ opened: true })
      expect(openPath).toHaveBeenLastCalledWith(await realpath(join(logs, older)))
      await expect(owner.revealInFolder(older)).resolves.toEqual({ revealed: true })
      expect(showItemInFolder).toHaveBeenLastCalledWith(await realpath(join(logs, older)))
      for (const name of [
        '../private.log',
        join(root, 'private.log'),
        'desktop-backend-44-1700000000002.log'
      ]) {
        await expect(owner.openFile(name)).resolves.toMatchObject({ opened: false })
      }
      await rm(join(logs, older))
      await expect(owner.revealInFolder(older)).resolves.toMatchObject({ revealed: false })
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps main log status and actions available when the startup log directory cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'settings-logs-unavailable-'))
    try {
      await writeFile(join(root, 'logs'), 'not a directory')
      vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
      const owner = createLogsCommandOwner()
      await expect(owner.getStatus()).resolves.toEqual({ ...logStatus.value, startupFiles: [] })
      await expect(owner.openFile()).resolves.toEqual({ opened: true })
      await expect(owner.revealInFolder()).resolves.toEqual({ revealed: true })
      expect(openPath).toHaveBeenCalledWith(logStatus.value.path)
      expect(showItemInFolder).toHaveBeenCalledWith(logStatus.value.path)
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
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
    await expect(invoke('logs:open-file', 'desktop-backend-42-1700000000000.log')).resolves.toEqual(
      { opened: true }
    )
    expect(owner.openFile).toHaveBeenCalledWith('desktop-backend-42-1700000000000.log')
    await expect(
      invoke('logs:reveal-in-folder', 'desktop-backend-42-1700000000000.log')
    ).resolves.toEqual({ revealed: true })
    expect(owner.revealInFolder).toHaveBeenCalledWith('desktop-backend-42-1700000000000.log')
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

    await expect(invoke('logs:get-status')).resolves.toMatchObject(logStatus.value)
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

await (await import('../../test/runtime-host')).configureTestElectronHost(await import('electron'))
