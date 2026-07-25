import type { IpcMainInvokeEvent } from 'electron'

import { describe, expect, it, vi } from 'vitest'

import type { ManagedPreviewResource } from '../shared/preview-resources'
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

describe('managed preview IPC handlers', () => {
  it('releases owner resources once when the renderer process exits', () => {
    const resources = {
      acquire: vi.fn(),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const { event, listeners } = createFakeEvent(42)
    const owners = createManagedPreviewOwnerRegistry(resources)

    expect(owners.register(event as never).ownerId).toBe(42)
    expect(event.sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(event.sender.once).toHaveBeenCalledWith('render-process-gone', expect.any(Function))

    listeners.get('render-process-gone')?.()
    listeners.get('destroyed')?.()
    expect(resources.releaseOwner).toHaveBeenCalledTimes(1)
    expect(resources.releaseOwner).toHaveBeenCalledWith(42)
  })

  it('releases a resource acquired after its owner process has exited', async () => {
    let resolveAcquire: ((resource: ManagedPreviewResource) => void) | undefined
    const resource = {
      id: 'late-resource',
      url: 'open-science-preview://late-resource/report.pdf',
      size: 8,
      mimeType: 'application/pdf',
      version: 1
    }
    const resources = {
      acquire: vi.fn(
        () =>
          new Promise<ManagedPreviewResource>((resolve) => {
            resolveAcquire = resolve
          })
      ),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const { event, listeners } = createFakeEvent(42)
    const owners = createManagedPreviewOwnerRegistry(resources)

    const acquire = owners.acquire(event as never, {
      source: 'artifact',
      path: '/managed/report.pdf'
    })
    listeners.get('render-process-gone')?.()
    resolveAcquire?.(resource)

    await expect(acquire).rejects.toThrow(/owner is no longer available/i)
    expect(resources.release).toHaveBeenCalledWith(42, { resourceId: 'late-resource' })
  })

  it('returns the capability when the owner is still active when the acquire resolves', async () => {
    const resource: ManagedPreviewResource = {
      id: 'fresh-resource',
      url: 'open-science-preview://fresh-resource/report.pdf',
      size: 12,
      mimeType: 'application/pdf',
      version: 1
    }
    const resources = {
      acquire: vi.fn().mockResolvedValue(resource),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const { event } = createFakeEvent(99)
    const owners = createManagedPreviewOwnerRegistry(resources)

    await expect(
      owners.acquire(event as never, { source: 'artifact', path: '/managed/report.pdf' })
    ).resolves.toEqual(resource)
    expect(resources.release).not.toHaveBeenCalled()
  })

  it('reuses the active generation when the same owner is re-registered', () => {
    const resources = {
      acquire: vi.fn(),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const first = createFakeEvent(7)
    const second = createFakeEvent(7)
    const owners = createManagedPreviewOwnerRegistry(resources)

    const ticketA = owners.register(first.event as never)
    const ticketB = owners.register(second.event as never)

    expect(ticketA.generation).toBe(ticketB.generation)
    expect(ticketA.ownerId).toBe(7)
    // Re-registering an already-tracked owner must not attach new lifetime listeners.
    expect(second.event.sender.once).not.toHaveBeenCalled()
  })

  it('increments the generation once a previous owner has been fully released', () => {
    const resources = {
      acquire: vi.fn(),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const owners = createManagedPreviewOwnerRegistry(resources)

    const first = createFakeEvent(11)
    const ticketA = owners.register(first.event as never)
    first.listeners.get('destroyed')?.()

    const second = createFakeEvent(11)
    const ticketB = owners.register(second.event as never)

    expect(ticketB.generation).toBeGreaterThan(ticketA.generation)
    expect(resources.releaseOwner).toHaveBeenCalledTimes(1)
    expect(resources.releaseOwner).toHaveBeenCalledWith(11)
  })

  it('releases owner resources at most once when multiple teardown events fire', () => {
    const resources = {
      acquire: vi.fn(),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const { event, listeners } = createFakeEvent(5)
    const owners = createManagedPreviewOwnerRegistry(resources)
    owners.register(event as never)

    listeners.get('destroyed')?.()
    listeners.get('render-process-gone')?.()
    listeners.get('destroyed')?.()

    expect(resources.releaseOwner).toHaveBeenCalledTimes(1)
  })

  it('ignores late teardown listeners from a stale registration', () => {
    const resources = {
      acquire: vi.fn(),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const owners = createManagedPreviewOwnerRegistry(resources)
    const first = createFakeEvent(13)
    const initialTicket = owners.register(first.event as never)
    // Fire teardown so the active generation entry is cleared.
    first.listeners.get('render-process-gone')?.()

    const replacement = createFakeEvent(13)
    const replacementTicket = owners.register(replacement.event as never)

    expect(replacementTicket.generation).toBeGreaterThan(initialTicket.generation)
    // The original listener must not retroactively revoke the replacement registration.
    first.listeners.get('destroyed')?.()
    expect(resources.releaseOwner).toHaveBeenCalledTimes(1)
    expect(resources.releaseOwner).toHaveBeenCalledWith(13)
  })

  it('propagates backend errors without triggering a late release when the owner has torn down', async () => {
    let rejectAcquire: ((reason: Error) => void) | undefined
    const pendingAcquire = new Promise<ManagedPreviewResource>((_resolve, reject) => {
      rejectAcquire = reject
    })
    const resources = {
      acquire: vi.fn().mockImplementation(() => pendingAcquire),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const { event, listeners } = createFakeEvent(31)
    const owners = createManagedPreviewOwnerRegistry(resources)

    const acquire = owners.acquire(event as never, {
      source: 'artifact',
      path: '/managed/report.pdf'
    })
    // Backend rejects before any resolution: the original error must propagate as-is.
    rejectAcquire?.(new Error('backend exploded'))
    listeners.get('destroyed')?.()

    await expect(acquire).rejects.toThrow('backend exploded')
    // We never resolved a resource, so no idempotent release call is issued either.
    expect(resources.release).not.toHaveBeenCalled()
    expect(resources.releaseOwner).toHaveBeenCalledTimes(1)
  })

  it('wires ipcMain handlers with owner-scoped acquire, readRange, and release', async () => {
    handlers.clear()
    const resource: ManagedPreviewResource = {
      id: 'wired-resource',
      url: 'open-science-preview://wired-resource/report.html',
      size: 4,
      mimeType: 'text/html; charset=utf-8',
      version: 1
    }
    const rangeResult = {
      begin: 0,
      end: 1,
      total: 4,
      data: new Uint8Array([104, 105])
    }
    const resources = {
      acquire: vi.fn().mockResolvedValue(resource),
      readRange: vi.fn().mockResolvedValue(rangeResult),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources

    registerManagedPreviewIpcHandlers(resources)

    expect(handlers.has('preview-resources:acquire')).toBe(true)
    expect(handlers.has('preview-resources:read-range')).toBe(true)
    expect(handlers.has('preview-resources:release')).toBe(true)

    const { event: acquireEvent, listeners: acquireListeners } = createFakeEvent(91)
    const acquireHandler = handlers.get('preview-resources:acquire') as (
      event: unknown,
      payload: unknown
    ) => Promise<ManagedPreviewResource>
    await expect(
      acquireHandler(acquireEvent, { source: 'artifact', path: '/managed/report.html' })
    ).resolves.toEqual(resource)
    expect(resources.acquire).toHaveBeenCalledWith(91, {
      source: 'artifact',
      path: '/managed/report.html'
    })

    const { event: readEvent } = createFakeEvent(92)
    const readHandler = handlers.get('preview-resources:read-range') as (
      event: unknown,
      payload: unknown
    ) => Promise<unknown>
    await readHandler(readEvent, { resourceId: 'wired-resource', begin: 0, end: 1 })
    expect(resources.readRange).toHaveBeenCalledWith(92, {
      resourceId: 'wired-resource',
      begin: 0,
      end: 1
    })

    const { event: releaseEvent } = createFakeEvent(93)
    const releaseHandler = handlers.get('preview-resources:release') as (
      event: unknown,
      payload: unknown
    ) => unknown
    releaseHandler(releaseEvent, { resourceId: 'wired-resource' })
    expect(resources.release).toHaveBeenCalledWith(93, { resourceId: 'wired-resource' })

    // Releasing the ipcMain-registered acquire owner must trigger a single releaseOwner call.
    acquireListeners.get('render-process-gone')?.()
    expect(resources.releaseOwner).toHaveBeenCalledTimes(1)
    expect(resources.releaseOwner).toHaveBeenCalledWith(91)
  })
})
