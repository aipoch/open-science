import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedPreviewResources } from '../managed-preview-resources'
import { registerOfficePreviewIpcHandlers } from './office-preview-ipc'
import { OfficePreviewSupervisor } from './office-preview-supervisor'
import type { ManagedFileReadLease } from '../managed-file-versions/service'
import type { OfficePreviewOpenRequest, OfficePreviewOpenResult } from '../../shared/office-preview'
import type { ManagedPreviewResource } from '../../shared/preview-resources'
type OpenHandler = (
  event: { sender: EventEmitter & { id: number } },
  request: OfficePreviewOpenRequest
) => Promise<OfficePreviewOpenResult>
const ipc = vi.hoisted(() => ({ handlers: new Map<string, OpenHandler>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: OpenHandler) => ipc.handlers.set(name, handler),
    on: () => {}
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn(), unhandle: vi.fn() }
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  diagnosticErrorFields: () => ({})
}))
const deferred = <T>(): { resolve: (value: T) => void; promise: Promise<T> } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { resolve, promise }
}
const request = { source: 'artifact' as const, projectId: 'p', fileId: 'f' }
let senderId = 100
const sender = (): EventEmitter & { id: number } =>
  Object.assign(new EventEmitter(), { id: ++senderId })
const setup = (
  size = 4
): {
  resources: ManagedPreviewResources
  lease: ManagedFileReadLease
  close: ReturnType<typeof vi.fn<() => Promise<void>>>
} => {
  const close = vi.fn(async () => {})
  const makeLease = (): ManagedFileReadLease => {
    let closed = false
    const assertOpen = (): void => {
      if (closed) throw new Error('lease is closed')
    }
    // The resource owner consumes only byte-lease operations; version catalog metadata is outside this boundary.
    return {
      path: '/managed/document.docx',
      size,
      versionToken: 1,
      snapshot: { dev: 1n, ino: 2n, size: BigInt(size), mtimeNs: 1n },
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number) => {
        assertOpen()
        buffer.fill(65, offset, offset + length)
        return { bytesRead: length }
      }),
      readRange: vi.fn(async (begin: number, end: number) => {
        assertOpen()
        return Buffer.alloc(end - begin, 65)
      }),
      verifyUnchanged: vi.fn(async () => assertOpen()),
      close: async () => {
        if (closed) return
        closed = true
        await close()
      }
    } as unknown as ManagedFileReadLease
  }
  const lease = makeLease()
  let id = 0
  const resources = new ManagedPreviewResources({
    resolvePath: async () => {
      throw new Error('unused')
    },
    openLatestManagedFile: async () => makeLease(),
    createId: () => `r-${++id}`
  })
  return { resources, lease, close }
}
afterEach(() => {
  vi.useRealTimers()
  ipc.handlers.clear()
})
describe('Office host navigation', () => {
  const office = (
    size = 4
  ): ReturnType<typeof setup> & {
    supervisor: OfficePreviewSupervisor
    publish: ReturnType<typeof vi.fn>
    acquired: ManagedPreviewResource[]
  } => {
    const env = setup(size)
    let session = 0
    const publish = vi.fn()
    const acquired: ManagedPreviewResource[] = []
    const supervisor = new OfficePreviewSupervisor({
      inspectResource: () => env.resources.inspect(request),
      acquireResource: async (owner, _req, snapshot, maxBytes) => {
        const r = await env.resources.acquire(owner, request, { snapshot, maxBytes })
        acquired.push(r)
        return r
      },
      releaseResource: (owner, id) => env.resources.release(owner, { resourceId: id }),
      createSessionId: () => `session-${++session}`,
      createRuntimeUrl: (id) => `open-science-office-preview://runtime/${id}`,
      resolveFrameProcess: () => undefined,
      publishState: publish
    })
    registerOfficePreviewIpcHandlers(supervisor)
    return { ...env, supervisor, publish, acquired }
  }
  it.each([false, true])(
    'Office navigation immediately closes an unattached session (retry=%s)',
    async (retry) => {
      vi.useFakeTimers()
      const env = office(25 * 1024 * 1024)
      const s = sender()
      const result = await ipc.handlers.get('office-preview:open')!(
        { sender: s },
        {
          ...request,
          requestId: 'old',
          name: 'document.docx',
          extension: 'docx',
          attempt: retry ? 1 : 0
        }
      )
      expect(result.kind).toBe('started')
      expect(env.close).toHaveBeenCalledOnce()
      env.close.mockClear()
      s.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      await Promise.resolve()
      expect(env.close).toHaveBeenCalledOnce()
      await expect(env.resources.resolveProtocolResource(env.acquired[0].id)).rejects.toThrow(
        'not available'
      )
      s.emit('destroyed')
    }
  )
  it.each(['navigation', 'destroyed'])(
    'Office acquisition finishing after %s has the documented lifecycle outcome',
    async (eventName) => {
      vi.useFakeTimers()
      const env = office()
      const s = sender()
      const gate = deferred<void>()
      const original = env.resources.inspect.bind(env.resources)
      vi.spyOn(env.resources, 'inspect').mockImplementation(async (r) => {
        await gate.promise
        return original(r)
      })
      const pending = ipc.handlers.get('office-preview:open')!(
        { sender: s },
        { ...request, requestId: 'old', name: 'document.docx', extension: 'docx', attempt: 0 }
      )
      if (eventName === 'navigation')
        s.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      else s.emit('destroyed')
      gate.resolve()
      const result = await pending
      expect(result).toEqual({ kind: 'cancelled' })
      expect(env.acquired).toHaveLength(0)
      s.emit('destroyed')
    }
  )
  it('keeps same-document and subframe navigation alive and retracks a replaced document', async () => {
    const env = office()
    const s = sender()
    const open = (): Promise<OfficePreviewOpenResult> =>
      ipc.handlers.get('office-preview:open')!(
        { sender: s },
        { ...request, requestId: 'current', name: 'document.docx', extension: 'docx', attempt: 0 }
      )
    await open()
    const events = ['did-start-navigation', 'destroyed', 'render-process-gone']
    const listenerCounts = events.map((event) => s.listenerCount(event))
    env.close.mockClear()
    s.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    s.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(env.close).not.toHaveBeenCalled()
    s.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await Promise.resolve()
    expect(env.close).toHaveBeenCalledOnce()
    expect(s.listenerCount('did-start-navigation')).toBe(0)
    await open()
    expect(events.map((event) => s.listenerCount(event))).toEqual(listenerCounts)
    env.close.mockClear()
    s.emit('destroyed')
    await Promise.resolve()
    expect(env.close).toHaveBeenCalledOnce()
    expect(s.listenerCount('did-start-navigation')).toBe(0)
  })
})
