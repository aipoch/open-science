import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  protocols: new Map<string, (request: Request) => Promise<Response>>(),
  order: [] as string[],
  failAt: undefined as string | undefined,
  fetch: vi.fn<typeof fetch>(),
  fromId: vi.fn(),
  getAppMetrics: vi.fn()
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]): void => {
        native.order.push(`handle:${channel}`)
        if (native.failAt === channel) throw new Error(`install failed: ${channel}`)
        if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
        native.handlers.set(channel, handler)
      },
      removeHandler: (channel: string): void => {
        native.order.push(`remove:${channel}`)
        native.handlers.delete(channel)
      }
    }),
    protocol: {
      handle: (scheme: string, handler: (request: Request) => Promise<Response>): void => {
        native.order.push(`protocol:${scheme}`)
        if (native.failAt === scheme) throw new Error(`install failed: ${scheme}`)
        if (native.protocols.has(scheme)) throw new Error(`duplicate protocol: ${scheme}`)
        native.protocols.set(scheme, handler)
      },
      unhandle: (scheme: string): void => {
        native.order.push(`unhandle:${scheme}`)
        native.protocols.delete(scheme)
      }
    },
    net: { fetch: native.fetch },
    webContents: { fromId: native.fromId },
    app: { getAppMetrics: native.getAppMetrics }
  }
})

import { ipcMain } from 'electron'
import {
  OFFICE_PREVIEW_MAX_FILE_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES,
  OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS,
  OFFICE_PREVIEW_RUNTIME_SCHEME,
  type OfficePreviewOpenRequest,
  type OfficePreviewOpenResult
} from '../../shared/office-preview'
import type { ManagedPreviewResourceSnapshot } from '../managed-preview-resources'
import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import type { InstalledElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { createOfficePreviewElectronSurfaces } from './office-preview'

const runtimeHtmlPath = resolve('test-renderer', 'office-preview.html')
const snapshot: ManagedPreviewResourceSnapshot = {
  size: 123,
  version: 7,
  dev: 1n,
  ino: 2n,
  mtimeNs: 3n
}
const resource = {
  id: 'resource-1',
  url: 'open-science-preview://resource/resource-1',
  size: snapshot.size,
  version: snapshot.version,
  mimeType: 'application/octet-stream'
}
const previewResources = {
  inspect:
    vi.fn<
      Parameters<typeof createOfficePreviewElectronSurfaces>[0]['previewResources']['inspect']
    >(),
  acquire:
    vi.fn<
      Parameters<typeof createOfficePreviewElectronSurfaces>[0]['previewResources']['acquire']
    >(),
  release:
    vi.fn<
      Parameters<typeof createOfficePreviewElectronSurfaces>[0]['previewResources']['release']
    >()
}
const request: OfficePreviewOpenRequest = {
  source: 'artifact',
  projectId: 'project-1',
  fileId: 'file-1',
  requestId: 'request-1',
  name: 'report.docx',
  extension: 'docx',
  attempt: 1
}
const owner = (): EventEmitter & { id: number; send: ReturnType<typeof vi.fn> } =>
  Object.assign(new EventEmitter(), { id: 17, send: vi.fn() })
type Owner = ReturnType<typeof owner>
const invoke = (sender: Owner, channel: string, payload: unknown): unknown => {
  const handler = native.handlers.get(`office-preview:${channel}`)
  if (!handler) throw new Error(`missing Office channel: ${channel}`)
  return handler({ sender } as unknown as IpcMainInvokeEvent, payload)
}
const open = async (
  sender: Owner,
  input: OfficePreviewOpenRequest = request
): Promise<Extract<OfficePreviewOpenResult, { kind: 'started' }>> => {
  const result = (await invoke(sender, 'open', input)) as OfficePreviewOpenResult
  expect(result.kind).toBe('started')
  if (result.kind !== 'started') throw new Error('Expected a started preview')
  return result
}
const installations: InstalledElectronSurfaceAdapter[] = []
const surfaces = (): ReturnType<typeof createOfficePreviewElectronSurfaces> =>
  createOfficePreviewElectronSurfaces({ previewResources, runtimeHtmlPath })
const install = async (adapters = surfaces()): Promise<void> => {
  for (const adapter of adapters) installations.push(await adapter.install())
}
const uninstall = async (): Promise<void> => {
  for (const installation of installations.splice(0).reverse()) {
    await installation.uninstall()
    await installation.uninstall()
  }
}
const fetchRuntime = (path: string, init?: RequestInit): Promise<Response> => {
  const handler = native.protocols.get(OFFICE_PREVIEW_RUNTIME_SCHEME)
  if (!handler) throw new Error('Runtime protocol is not installed')
  return handler(new Request(`open-science-office-preview://runtime/${path}`, init))
}

beforeEach((): void => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
  native.failAt = undefined
  native.order.length = 0
  previewResources.inspect.mockResolvedValue(snapshot)
  previewResources.acquire.mockResolvedValue(resource)
  native.fetch.mockImplementation(
    async (): Promise<Response> =>
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
  )
})
afterEach(async (): Promise<void> => {
  await uninstall()
  disposeIpcHandlerRegistry()
  ipcMain.removeAllListeners()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  expect(native.handlers.size).toBe(0)
  expect(native.protocols.size).toBe(0)
})

describe('Office preview Electron surfaces', () => {
  it('installs lazily, reads the development URL at install, and forwards only the fetch method', async (): Promise<void> => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:4100')
    const adapters = surfaces()
    expect(adapters.map(({ name }) => name)).toEqual(['office-preview-runtime', 'office-preview'])
    expect(native.order).toEqual([])
    expect(previewResources.inspect).not.toHaveBeenCalled()
    expect(native.fromId).not.toHaveBeenCalled()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:4200')
    await install(adapters)
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:4300')
    const response = await fetchRuntime('@fs/worker.js?worker&url', {
      method: 'HEAD',
      headers: { 'x-private-header': 'must-not-forward' },
      signal: new AbortController().signal
    })
    expect(native.fetch).toHaveBeenCalledExactlyOnceWith(
      'http://localhost:4200/@fs/worker.js?worker&url',
      { method: 'HEAD' }
    )
    expect(await response.text()).toBe('')
    expect(native.order.slice(0, 4)).toEqual([
      `protocol:${OFFICE_PREVIEW_RUNTIME_SCHEME}`,
      'handle:office-preview:open',
      'handle:office-preview:attach-frame',
      'handle:office-preview:close'
    ])
  })

  it.each(['office-preview.html', 'reviewer-paged-preview.html'])(
    'maps the packaged %s page and preserves runtime CSP',
    async (page): Promise<void> => {
      await install()
      const response = await fetchRuntime(`${page}?sessionId=session-1`)
      expect(native.fetch).toHaveBeenCalledExactlyOnceWith(
        pathToFileURL(resolve('test-renderer', page)).toString(),
        { method: 'GET' }
      )
      expect(await response.text()).toBe('<!doctype html>')
      expect(response.headers.get('content-security-policy')).toContain(
        'connect-src open-science-preview:'
      )
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors file:')
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  )

  it.each([
    { source: 'artifact' as const, projectId: 'p', fileId: 'f', versionId: 'v' },
    { source: 'upload' as const, projectId: 'p', fileId: 'f', versionId: 'v' },
    { source: 'artifact' as const, projectId: 'p', fileId: 'f' },
    { source: 'notebook-input' as const, path: resolve('input.xlsx') }
  ])(
    'passes $source identity and the exact inspected snapshot through acquire and close',
    async (source): Promise<void> => {
      await install()
      const sender = owner()
      const input = { ...request, ...source }
      const result = await open(sender, input)
      expect(previewResources.inspect).toHaveBeenCalledExactlyOnceWith(source)
      expect(previewResources.acquire).toHaveBeenCalledExactlyOnceWith(sender.id, source, {
        snapshot,
        maxBytes: OFFICE_PREVIEW_MAX_FILE_BYTES
      })
      expect(previewResources.acquire.mock.calls[0][2]?.snapshot).toBe(snapshot)
      expect(result).toMatchObject({ size: snapshot.size, limit: OFFICE_PREVIEW_MAX_FILE_BYTES })
      const url = new URL(result.runtimeUrl)
      expect(url.protocol).toBe('open-science-office-preview:')
      expect(url.hostname).toBe('runtime')
      expect(url.pathname).toBe('/office-preview.html')
      expect(url.searchParams.get('sessionId')).toBe(result.sessionId)
      // A different sender cannot close this resource.
      await invoke(Object.assign(owner(), { id: 99 }), 'close', result.sessionId)
      expect(previewResources.release).not.toHaveBeenCalled()
      await invoke(sender, 'close', result.sessionId)
      await invoke(sender, 'close', result.sessionId)
      expect(previewResources.release).toHaveBeenCalledExactlyOnceWith(sender.id, {
        resourceId: resource.id
      })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('rejects oversized metadata before acquiring a capability', async (): Promise<void> => {
    previewResources.inspect.mockResolvedValue({
      ...snapshot,
      size: OFFICE_PREVIEW_MAX_FILE_BYTES + 1
    })
    await install()
    await expect(invoke(owner(), 'open', request)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'FILE_TOO_LARGE',
      size: OFFICE_PREVIEW_MAX_FILE_BYTES + 1,
      limit: OFFICE_PREVIEW_MAX_FILE_BYTES
    })
    expect(previewResources.acquire).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('attaches the exact isolated OS process, publishes native state, and enforces memory in bytes', async (): Promise<void> => {
    await install()
    const sender = owner()
    const mainFrame = {
      url: 'file:///app.html',
      osProcessId: 100,
      framesInSubtree: [] as Array<{ url: string; osProcessId: number }>
    }
    native.fromId.mockReturnValue(Object.assign(sender, { mainFrame }))
    const result = await open(sender)
    expect(sender.send).toHaveBeenLastCalledWith('office-preview:state', {
      sessionId: result.sessionId,
      requestId: request.requestId,
      phase: 'starting'
    })
    mainFrame.framesInSubtree.push(
      { url: `${result.runtimeUrl}-stale`, osProcessId: 100 },
      { url: result.runtimeUrl, osProcessId: 200 }
    )
    await expect(invoke(sender, 'attach-frame', result.sessionId)).resolves.toEqual({
      kind: 'attached',
      start: {
        sessionId: result.sessionId,
        resource,
        extension: request.extension,
        name: request.name,
        attempt: request.attempt
      }
    })
    ipcMain.emit('office-preview:report-state', { sender }, result.sessionId, {
      sessionId: result.sessionId,
      phase: 'ready'
    })
    expect(sender.send).toHaveBeenLastCalledWith('office-preview:state', {
      sessionId: result.sessionId,
      requestId: request.requestId,
      phase: 'ready'
    })
    native.getAppMetrics.mockReturnValue([
      { pid: 100, memory: { privateBytes: OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES } },
      {
        pid: 200,
        memory: { privateBytes: 1, workingSetSize: OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES }
      }
    ])
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)
    expect(native.getAppMetrics).toHaveBeenCalledOnce()
    expect(previewResources.release).not.toHaveBeenCalled()
    native.getAppMetrics.mockReturnValue([
      { pid: 200, memory: { privateBytes: OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES / 1024 } }
    ])
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS)
    expect(sender.send).toHaveBeenLastCalledWith('office-preview:state', {
      sessionId: result.sessionId,
      requestId: request.requestId,
      phase: 'error',
      error: 'RESOURCE_LIMIT_EXCEEDED'
    })
    expect(previewResources.release).toHaveBeenCalledExactlyOnceWith(sender.id, {
      resourceId: resource.id
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uninstalls IPC before the protocol and releases an open owner once while preserving unrelated registrations', async (): Promise<void> => {
    ipcMainHandle('external:kept', (): void => {})
    const external = vi.fn()
    ipcMain.on('office-preview:report-state', external)
    await install()
    const sender = owner()
    native.fromId.mockReturnValue(sender)
    const result = await open(sender)
    const navigationListeners = sender.listenerCount('did-start-navigation')
    await uninstall()
    expect(native.order.slice(-4)).toEqual([
      'remove:office-preview:open',
      'remove:office-preview:attach-frame',
      'remove:office-preview:close',
      `unhandle:${OFFICE_PREVIEW_RUNTIME_SCHEME}`
    ])
    expect([...native.handlers.keys()]).toEqual(['external:kept'])
    expect(ipcMain.listeners('office-preview:report-state')).toEqual([external])
    expect(sender.listenerCount('did-start-navigation')).toBe(navigationListeners - 1)
    sender.emit('destroyed')
    ipcMain.emit('office-preview:report-state', { sender }, result.sessionId, {
      sessionId: result.sessionId,
      phase: 'ready'
    })
    expect(external).toHaveBeenCalledOnce()
    expect(sender.send).toHaveBeenCalledOnce()
    expect(previewResources.release).toHaveBeenCalledExactlyOnceWith(sender.id, {
      resourceId: resource.id
    })
    expect(vi.getTimerCount()).toBe(0)
    await install()
    expect(native.handlers.has('office-preview:open')).toBe(true)
  })

  it('invalidates a pending open on uninstall and releases its late acquisition', async (): Promise<void> => {
    let finishAcquire!: (value: typeof resource) => void
    previewResources.acquire.mockReturnValueOnce(
      new Promise((resolve): void => {
        finishAcquire = resolve
      })
    )
    await install()
    const pending = invoke(owner(), 'open', request)
    // inspect has resolved and acquire is now held at the shared owner's boundary.
    await Promise.resolve()
    expect(previewResources.acquire).toHaveBeenCalledOnce()
    await uninstall()
    expect(previewResources.release).not.toHaveBeenCalled()
    finishAcquire(resource)
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
    expect(previewResources.release).toHaveBeenCalledExactlyOnceWith(17, {
      resourceId: resource.id
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([OFFICE_PREVIEW_RUNTIME_SCHEME, 'office-preview:close'])(
    'lets runtime wiring roll back a native installation failure at %s',
    async (channel): Promise<void> => {
      const { installElectronRuntimeAdapters } = await import('../runtime-electron-wiring')
      ipcMainHandle('external:kept', (): void => {})
      const external = vi.fn()
      ipcMain.on('office-preview:report-state', external)
      native.failAt = channel
      await expect(
        installElectronRuntimeAdapters({
          beforeCompute: surfaces(),
          beforeAcp: [],
          afterAcp: [],
          // Office fails before these phases; no unrelated runtime owners are constructed or mocked.
          compute: undefined as never,
          acp: undefined as never
        })
      ).rejects.toThrow(`install failed: ${channel}`)
      expect([...native.handlers.keys()]).toEqual(['external:kept'])
      expect(ipcMain.listeners('office-preview:report-state')).toEqual([external])
      expect(native.protocols.size).toBe(0)
      if (channel === 'office-preview:close') {
        expect(native.order.slice(-3)).toEqual([
          'remove:office-preview:open',
          'remove:office-preview:attach-frame',
          `unhandle:${OFFICE_PREVIEW_RUNTIME_SCHEME}`
        ])
      }
    }
  )
})
