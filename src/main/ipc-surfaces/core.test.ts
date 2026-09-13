import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined
}))

// Keep the real surface registrars, registry, runtime builder and phase installer. Only Electron
// and the unrelated Compute/ACP transports are replaced; business owners are supplied below.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      if (native.failAt === channel) throw new Error(`install failed: ${channel}`)
      if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      native.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => native.handlers.delete(channel)
  }
}))
vi.mock('../compute/ipc', () => ({ installComputeIpcHandlers: () => ({ uninstall: vi.fn() }) }))
vi.mock('../acp/ipc', () => ({ installAcpIpcHandlers: () => ({ uninstall: vi.fn() }) }))

import { createCoreElectronSurfaces, type CoreElectronSurfaceDependencies } from './core'
import { createElectronSurfaceAdapter } from './adapter'
import { composeApplicationRuntimeWithAdapters } from '../application-runtime'
import {
  installElectronRuntimeAdapters,
  type ElectronRuntimeAdapterInterfaces
} from '../runtime-electron-wiring'
import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'

const fixture = (): {
  dependencies: CoreElectronSurfaceDependencies
  owners: Record<string, ReturnType<typeof vi.fn>>
} => {
  const owners = {
    permissions: vi.fn(async () => ({ grants: [] })),
    projectFiles: vi.fn(async () => ({ entries: [] })),
    versions: vi.fn(async () => ({ ok: true, value: {} })),
    localFs: vi.fn(() => ({ roots: [] })),
    preview: vi.fn(async () => null)
  }
  // Only these public owner methods are invoked; registrars must not construct fallback owners.
  const dependencies = {
    permissionGrantProjection: { list: owners.permissions },
    projectFiles: [{}, {}, {}, { listFiles: owners.projectFiles }],
    managedFileVersionHandlers: { inspect: owners.versions },
    localFsService: { getRoots: owners.localFs },
    previewStateRepository: { get: owners.preview }
  } as unknown as CoreElectronSurfaceDependencies
  return { dependencies, owners }
}

const compose = (
  dependencies: CoreElectronSurfaceDependencies,
  disposed: string[] = []
): ReturnType<typeof composeApplicationRuntimeWithAdapters> =>
  composeApplicationRuntimeWithAdapters(async (modules) => {
    await modules.add(undefined, () => ({
      capability: undefined,
      dispose: () => {
        expect(
          [...native.handlers.keys()].filter((channel) => channel !== 'test:external')
        ).toEqual([])
        disposed.push('first')
      }
    }))
    await modules.add(undefined, () => ({
      capability: undefined,
      dispose: () => {
        expect(
          [...native.handlers.keys()].filter((channel) => channel !== 'test:external')
        ).toEqual([])
        disposed.push('second')
      }
    }))
    return {
      electronAdapters: {
        beforeCompute: [],
        beforeAcp: [],
        compute: {} as ElectronRuntimeAdapterInterfaces['compute'],
        acp: {} as ElectronRuntimeAdapterInterfaces['acp'],
        afterAcp: createCoreElectronSurfaces(dependencies)
      }
    }
  }, installElectronRuntimeAdapters)

afterEach(() => {
  native.failAt = undefined
  disposeIpcHandlerRegistry()
  expect(native.handlers.size).toBe(0)
})

describe('core Electron production composition', () => {
  it('defers installation, dispatches through supplied owners, and removes only its channels', async () => {
    const { dependencies, owners } = fixture()
    const surfaces = createCoreElectronSurfaces(dependencies)
    expect(surfaces.map(({ name }) => name)).toEqual([
      'permission-grants',
      'project-files',
      'managed-file-versions',
      'local-fs',
      'preview-state',
      'lifecycle'
    ])
    expect(native.handlers.size).toBe(0)
    const external = await createElectronSurfaceAdapter('external', () =>
      ipcMainHandle('test:external', () => 'external')
    ).install()
    const disposed: string[] = []
    const runtime = await compose(dependencies, disposed)
    expect(native.handlers.size).toBe(31) // 30 production channels plus the independently owned one.
    const event = { sender: { id: 42 } } as Parameters<Parameters<IpcMain['handle']>[1]>[0]
    const request = { projectId: 'project', fileId: 'file' }
    for (const channel of [
      'permissions:list',
      'project-files:list-files',
      'managed-file-versions:inspect',
      'local-fs:get-roots'
    ]) {
      await native.handlers.get(channel)!(event, request)
    }
    await native.handlers.get('preview:load')!(event, request)
    expect(native.handlers.get(LIFECYCLE_CHANNELS.clientId)!(event)).toBe('electron:42')
    expect(owners.permissions).toHaveBeenCalledOnce()
    expect(owners.projectFiles).toHaveBeenCalledWith(request)
    expect(owners.versions).toHaveBeenCalledWith(request)
    expect(owners.localFs).toHaveBeenCalledOnce()
    expect(owners.preview).toHaveBeenCalledWith('project')

    await runtime.dispose()
    await runtime.dispose()
    expect(disposed).toEqual(['second', 'first'])
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    await external.uninstall()
  })

  it.each([
    'permissions:revoke',
    'project-files:resolve-file',
    'managed-file-versions:cancel-diff',
    'local-fs:read-preview',
    'preview:save',
    LIFECYCLE_CHANNELS.clientId
  ])(
    'rolls back partial %s installation and earlier surfaces before releasing owners',
    async (channel) => {
      native.failAt = channel
      const disposed: string[] = []
      await expect(compose(fixture().dependencies, disposed)).rejects.toThrow(
        `install failed: ${channel}`
      )
      expect(native.handlers.size).toBe(0)
      expect(disposed).toEqual(['second', 'first'])
    }
  )
})
