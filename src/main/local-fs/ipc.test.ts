import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}))

// The real registry is built over this fake ipcMain so channel tracking and adapter teardown behave
// exactly as they do in the app.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler),
    removeHandler: (channel: string) => ipcHandlers.delete(channel)
  }
}))

import { createIpcHandlerInstallationScope } from '../ipc-handler-registry'
import type { LocalFsService } from './service'
import {
  LOCAL_FS_GET_ROOTS_CHANNEL,
  LOCAL_FS_GRANTED_ROOTS_LIST_CHANNEL,
  LOCAL_FS_GRANTED_ROOTS_REMOVE_CHANNEL,
  LOCAL_FS_GRANTED_ROOTS_SET_ACCESS_CHANNEL,
  LOCAL_FS_GRANT_ROOT_CHANNEL,
  LOCAL_FS_LIST_DIR_CHANNEL,
  LOCAL_FS_OPEN_PATH_CHANNEL,
  LOCAL_FS_READ_PREVIEW_CHANNEL,
  LOCAL_FS_REVEAL_CHANNEL,
  registerLocalFsIpcHandlers
} from './ipc'

const CHANNELS = [
  LOCAL_FS_GET_ROOTS_CHANNEL,
  LOCAL_FS_LIST_DIR_CHANNEL,
  LOCAL_FS_OPEN_PATH_CHANNEL,
  LOCAL_FS_READ_PREVIEW_CHANNEL,
  LOCAL_FS_REVEAL_CHANNEL,
  LOCAL_FS_GRANTED_ROOTS_LIST_CHANNEL,
  LOCAL_FS_GRANT_ROOT_CHANNEL,
  LOCAL_FS_GRANTED_ROOTS_SET_ACCESS_CHANNEL,
  LOCAL_FS_GRANTED_ROOTS_REMOVE_CHANNEL
]

const createServiceStub = (): LocalFsService =>
  ({
    getRoots: vi.fn(() => ({ machineName: 'host', home: '/Users/test', roots: [] })),
    listDir: vi.fn(async () => ({ path: '/Users/test', entries: [], truncated: false })),
    openPath: vi.fn(async () => ''),
    readPreview: vi.fn(async () => ({ kind: 'text', text: '' })),
    revealInFolder: vi.fn(),
    listGrantedRoots: vi.fn(async () => []),
    grantRoot: vi.fn(async () => []),
    setGrantedRootAccess: vi.fn(async () => []),
    removeGrantedRoot: vi.fn(async () => [])
  }) as unknown as LocalFsService

beforeEach(() => {
  ipcHandlers.clear()
})

describe('registerLocalFsIpcHandlers', () => {
  // Raw ipcMain.handle registers a working handler but stays invisible to the registry, which
  // silently breaks adapter teardown. Assert the registry actually sees them.
  it('registers every channel through the handler registry so teardown can remove them', () => {
    const scope = createIpcHandlerInstallationScope()
    registerLocalFsIpcHandlers(createServiceStub())
    const installation = scope.complete()

    expect([...ipcHandlers.keys()].sort()).toEqual([...CHANNELS].sort())

    installation.uninstall()
    expect([...ipcHandlers.keys()]).toEqual([])
  })
  it('forwards grant-root requests to the service', async () => {
    const service = createServiceStub()
    registerLocalFsIpcHandlers(service)

    await ipcHandlers.get(LOCAL_FS_GRANT_ROOT_CHANNEL)?.(
      {},
      { path: '/Users/test/Documents', access: 'ro' }
    )
    expect(service.grantRoot).toHaveBeenCalledWith({
      path: '/Users/test/Documents',
      access: 'ro'
    })
  })
})
