import { describe, expect, it, vi } from 'vitest'

import { createProjectHandlers } from './ipc'

describe('createProjectHandlers', () => {
  it('routes deletion through the project deletion coordinator', async () => {
    const repository = {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    }
    const deletionCoordinator = {
      deleteProject: vi.fn().mockResolvedValue(undefined),
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = { deleteReviewsForProject: vi.fn().mockResolvedValue(undefined) }
    const handlers = createProjectHandlers(repository, reviewRepository, deletionCoordinator)

    await handlers.delete('project-1')

    expect(deletionCoordinator.deleteProject).toHaveBeenCalledWith('project-1')
    expect(repository.delete).not.toHaveBeenCalled()
  })

  it('recovers durable deletions before listing projects', async () => {
    const repository = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    }
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = { deleteReviewsForProject: vi.fn().mockResolvedValue(undefined) }
    const handlers = createProjectHandlers(repository, reviewRepository, deletionCoordinator)

    await handlers.list()

    expect(deletionCoordinator.recoverPendingDeletions).toHaveBeenCalledOnce()
    expect(repository.list).toHaveBeenCalledOnce()
  })

  it('recovers durable deletions before every project read or mutation', async () => {
    const order: string[] = []
    const repository = {
      list: vi.fn(),
      get: vi.fn(async () => {
        order.push('get')
        return null
      }),
      create: vi.fn(async () => {
        order.push('create')
        return project
      }),
      update: vi.fn(async () => {
        order.push('update')
        return project
      })
    }
    const deletionCoordinator = {
      deleteProject: vi.fn(),
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recover')
      })
    }
    const reviewRepository = { deleteReviewsForProject: vi.fn().mockResolvedValue(undefined) }
    const handlers = createProjectHandlers(repository, reviewRepository, deletionCoordinator)

    await handlers.get('project-1')
    await handlers.create({ name: 'Project' })
    await handlers.update({ id: 'project-1', name: 'Renamed' })

    expect(order).toEqual(['recover', 'get', 'recover', 'create', 'recover', 'update'])
  })
})

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 2
}
