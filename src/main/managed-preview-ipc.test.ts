import type { IpcMainInvokeEvent } from 'electron'

import { describe, expect, it, vi } from 'vitest'

import type { ManagedPreviewResource } from '../shared/preview-resources'
import { createElectronCallerContext, createWebCallerContext } from './caller-context'
import { ApplicationCallerLeaseRegistry } from './caller-lifecycle'
import type { ManagedPreviewResources } from './managed-preview-resources'
import {
  createManagedPreviewOwnerRegistry,
  registerManagedPreviewIpcHandlers
} from './managed-preview-ipc'

// Vitest hoists vi.mock(...) above the rest of the module body, so anything the factory closes over
// has to exist before the factory runs. vi.hoisted guarantees that.
const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const createFakeEvent = (
  senderId: number
): { event: IpcMainInvokeEvent; listeners: Map<string, () => void> } => {
  const listeners = new Map<string, () => void>()
  const event = {
    sender: {
      id: senderId,
      once: vi.fn((name: string, listener: () => void) => listeners.set(name, listener))
    }
  }
  return {
    event: event as unknown as IpcMainInvokeEvent,
    listeners
  }
}

const previewResource = (id: string): ManagedPreviewResource => ({
  id,
  url: `open-science-preview://${id}/report.pdf`,
  size: 8,
  mimeType: 'application/pdf',
  version: 1
})

const createResources = (
  overrides: Partial<ManagedPreviewResources> = {}
): ManagedPreviewResources =>
  ({
    acquire: vi.fn(),
    readRange: vi.fn(),
    release: vi.fn(),
    releaseOwner: vi.fn(),
    ...overrides
  }) as unknown as ManagedPreviewResources

describe('managed preview IPC handlers', () => {
  it('uses an opaque negative owner scoped to the caller lease', () => {
    const resources = createResources()
    const lifecycle = new ApplicationCallerLeaseRegistry()
    const caller = lifecycle.acquire(createElectronCallerContext(42))
    const owners = createManagedPreviewOwnerRegistry(resources)

    const ticket = owners.register(caller.lease)
    expect(ticket.ownerId).toBeLessThan(0)

    caller.release()
    caller.release()
    expect(resources.releaseOwner).toHaveBeenCalledOnce()
    expect(resources.releaseOwner).toHaveBeenCalledWith(ticket.ownerId)
  })

  it('releases a resource acquired after its caller lease ends', async () => {
    let resolveAcquire: ((resource: ManagedPreviewResource) => void) | undefined
    const resource = previewResource('late-resource')
    const resources = createResources({
      acquire: vi.fn(
        () =>
          new Promise<ManagedPreviewResource>((resolve) => {
            resolveAcquire = resolve
          })
      )
    })
    const lifecycle = new ApplicationCallerLeaseRegistry()
    const caller = lifecycle.acquire(createElectronCallerContext(42))
    const owners = createManagedPreviewOwnerRegistry(resources)

    const acquire = owners.acquire(caller.lease, {
      source: 'artifact',
      path: '/managed/report.pdf'
    })
    const ownerId = (resources.acquire as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as number
    caller.release()
    resolveAcquire?.(resource)

    await expect(acquire).rejects.toThrow(/owner is no longer available/i)
    expect(resources.release).toHaveBeenCalledWith(ownerId, { resourceId: 'late-resource' })
  })

  it('returns the capability while the caller lease is current', async () => {
    const resource = previewResource('fresh-resource')
    const resources = createResources({ acquire: vi.fn().mockResolvedValue(resource) })
    const lifecycle = new ApplicationCallerLeaseRegistry()
    const caller = lifecycle.acquire(createElectronCallerContext(99))
    const owners = createManagedPreviewOwnerRegistry(resources)

    await expect(
      owners.acquire(caller.lease, { source: 'artifact', path: '/managed/report.pdf' })
    ).resolves.toEqual(resource)
    expect(resources.release).not.toHaveBeenCalled()
  })

  it('reuses one preview owner for the same active caller generation', () => {
    const resources = createResources()
    const lifecycle = new ApplicationCallerLeaseRegistry()
    const caller = lifecycle.acquire(createElectronCallerContext(7))
    const owners = createManagedPreviewOwnerRegistry(resources)

    const ticketA = owners.register(caller.lease)
    const ticketB = owners.register(caller.lease)

    expect(ticketB).toBe(ticketA)
    expect(resources.releaseOwner).not.toHaveBeenCalled()
  })

  it('keeps preview owners distinct when public lease ids collide across surfaces', () => {
    const resources = createResources()
    const lifecycle = new ApplicationCallerLeaseRegistry()
    const owners = createManagedPreviewOwnerRegistry(resources)
    const electron = lifecycle.acquire(createElectronCallerContext(7))
    const web = lifecycle.acquire(createWebCallerContext('electron:7'))

    const electronTicket = owners.register(electron.lease)
    const webTicket = owners.register(web.lease)

    expect(webTicket.ownerId).not.toBe(electronTicket.ownerId)
    expect(owners.register(electron.lease)).toBe(electronTicket)
    expect(resources.releaseOwner).not.toHaveBeenCalled()
  })

  it('isolates a replacement generation from a stale release', () => {
    const resources = createResources()
    const lifecycle = new ApplicationCallerLeaseRegistry()
    const owners = createManagedPreviewOwnerRegistry(resources)
    const context = createElectronCallerContext(13)
    const first = lifecycle.acquire(context)
    const initialTicket = owners.register(first.lease)

    const replacement = lifecycle.acquire(context)
    const replacementTicket = owners.register(replacement.lease)
    first.release()

    expect(replacementTicket.generation).toBeGreaterThan(initialTicket.generation)
    expect(replacementTicket.ownerId).not.toBe(initialTicket.ownerId)
    expect(resources.releaseOwner).toHaveBeenCalledOnce()
    expect(resources.releaseOwner).toHaveBeenCalledWith(initialTicket.ownerId)

    expect(() => owners.register(first.lease)).toThrow(/owner is no longer available/i)
    expect(owners.register(replacement.lease)).toBe(replacementTicket)
    expect(resources.releaseOwner).toHaveBeenCalledOnce()

    replacement.release()
    expect(resources.releaseOwner).toHaveBeenLastCalledWith(replacementTicket.ownerId)
  })

  it('propagates backend errors after the caller lease ends without releasing a nonexistent resource', async () => {
    let rejectAcquire: ((reason: Error) => void) | undefined
    const pendingAcquire = new Promise<ManagedPreviewResource>((_resolve, reject) => {
      rejectAcquire = reject
    })
    const resources = createResources({ acquire: vi.fn().mockImplementation(() => pendingAcquire) })
    const lifecycle = new ApplicationCallerLeaseRegistry()
    const caller = lifecycle.acquire(createElectronCallerContext(31))
    const owners = createManagedPreviewOwnerRegistry(resources)

    const acquire = owners.acquire(caller.lease, {
      source: 'artifact',
      path: '/managed/report.pdf'
    })
    rejectAcquire?.(new Error('backend exploded'))
    caller.release()

    await expect(acquire).rejects.toThrow('backend exploded')
    expect(resources.release).not.toHaveBeenCalled()
    expect(resources.releaseOwner).toHaveBeenCalledOnce()
  })

  it('wires acquire, read, and release to one lease-owned preview handle', async () => {
    handlers.clear()
    const resource = previewResource('wired-resource')
    const rangeResult = {
      begin: 0,
      end: 1,
      total: 4,
      data: new Uint8Array([104, 105])
    }
    const resources = createResources({
      acquire: vi.fn().mockResolvedValue(resource),
      readRange: vi.fn().mockResolvedValue(rangeResult)
    })
    registerManagedPreviewIpcHandlers(resources)

    const { event, listeners } = createFakeEvent(91)
    const acquireHandler = handlers.get('preview-resources:acquire') as (
      event: unknown,
      payload: unknown
    ) => Promise<ManagedPreviewResource>
    await expect(
      acquireHandler(event, { source: 'artifact', path: '/managed/report.html' })
    ).resolves.toEqual(resource)
    const ownerId = (resources.acquire as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as number
    expect(ownerId).toBeLessThan(0)

    const readHandler = handlers.get('preview-resources:read-range') as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>
    await readHandler(event, { resourceId: 'wired-resource', begin: 0, end: 1 })
    expect(resources.readRange).toHaveBeenCalledWith(ownerId, {
      resourceId: 'wired-resource',
      begin: 0,
      end: 1
    })

    const releaseHandler = handlers.get('preview-resources:release') as (
      event: unknown,
      payload: unknown
    ) => unknown
    releaseHandler(event, { resourceId: 'wired-resource' })
    expect(resources.release).toHaveBeenCalledWith(ownerId, { resourceId: 'wired-resource' })

    listeners.get('render-process-gone')?.()
    listeners.get('destroyed')?.()
    expect(resources.releaseOwner).toHaveBeenCalledOnce()
    expect(resources.releaseOwner).toHaveBeenCalledWith(ownerId)
  })

  it('assigns distinct preview owners to distinct callers', async () => {
    handlers.clear()
    const resources = createResources({
      readRange: vi.fn().mockResolvedValue({ begin: 0, end: 0, total: 1, data: new Uint8Array() })
    })
    registerManagedPreviewIpcHandlers(resources)
    const readHandler = handlers.get('preview-resources:read-range') as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>

    await readHandler(createFakeEvent(92).event, { resourceId: 'resource', begin: 0, end: 0 })
    await readHandler(createFakeEvent(93).event, { resourceId: 'resource', begin: 0, end: 0 })

    const [firstOwner] = (resources.readRange as ReturnType<typeof vi.fn>).mock.calls[0] as [number]
    const [secondOwner] = (resources.readRange as ReturnType<typeof vi.fn>).mock.calls[1] as [
      number
    ]
    expect(firstOwner).toBeLessThan(0)
    expect(secondOwner).toBeLessThan(0)
    expect(secondOwner).not.toBe(firstOwner)
  })

  it('uses a strict inspected snapshot when acquire specifies a byte limit', async () => {
    handlers.clear()
    const resource = previewResource('strict-resource')
    const snapshot = { size: 128, version: 7, dev: 8n, ino: 9n, mtimeNs: 7_000_000n }
    const resources = createResources({
      inspect: vi.fn().mockResolvedValue(snapshot),
      acquire: vi.fn().mockResolvedValue(resource)
    })
    registerManagedPreviewIpcHandlers(resources)
    const { event } = createFakeEvent(101)
    const acquireHandler = handlers.get('preview-resources:acquire') as (
      event: unknown,
      payload: unknown
    ) => Promise<ManagedPreviewResource>

    await expect(
      acquireHandler(event, {
        source: 'artifact',
        path: '/managed/chart.tiff',
        mimeType: 'image/tiff',
        maxBytes: 40 * 1024 * 1024
      })
    ).resolves.toEqual(resource)

    const request = {
      source: 'artifact' as const,
      path: '/managed/chart.tiff',
      mimeType: 'image/tiff'
    }
    const ownerId = (resources.acquire as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as number
    expect(resources.inspect).toHaveBeenCalledWith(request)
    expect(resources.acquire).toHaveBeenCalledWith(ownerId, request, {
      snapshot,
      maxBytes: 40 * 1024 * 1024
    })
  })

  it('rejects an invalid strict byte limit before inspecting the file', async () => {
    handlers.clear()
    const resources = createResources({ inspect: vi.fn() })
    registerManagedPreviewIpcHandlers(resources)
    const { event } = createFakeEvent(102)
    const acquireHandler = handlers.get('preview-resources:acquire') as (
      event: unknown,
      payload: unknown
    ) => Promise<ManagedPreviewResource>

    await expect(
      acquireHandler(event, {
        source: 'artifact',
        path: '/managed/chart.tiff',
        maxBytes: Number.POSITIVE_INFINITY
      })
    ).rejects.toThrow('Invalid managed preview byte limit')
    expect(resources.inspect).not.toHaveBeenCalled()
    expect(resources.acquire).not.toHaveBeenCalled()
  })
})
