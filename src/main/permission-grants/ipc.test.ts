import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))

import type { PermissionGrantRegistry } from './registry'
import { webRpc } from '../ipc-handler-registry'
import { registerPermissionGrantIpcHandlers } from './ipc'

beforeEach(() => handlers.clear())

describe('permission grant IPC', () => {
  it('projects Session-scoped grants from cached metadata without loading Session storage', async () => {
    const loadAll = vi.fn().mockRejectedValue(new Error('full Session load must not run'))
    const metadataSnapshot = vi.fn().mockResolvedValue({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Cached session' }],
      isComplete: true
    })
    const sessions = { metadataSnapshot, loadAll }
    const registry = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'grant-1',
          revision: 1,
          capability: { kind: 'file_operation', key: 'file:read' },
          scope: { kind: 'session', projectId: 'project-1', sessionId: 'session-1' }
        }
      ]),
      subscribe: vi.fn(() => () => undefined)
    } as unknown as PermissionGrantRegistry
    registerPermissionGrantIpcHandlers({
      registry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions
    })

    await expect(handlers.get('permissions:list')?.(undefined)).resolves.toMatchObject({
      incompleteStores: [],
      grants: [{ scopeLabel: 'Session: Cached session' }]
    })
    expect(metadataSnapshot).toHaveBeenCalledOnce()
    expect(loadAll).not.toHaveBeenCalled()
  })

  it('registers list, revision-aware revoke, restore, and change notification', async () => {
    let listener: (() => void) | undefined
    const registry = {
      list: vi.fn().mockResolvedValue([]),
      revoke: vi.fn().mockResolvedValue({ grants: [], conflicts: [] }),
      extendUndo: vi.fn().mockResolvedValue({
        undoToken: 'undo-1',
        expiresAt: 10,
        revokedCount: 1
      }),
      restore: vi.fn().mockResolvedValue({ grants: [], conflicts: [] }),
      subscribe: vi.fn((next: () => void) => {
        listener = next
        return () => undefined
      })
    } as unknown as PermissionGrantRegistry
    const broadcast = vi.fn()
    const controller = registerPermissionGrantIpcHandlers({
      registry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      broadcast
    })

    expect([...handlers.keys()]).toEqual([
      'permissions:list',
      'permissions:revoke',
      'permissions:extend-undo',
      'permissions:restore'
    ])
    expect(webRpc.channels()).toEqual(
      expect.arrayContaining([
        'permissions:list',
        'permissions:revoke',
        'permissions:extend-undo',
        'permissions:restore'
      ])
    )
    await handlers.get('permissions:revoke')?.(undefined, {
      grants: [{ id: 'grant-1', revision: 2 }]
    })
    await handlers.get('permissions:extend-undo')?.(undefined, { undoToken: 'undo-1' })
    await handlers.get('permissions:restore')?.(undefined, { undoToken: 'undo-1' })
    expect(registry.revoke).toHaveBeenCalledWith({ grants: [{ id: 'grant-1', revision: 2 }] })
    expect(registry.extendUndo).toHaveBeenCalledWith({ undoToken: 'undo-1' })
    expect(registry.restore).toHaveBeenCalledWith({ undoToken: 'undo-1' })

    controller.invalidateProjection()
    expect(broadcast).toHaveBeenCalledWith('permissions:changed', { revision: 1 })

    listener?.()
    expect(broadcast).toHaveBeenLastCalledWith('permissions:changed', { revision: 2 })
  })

  it('owns one Registry subscription and releases that subscription on disposal', () => {
    const unsubscribe = vi.fn()
    const registry = {
      subscribe: vi.fn(() => unsubscribe)
    } as unknown as PermissionGrantRegistry
    const broadcast = vi.fn()

    const controller = registerPermissionGrantIpcHandlers({
      registry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      broadcast
    })

    expect(registry.subscribe).toHaveBeenCalledOnce()
    controller.invalidateProjection()
    expect(broadcast).toHaveBeenCalledOnce()
    expect(broadcast).toHaveBeenCalledWith('permissions:changed', { revision: 1 })

    controller.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('rejects an empty revoke request at the IPC boundary', async () => {
    const registry = {
      subscribe: vi.fn(() => () => undefined)
    } as unknown as PermissionGrantRegistry
    registerPermissionGrantIpcHandlers({
      registry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) }
    })

    await expect(handlers.get('permissions:revoke')?.(undefined, { grants: [] })).rejects.toThrow(
      'Select at least one permission grant'
    )
  })

  it('versions snapshots and reports partial metadata stores without hiding grants', async () => {
    let listener: (() => void) | undefined
    const registry = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'grant-1',
          revision: 1,
          capability: { kind: 'file_operation', key: 'file:read' },
          scope: { kind: 'global' }
        }
      ]),
      subscribe: vi.fn((next: () => void) => {
        listener = next
        return () => undefined
      })
    } as unknown as PermissionGrantRegistry
    registerPermissionGrantIpcHandlers({
      registry,
      projects: { list: vi.fn().mockRejectedValue(new Error('project store unavailable')) },
      sessions: {
        metadataSnapshot: vi.fn(() => {
          throw new Error('Session metadata unavailable')
        })
      },
      connectors: { get: vi.fn().mockRejectedValue(new Error('settings unavailable')) },
      broadcast: vi.fn()
    })

    listener?.()
    await expect(handlers.get('permissions:list')?.(undefined)).resolves.toMatchObject({
      version: 1,
      incompleteStores: ['projects', 'sessions', 'connector_policy'],
      counts: { all: 1 }
    })
  })
})
