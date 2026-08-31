import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, registrationFailure } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  registrationFailure: {
    channel: undefined as string | undefined,
    error: undefined as Error | undefined
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      if (registrationFailure.channel === channel) {
        throw registrationFailure.error ?? new Error('registration failed')
      }
      handlers.set(channel, handler)
    }
  }
}))

import type { PermissionGrantRegistry } from './registry'
import {
  createApplicationCommandRouter,
  type ApplicationCallerLease,
  type ApplicationInvocation
} from '../application-command-router'
import { createWebCallerContext } from '../caller-context'
import {
  permissionGrantApplicationCommands,
  registerPermissionGrantApplicationCommands
} from './application-commands'
import { registerPermissionGrantIpcAdapter, registerPermissionGrantIpcHandlers } from './ipc'
import { createPermissionGrantProjectionController } from './projection-controller'

const invocation = <Args extends readonly unknown[]>(args: Args): ApplicationInvocation<Args> => {
  const callerContext = createWebCallerContext('remote-web', { location: 'remote' })
  const callerLease: ApplicationCallerLease = Object.freeze({
    leaseId: callerContext.leaseId,
    generation: 1,
    signal: new AbortController().signal,
    isCurrent: () => true
  })
  return Object.freeze({ args, callerContext, callerLease })
}

beforeEach(() => {
  handlers.clear()
  registrationFailure.channel = undefined
  registrationFailure.error = undefined
})

describe('permission grant IPC', () => {
  it('shares one application-owned projection between IPC and application commands', async () => {
    const registry = {
      list: vi.fn().mockResolvedValue([]),
      subscribe: vi.fn(() => vi.fn())
    } as unknown as PermissionGrantRegistry
    const owner = createPermissionGrantProjectionController({
      registry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      publishChanged: vi.fn()
    })
    registerPermissionGrantIpcAdapter(owner)
    const router = createApplicationCommandRouter()
    registerPermissionGrantApplicationCommands(router.registrar, owner)

    await expect(handlers.get('permissions:list')?.(undefined)).resolves.toMatchObject({
      version: 0
    })
    await expect(
      router.dispatcher.invoke(permissionGrantApplicationCommands.list, invocation([]))
    ).resolves.toMatchObject({ version: 0 })
    expect(registry.subscribe).toHaveBeenCalledOnce()
  })

  it('releases the compatibility owner when IPC registration fails', () => {
    const unsubscribe = vi.fn()
    const registry = {
      subscribe: vi.fn(() => unsubscribe)
    } as unknown as PermissionGrantRegistry
    registrationFailure.channel = 'permissions:restore-defaults'

    expect(() =>
      registerPermissionGrantIpcHandlers({
        registry,
        projects: { list: vi.fn().mockResolvedValue([]) },
        sessions: {
          metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true })
        },
        broadcast: vi.fn()
      })
    ).toThrow('registration failed')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('retains registration and disposal failures when rollback also fails', () => {
    const registrationError = new Error('registration failed')
    const disposalError = new Error('unsubscribe failed')
    const registry = {
      subscribe: vi.fn(() => () => {
        throw disposalError
      })
    } as unknown as PermissionGrantRegistry
    registrationFailure.channel = 'permissions:restore-defaults'
    registrationFailure.error = registrationError
    let thrown: unknown

    try {
      registerPermissionGrantIpcHandlers({
        registry,
        projects: { list: vi.fn().mockResolvedValue([]) },
        sessions: {
          metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true })
        },
        broadcast: vi.fn()
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toEqual([registrationError, disposalError])
  })

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
      remember: vi.fn(),
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
      'permissions:restore-defaults',
      'permissions:revoke',
      'permissions:extend-undo',
      'permissions:restore'
    ])
    await handlers.get('permissions:restore-defaults')?.(undefined)
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
