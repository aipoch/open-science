import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined,
  directory: '',
  window: null as unknown,
  saveDialog: vi.fn()
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
        if (channel === native.failAt) throw new Error(`install failed: ${channel}`)
        if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
        native.handlers.set(channel, handler)
      },
      removeHandler: (channel: string) => native.handlers.delete(channel)
    }),
    BrowserWindow: { fromWebContents: () => native.window },
    app: { getPath: () => native.directory },
    dialog: { showSaveDialog: native.saveDialog }
  }
})

import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import type { InstalledElectronSurfaceAdapter } from '../runtime-electron-wiring'
import {
  WINDOW_CLOSE_CHANNEL,
  WINDOW_FIND_CLEAR_CHANNEL,
  WINDOW_FIND_CLOSE_CHANNEL,
  WINDOW_FIND_REQUEST_CHANNEL
} from '../../shared/window-controls'
import { createDesktopUtilitiesElectronSurface } from './desktop-utilities'

type Owners = Parameters<typeof createDesktopUtilitiesElectronSurface>[0]
const fixtures = (): {
  owners: Owners
  event: IpcMainInvokeEvent
  sender: EventEmitter & { id: number; send: ReturnType<typeof vi.fn> }
  lease: { copyTo: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
} => {
  const lease = {
    copyTo: vi.fn(async (path: string) => {
      await writeFile(path, 'managed content')
    }),
    close: vi.fn(async () => undefined)
  }
  // Registrars consume the copy/close view; unused business lease fields stay with owner tests.
  const versionLease = lease as unknown as Awaited<
    ReturnType<Owners['managedFileVersions']['openLatest']>
  >
  const sender = Object.assign(new EventEmitter(), { id: 42, send: vi.fn() })
  return {
    lease,
    sender,
    event: { sender } as unknown as IpcMainInvokeEvent,
    owners: {
      resolveManagedFilePath: vi.fn(async () => join(native.directory, 'source.txt')),
      managedFileVersions: {
        openLatest: vi.fn(async () => versionLease),
        openVersion: vi.fn(async () => versionLease)
      },
      notebookInputs: {
        openPreviewKey: vi.fn(
          async () =>
            lease as unknown as Awaited<ReturnType<Owners['notebookInputs']['openPreviewKey']>>
        )
      },
      translate: (text) => text,
      logs: {
        getStatus: vi.fn(async () => ({
          configured: false,
          path: null,
          existing: false,
          lastWriteSucceeded: null,
          lastFailureCategory: null
        })),
        openFile: vi.fn(async () => ({ opened: true })),
        revealInFolder: vi.fn(async () => ({ revealed: true }))
      },
      github: { getStars: vi.fn(async () => 123) },
      cli: {
        getStatus: vi.fn(async () => ({ installed: false, target: 'launcher', onPath: false })),
        install: vi.fn(async () => ({ installed: true, target: 'launcher', onPath: true })),
        uninstall: vi.fn(async () => ({ installed: false, target: 'launcher', onPath: false }))
      }
    }
  }
}
const invoke = (channel: string, event: IpcMainInvokeEvent, request?: unknown): unknown =>
  native.handlers.get(channel)!(event, request)
const installations: InstalledElectronSurfaceAdapter[] = []
const install = async (owners: Owners): Promise<InstalledElectronSurfaceAdapter> => {
  const installation = await createDesktopUtilitiesElectronSurface(owners).install()
  installations.push(installation)
  return installation
}
const eventChannels = [
  WINDOW_FIND_REQUEST_CHANNEL,
  WINDOW_FIND_CLEAR_CHANNEL,
  WINDOW_FIND_CLOSE_CHANNEL
]

beforeEach(async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'desktop-surface-'))
  native.saveDialog.mockResolvedValue({
    canceled: false,
    filePath: join(native.directory, 'saved.txt')
  })
})
afterEach(async () => {
  for (const installation of installations.splice(0).reverse()) await installation.uninstall()
  disposeIpcHandlerRegistry()
  expect(native.handlers.size).toBe(0)
  ipcMain.removeAllListeners()
  native.window = null
  native.failAt = undefined
  vi.restoreAllMocks()
  native.saveDialog.mockReset()
  await rm(native.directory, { recursive: true, force: true })
})

describe('desktop utilities Electron production surface', () => {
  it('lazily installs the original ordered channels and removes only its own registrations', async () => {
    const { owners } = fixtures()
    const surface = createDesktopUtilitiesElectronSurface(owners)
    expect(surface.name).toBe('desktop-utilities')
    expect(native.handlers.size).toBe(0)
    expect(ipcMain.eventNames()).toEqual([])
    ipcMainHandle('test:external', () => undefined)
    const external = vi.fn()
    ipcMain.on(WINDOW_FIND_REQUEST_CHANNEL, external)
    const installed = await install(owners)
    expect([...native.handlers.keys()]).toEqual([
      'test:external',
      'file:save-blob',
      'file:save-managed',
      'file:save-session-artifacts',
      'file:save-project-artifacts',
      'logs:get-status',
      'logs:open-file',
      'logs:reveal-in-folder',
      'github:get-stars',
      'cli:get-status',
      'cli:install',
      'cli:uninstall',
      WINDOW_CLOSE_CHANNEL
    ])
    expect(eventChannels.map((channel) => ipcMain.listenerCount(channel))).toEqual([2, 1, 1])
    await installed.uninstall()
    await installed.uninstall()
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    expect(ipcMain.listeners(WINDOW_FIND_REQUEST_CHANNEL)).toEqual([external])
    expect(eventChannels.slice(1).map((channel) => ipcMain.listenerCount(channel))).toEqual([0, 0])
  })

  it('dispatches logs, GitHub, CLI and window close through the supplied owners', async () => {
    const { owners, event } = fixtures()
    native.window = { close: vi.fn() }
    await install(owners)
    for (const [channel, method] of [
      ['logs:get-status', owners.logs.getStatus],
      ['logs:open-file', owners.logs.openFile],
      ['logs:reveal-in-folder', owners.logs.revealInFolder],
      ['github:get-stars', owners.github.getStars],
      ['cli:get-status', owners.cli.getStatus],
      ['cli:install', owners.cli.install],
      ['cli:uninstall', owners.cli.uninstall]
    ] as const) {
      const result = await invoke(channel, event)
      expect(method).toHaveBeenCalledOnce()
      expect(result).toEqual(await vi.mocked(method).mock.results[0].value)
    }
    await invoke(WINDOW_CLOSE_CHANNEL, event)
    expect((native.window as { close: unknown }).close).toHaveBeenCalledOnce()
  })

  it.each(['artifact', 'upload'] as const)(
    'exports latest and pinned %s through the same version owner',
    async (source) => {
      const { owners, event, lease } = fixtures()
      await install(owners)
      const request = { source, projectId: 'project', fileId: 'file', suggestedName: 'result.txt' }
      await expect(invoke('file:save-managed', event, request)).resolves.toMatchObject({
        saved: true
      })
      expect(owners.managedFileVersions.openLatest).toHaveBeenCalledExactlyOnceWith({
        source,
        projectId: 'project',
        fileId: 'file'
      })
      await expect(
        invoke('file:save-managed', event, { ...request, versionId: 'version' })
      ).resolves.toMatchObject({ saved: true })
      expect(owners.managedFileVersions.openVersion).toHaveBeenCalledExactlyOnceWith(
        { source, projectId: 'project', fileId: 'file' },
        'version'
      )
      expect(lease.close).toHaveBeenCalledTimes(2)
      expect(await readFile(join(native.directory, 'saved.txt'), 'utf8')).toBe('managed content')
    }
  )

  it('uses the Notebook preview owner and closes its lease when saving is cancelled', async () => {
    const { owners, event, lease } = fixtures()
    native.saveDialog.mockResolvedValue({ canceled: true })
    await install(owners)
    await expect(
      invoke('file:save-managed', event, {
        source: 'notebook-input',
        path: 'input-key',
        suggestedName: 'input.txt'
      })
    ).resolves.toEqual({ saved: false })
    expect(owners.notebookInputs.openPreviewKey).toHaveBeenCalledExactlyOnceWith('input-key')
    expect(lease.copyTo).not.toHaveBeenCalled()
    expect(lease.close).toHaveBeenCalledOnce()
  })

  it.each(['local', 'literature'] as const)(
    'uses the supplied %s path authority and translator',
    async (source) => {
      const { owners, event } = fixtures()
      await writeFile(join(native.directory, 'source.txt'), 'source content')
      owners.translate = (text) => `translated:${text}`
      await install(owners)
      await expect(
        invoke('file:save-managed', event, {
          source,
          path: 'authority-key',
          suggestedName: 'file.txt'
        })
      ).resolves.toMatchObject({ saved: true })
      expect(owners.resolveManagedFilePath).toHaveBeenCalledExactlyOnceWith(source, {
        path: 'authority-key'
      })
      expect(native.saveDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'translated:Save file' })
      )
      expect(await readFile(join(native.directory, 'saved.txt'), 'utf8')).toBe('source content')
    }
  )

  it('owns find listeners across uninstall and reinstall, including late native results', async () => {
    const { owners, event, sender } = fixtures()
    const target = Object.assign(new EventEmitter(), {
      findInPage: vi.fn(() => 17),
      stopFindInPage: vi.fn()
    })
    native.window = { webContents: target }
    const request = { requestId: 1, text: 'text', findNext: true, forward: true }
    const first = await install(owners)
    ipcMain.emit(WINDOW_FIND_REQUEST_CHANNEL, event, request)
    await first.uninstall()
    target.emit(
      'found-in-page',
      {},
      { requestId: 17, activeMatchOrdinal: 1, matches: 1, finalUpdate: true }
    )
    expect(sender.send).not.toHaveBeenCalled()
    expect(target.listenerCount('found-in-page')).toBe(0)
    await install(owners)
    target.findInPage.mockClear()
    ipcMain.emit(WINDOW_FIND_REQUEST_CHANNEL, event, request)
    expect(target.findInPage).toHaveBeenCalledOnce()
  })

  it.each([
    'file:save-managed',
    'logs:open-file',
    'cli:install',
    WINDOW_CLOSE_CHANNEL,
    WINDOW_FIND_CLOSE_CHANNEL
  ])('rolls back the group if %s registration fails', (channel) => {
    ipcMainHandle('test:external', () => undefined)
    const external = vi.fn()
    ipcMain.on(WINDOW_FIND_REQUEST_CHANNEL, external)
    native.failAt = channel
    const on = ipcMain.on.bind(ipcMain)
    vi.spyOn(ipcMain, 'on').mockImplementation((name, listener) => {
      if (name === native.failAt) throw new Error(`install failed: ${name}`)
      return on(name, listener)
    })
    expect(() => createDesktopUtilitiesElectronSurface(fixtures().owners).install()).toThrow(
      `install failed: ${channel}`
    )
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    expect(ipcMain.listeners(WINDOW_FIND_REQUEST_CHANNEL)).toEqual([external])
    expect(eventChannels.slice(1).map((name) => ipcMain.listenerCount(name))).toEqual([0, 0])
  })
})
