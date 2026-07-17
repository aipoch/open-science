import { describe, expect, it, vi } from 'vitest'

import type { ManagedPreviewResource } from '../shared/preview-resources'
import type { ManagedPreviewResources } from './managed-preview-resources'
import { createManagedPreviewOwnerRegistry } from './managed-preview-ipc'

describe('managed preview IPC handlers', () => {
  it('releases owner resources once when the renderer process exits', () => {
    const resources = {
      acquire: vi.fn(),
      readRange: vi.fn(),
      release: vi.fn(),
      releaseOwner: vi.fn()
    } as unknown as ManagedPreviewResources
    const listeners = new Map<string, () => void>()
    const event = {
      sender: {
        id: 42,
        once: vi.fn((name: string, listener: () => void) => listeners.set(name, listener))
      }
    }
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
    const listeners = new Map<string, () => void>()
    const event = {
      sender: {
        id: 42,
        once: vi.fn((name: string, listener: () => void) => listeners.set(name, listener))
      }
    }
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
})
