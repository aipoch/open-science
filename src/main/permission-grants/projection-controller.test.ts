import { describe, expect, it, vi } from 'vitest'

import type { PermissionGrantRegistry } from './registry'
import { createPermissionGrantProjectionController } from './projection-controller'

describe('Permission Grant projection controller', () => {
  it('owns one Registry subscription and versions projections before publishing changes', async () => {
    let registryChanged: (() => void) | undefined
    const registry = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'grant-1',
          revision: 1,
          capability: { kind: 'file_operation', key: 'file:read' },
          scope: { kind: 'global' }
        }
      ]),
      subscribe: vi.fn((listener: () => void) => {
        registryChanged = listener
        return vi.fn()
      })
    } as unknown as PermissionGrantRegistry
    const publishChanged = vi.fn()
    const controller = createPermissionGrantProjectionController({
      registry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      publishChanged
    })

    expect(registry.subscribe).toHaveBeenCalledOnce()
    await expect(controller.list()).resolves.toMatchObject({ version: 0, counts: { all: 1 } })

    registryChanged?.()

    expect(publishChanged).toHaveBeenCalledWith({ revision: 1 })
    await expect(controller.list()).resolves.toMatchObject({ version: 1, counts: { all: 1 } })
  })

  it('restarts projection when metadata is invalidated during an in-flight read', async () => {
    let registryChanged: (() => void) | undefined
    let resolveFirstProjects: ((projects: Array<{ id: string; name: string }>) => void) | undefined
    const firstProjects = new Promise<Array<{ id: string; name: string }>>((resolve) => {
      resolveFirstProjects = resolve
    })
    const projects = {
      list: vi
        .fn()
        .mockImplementationOnce(() => firstProjects)
        .mockResolvedValue([{ id: 'project-1', name: 'Current project' }])
    }
    const registry = {
      list: vi.fn().mockResolvedValue([
        {
          id: 'grant-1',
          revision: 1,
          capability: { kind: 'file_operation', key: 'file:read' },
          scope: { kind: 'project', projectId: 'project-1' }
        }
      ]),
      subscribe: vi.fn((listener: () => void) => {
        registryChanged = listener
        return vi.fn()
      })
    } as unknown as PermissionGrantRegistry
    const controller = createPermissionGrantProjectionController({
      registry,
      projects,
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      publishChanged: vi.fn()
    })

    const projection = controller.list()
    registryChanged?.()
    resolveFirstProjects?.([{ id: 'project-1', name: 'Stale project' }])

    await expect(projection).resolves.toMatchObject({
      version: 1,
      grants: [{ scopeLabel: 'Project: Current project' }]
    })
    expect(projects.list).toHaveBeenCalledTimes(2)
  })

  it('returns a refreshed mutation projection at the Registry change revision', async () => {
    let registryChanged: (() => void) | undefined
    const revoke = vi.fn(async () => {
      registryChanged?.()
      return {
        grants: [],
        conflicts: [],
        receipt: { undoToken: 'undo-1', expiresAt: 10, revokedCount: 1 }
      }
    })
    const registry = {
      list: vi.fn().mockResolvedValue([]),
      revoke,
      subscribe: vi.fn((listener: () => void) => {
        registryChanged = listener
        return vi.fn()
      })
    } as unknown as PermissionGrantRegistry
    const publishChanged = vi.fn()
    const controller = createPermissionGrantProjectionController({
      registry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      publishChanged
    })
    const request = { grants: [{ id: 'grant-1', revision: 2 }] }

    await expect(controller.revoke(request)).resolves.toMatchObject({
      version: 1,
      receipt: { undoToken: 'undo-1' },
      conflicts: []
    })
    expect(revoke).toHaveBeenCalledWith(request)
    expect(publishChanged).toHaveBeenCalledWith({ revision: 1 })
  })

  it('rejects an empty revoke before calling the Registry', async () => {
    const revoke = vi.fn()
    const controller = createPermissionGrantProjectionController({
      registry: {
        revoke,
        subscribe: vi.fn(() => vi.fn())
      } as unknown as PermissionGrantRegistry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      publishChanged: vi.fn()
    })

    await expect(controller.revoke({ grants: [] })).rejects.toThrow(
      'Select at least one permission grant to revoke.'
    )
    expect(revoke).not.toHaveBeenCalled()
  })

  it('extends a valid Undo receipt through the shared owner', async () => {
    const receipt = { undoToken: 'undo-1', expiresAt: 10, revokedCount: 1 }
    const extendUndo = vi.fn().mockResolvedValue(receipt)
    const controller = createPermissionGrantProjectionController({
      registry: {
        extendUndo,
        subscribe: vi.fn(() => vi.fn())
      } as unknown as PermissionGrantRegistry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      publishChanged: vi.fn()
    })

    await expect(controller.extendUndo({ undoToken: 'undo-1' })).resolves.toBe(receipt)
    expect(extendUndo).toHaveBeenCalledWith({ undoToken: 'undo-1' })
  })

  it.each(['extendUndo', 'restore'] as const)(
    'keeps Undo token validation inside %s',
    async (method) => {
      const operation = vi.fn()
      const controller = createPermissionGrantProjectionController({
        registry: {
          [method]: operation,
          subscribe: vi.fn(() => vi.fn())
        } as unknown as PermissionGrantRegistry,
        projects: { list: vi.fn().mockResolvedValue([]) },
        sessions: {
          metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true })
        },
        publishChanged: vi.fn()
      })

      await expect(controller[method]({ undoToken: ' ' })).rejects.toThrow(
        'Permission Undo token is required.'
      )
      expect(operation).not.toHaveBeenCalled()
    }
  )

  it('restores through the shared owner and returns the current projection', async () => {
    let registryChanged: (() => void) | undefined
    const restore = vi.fn(async () => {
      registryChanged?.()
      return { grants: [], conflicts: [] }
    })
    const controller = createPermissionGrantProjectionController({
      registry: {
        list: vi.fn().mockResolvedValue([]),
        restore,
        subscribe: vi.fn((listener: () => void) => {
          registryChanged = listener
          return vi.fn()
        })
      } as unknown as PermissionGrantRegistry,
      projects: { list: vi.fn().mockResolvedValue([]) },
      sessions: { metadataSnapshot: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }) },
      publishChanged: vi.fn()
    })

    await expect(controller.restore({ undoToken: 'undo-1' })).resolves.toMatchObject({
      version: 1,
      conflicts: []
    })
    expect(restore).toHaveBeenCalledWith({ undoToken: 'undo-1' })
  })
})
