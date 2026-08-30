import { describe, expect, it, vi } from 'vitest'

import type { TagSnapshot } from '../../shared/tags'
import type { TagRepository } from './repository'
import type { TagResourceCatalog } from './resource-catalog'
import { TagService } from './service'

const snapshot = (revision: number): TagSnapshot => ({ revision, tags: [], assignments: [] })

describe('TagService', () => {
  it('serializes Tag reordering and publishes the authoritative result', async () => {
    const repository = {
      reorder: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn((revision) => Promise.resolve(snapshot(revision)))
    }
    const events = { publish: vi.fn() }
    const service = new TagService(
      repository as unknown as TagRepository,
      {} as TagResourceCatalog,
      events
    )

    await expect(service.reorder({ tagIds: ['tag-b', 'tag-a'] })).resolves.toEqual(snapshot(1))
    expect(repository.reorder).toHaveBeenCalledWith({ tagIds: ['tag-b', 'tag-a'] })
    expect(events.publish).toHaveBeenCalledWith('tags:changed', { revision: 1 })
  })

  it('validates resources, advances revision, and publishes a convergence event', async () => {
    const repository = {
      setAssignment: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn((revision) => Promise.resolve(snapshot(revision)))
    }
    const resources = { exists: vi.fn().mockResolvedValue(true) }
    const events = { publish: vi.fn() }
    const service = new TagService(
      repository as unknown as TagRepository,
      resources as unknown as TagResourceCatalog,
      events
    )

    await expect(
      service.setAssignment({
        tagId: 'tag-favorite',
        resourceType: 'catalog.skill',
        resourceId: 'analysis',
        assigned: true
      })
    ).resolves.toEqual(snapshot(1))
    expect(resources.exists).toHaveBeenCalledOnce()
    expect(events.publish).toHaveBeenCalledWith('tags:changed', { revision: 1 })
  })

  it('serializes authoritative snapshots with their mutations', async () => {
    let resolveFirstSnapshot: ((value: TagSnapshot) => void) | undefined
    const firstSnapshot = new Promise<TagSnapshot>((resolve) => {
      resolveFirstSnapshot = resolve
    })
    const repository = {
      create: vi.fn().mockResolvedValue(undefined),
      snapshot: vi
        .fn()
        .mockImplementationOnce(() => firstSnapshot)
        .mockImplementation((revision) => Promise.resolve(snapshot(revision)))
    }
    const events = { publish: vi.fn() }
    const service = new TagService(
      repository as unknown as TagRepository,
      {} as TagResourceCatalog,
      events
    )

    const first = service.create({
      name: 'First',
      iconKey: 'tag',
      colorKey: 'blue'
    })
    await vi.waitFor(() => expect(repository.snapshot).toHaveBeenCalledWith(1))
    const second = service.create({
      name: 'Second',
      iconKey: 'star',
      colorKey: 'amber'
    })
    await Promise.resolve()

    expect(repository.create).toHaveBeenCalledTimes(1)
    expect(repository.snapshot).toHaveBeenCalledTimes(1)

    resolveFirstSnapshot?.(snapshot(1))
    await expect(first).resolves.toEqual(snapshot(1))
    await expect(second).resolves.toEqual(snapshot(2))
    expect(repository.create).toHaveBeenCalledTimes(2)
    expect(repository.snapshot).toHaveBeenNthCalledWith(2, 2)
    expect(events.publish).toHaveBeenNthCalledWith(1, 'tags:changed', { revision: 1 })
    expect(events.publish).toHaveBeenNthCalledWith(2, 'tags:changed', { revision: 2 })
  })

  it('keeps a snapshot revision consistent with following mutations', async () => {
    let releaseInitialSnapshot: (() => void) | undefined
    let initialSnapshotStarted: (() => void) | undefined
    const initialSnapshotGate = new Promise<void>((resolve) => {
      releaseInitialSnapshot = resolve
    })
    const initialSnapshotCall = new Promise<void>((resolve) => {
      initialSnapshotStarted = resolve
    })
    const tags: TagSnapshot['tags'] = []
    const repository = {
      create: vi.fn(async (request: { name: string; iconKey: 'tag'; colorKey: 'blue' }) => {
        tags.push({
          id: 'tag-created',
          ...request,
          createdAt: 1,
          updatedAt: 1
        })
      }),
      pruneStaleAssignments: vi.fn().mockResolvedValue(0),
      snapshot: vi.fn(async (revision: number) => {
        if (revision === 0) {
          initialSnapshotStarted?.()
          await initialSnapshotGate
        }
        return { revision, tags: [...tags], assignments: [] }
      })
    }
    const service = new TagService(
      repository as unknown as TagRepository,
      { snapshot: vi.fn().mockResolvedValue({}) } as unknown as TagResourceCatalog,
      { publish: vi.fn() }
    )

    const beforeMutation = service.snapshot()
    await initialSnapshotCall
    const mutation = service.create({ name: 'Created', iconKey: 'tag', colorKey: 'blue' })
    releaseInitialSnapshot?.()

    await expect(beforeMutation).resolves.toEqual(snapshot(0))
    await expect(mutation).resolves.toEqual({
      revision: 1,
      tags: [
        {
          id: 'tag-created',
          name: 'Created',
          iconKey: 'tag',
          colorKey: 'blue',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      assignments: []
    })
  })

  it('rejects assigning a stale resource without writing', async () => {
    const repository = { setAssignment: vi.fn() }
    const service = new TagService(
      repository as unknown as TagRepository,
      { exists: vi.fn().mockResolvedValue(false) } as unknown as TagResourceCatalog,
      { publish: vi.fn() }
    )

    await expect(
      service.setAssignment({
        tagId: 'tag-favorite',
        resourceType: 'catalog.specialist',
        resourceId: 'missing',
        assigned: true
      })
    ).rejects.toThrow('Tag resource no longer exists.')
    expect(repository.setAssignment).not.toHaveBeenCalled()
  })

  it('serializes resource validation behind pending deletion cleanup', async () => {
    let finishCleanup: (() => void) | undefined
    let deleted = false
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const repository = {
      removeResourceAssignments: vi.fn(async () => {
        await cleanup
        deleted = true
        return 0
      }),
      setAssignment: vi.fn(),
      snapshot: vi.fn((revision) => Promise.resolve(snapshot(revision)))
    }
    const resources = { exists: vi.fn(() => Promise.resolve(!deleted)) }
    const service = new TagService(
      repository as unknown as TagRepository,
      resources as unknown as TagResourceCatalog,
      { publish: vi.fn() }
    )
    const reference = { resourceType: 'catalog.skill' as const, resourceId: 'deleted-skill' }

    const deletion = service.removeResources([reference])
    await vi.waitFor(() => expect(repository.removeResourceAssignments).toHaveBeenCalledOnce())
    const assignment = service.setAssignment({
      ...reference,
      tagId: 'tag-favorite',
      assigned: true
    })
    await Promise.resolve()
    expect(resources.exists).not.toHaveBeenCalled()

    finishCleanup?.()
    await deletion
    await expect(assignment).rejects.toThrow('Tag resource no longer exists.')
    expect(resources.exists).toHaveBeenCalledOnce()
    expect(repository.setAssignment).not.toHaveBeenCalled()
  })

  it('prunes stale references during snapshot reconciliation', async () => {
    const repository = {
      pruneStaleAssignments: vi.fn().mockResolvedValue(2),
      snapshot: vi.fn((revision) => Promise.resolve(snapshot(revision)))
    }
    const events = { publish: vi.fn() }
    const service = new TagService(
      repository as unknown as TagRepository,
      { snapshot: vi.fn().mockResolvedValue({}) } as unknown as TagResourceCatalog,
      events
    )

    await expect(service.snapshot()).resolves.toEqual(snapshot(1))
    expect(events.publish).toHaveBeenCalledWith('tags:changed', { revision: 1 })
  })

  it('removes assignments when the owning resource is deleted', async () => {
    const repository = { removeResourceAssignments: vi.fn().mockResolvedValue(1) }
    const events = { publish: vi.fn() }
    const service = new TagService(
      repository as unknown as TagRepository,
      {} as TagResourceCatalog,
      events
    )

    await service.removeResources([
      { resourceType: 'catalog.specialist', resourceId: 'deleted-specialist' }
    ])

    expect(repository.removeResourceAssignments).toHaveBeenCalledWith([
      { resourceType: 'catalog.specialist', resourceId: 'deleted-specialist' }
    ])
    expect(events.publish).toHaveBeenCalledWith('tags:changed', { revision: 1 })
  })

  it('retries failed deletion cleanup before resolving a reused resource id', async () => {
    const repository = {
      removeResourceAssignments: vi
        .fn()
        .mockRejectedValueOnce(new Error('database busy'))
        .mockResolvedValueOnce(1),
      pruneStaleAssignments: vi.fn().mockResolvedValue(0),
      snapshot: vi.fn((revision) => Promise.resolve(snapshot(revision)))
    }
    const resources = { snapshot: vi.fn().mockResolvedValue({}) }
    const events = { publish: vi.fn() }
    const service = new TagService(
      repository as unknown as TagRepository,
      resources as unknown as TagResourceCatalog,
      events
    )
    const deleted = [{ resourceType: 'catalog.skill' as const, resourceId: 'reused-id' }]

    await expect(service.removeResources(deleted)).rejects.toThrow('database busy')
    await expect(service.snapshot()).resolves.toEqual(snapshot(2))

    expect(repository.removeResourceAssignments).toHaveBeenNthCalledWith(2, deleted)
    expect(events.publish).toHaveBeenNthCalledWith(1, 'tags:changed', { revision: 1 })
    expect(events.publish).toHaveBeenNthCalledWith(2, 'tags:changed', { revision: 2 })
  })
})
