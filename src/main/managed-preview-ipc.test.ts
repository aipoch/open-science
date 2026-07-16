import { describe, expect, it, vi } from 'vitest'

import type { ManagedPreviewResource } from '../shared/preview-resources'
import type { ManagedPreviewResources } from './managed-preview-resources'
import {
  createManagedPreviewHandlers,
  createManagedPreviewOwnerRegistry
} from './managed-preview-ipc'

describe('managed preview IPC handlers', () => {
  it('binds acquire, range reads, and release to the sender owner', async () => {
    const resource = {
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.pdf',
      size: 8,
      mimeType: 'application/pdf',
      version: 1
    }
    const range = {
      begin: 0,
      end: 4,
      total: 8,
      data: new Uint8Array([1, 2, 3, 4])
    }
    const resources = {
      acquire: vi.fn().mockResolvedValue(resource),
      readRange: vi.fn().mockResolvedValue(range),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const handlers = createManagedPreviewHandlers(resources)

    await expect(
      handlers.acquire(42, { source: 'artifact', path: '/managed/report.pdf' })
    ).resolves.toEqual(resource)
    await expect(
      handlers.readRange(42, { resourceId: 'resource-1', begin: 0, end: 4 })
    ).resolves.toEqual(range)
    handlers.release(42, { resourceId: 'resource-1' })
    handlers.releaseOwner(42)

    expect(resources.acquire).toHaveBeenCalledWith(42, {
      source: 'artifact',
      path: '/managed/report.pdf'
    })
    expect(resources.readRange).toHaveBeenCalledWith(42, {
      resourceId: 'resource-1',
      begin: 0,
      end: 4
    })
    expect(resources.release).toHaveBeenCalledWith(42, { resourceId: 'resource-1' })
    expect(resources.releaseOwner).toHaveBeenCalledWith(42)
  })

  it('releases owner resources once when the renderer process exits', () => {
    const resources = {
      acquire: vi.fn(),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const handlers = createManagedPreviewHandlers(resources)
    const listeners = new Map<string, () => void>()
    const event = {
      sender: {
        id: 42,
        once: vi.fn((name: string, listener: () => void) => listeners.set(name, listener))
      }
    }
    const owners = createManagedPreviewOwnerRegistry(handlers)

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
    const handlers = createManagedPreviewHandlers(resources)
    const listeners = new Map<string, () => void>()
    const event = {
      sender: {
        id: 42,
        once: vi.fn((name: string, listener: () => void) => listeners.set(name, listener))
      }
    }
    const owners = createManagedPreviewOwnerRegistry(handlers)

    const acquire = owners.acquire(event as never, {
      source: 'artifact',
      path: '/managed/report.pdf'
    })
    listeners.get('render-process-gone')?.()
    resolveAcquire?.(resource)

    await expect(acquire).rejects.toThrow(/owner is no longer available/i)
    expect(resources.release).toHaveBeenCalledWith(42, { resourceId: 'late-resource' })
  })
})
