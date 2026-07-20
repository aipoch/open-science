import { describe, expect, it, vi } from 'vitest'

import { ProjectDeletionCoordinator, type ProjectDeletionRepository } from './deletion-coordinator'

const project = {
  id: 'project-1',
  name: 'Project',
  description: 'Description',
  isExample: false,
  createdAt: 1,
  updatedAt: 2
}

describe('ProjectDeletionCoordinator', () => {
  it('deletes the project row, sessions, index, and preview state', async () => {
    const projects = createProjects()
    const sessions = { deleteProjectSessions: vi.fn().mockResolvedValue(undefined) }
    const preview = { delete: vi.fn().mockResolvedValue(undefined) }
    const reviews = { deleteReviewsForProject: vi.fn().mockResolvedValue(undefined) }
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, preview, reviews)

    await coordinator.deleteProject('project-1')

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(preview.delete).toHaveBeenCalledWith('project-1')
    expect(reviews.deleteReviewsForProject).toHaveBeenCalledWith('project-1')
  })

  it('keeps the project row and clears intent when session and index cleanup fails', async () => {
    const projects = createProjects()
    const sessions = {
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('directory busy'))
    }
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.deleteProject('project-1')).rejects.toThrow('directory busy')

    expect(projects.delete).not.toHaveBeenCalled()
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
  })

  it('replays durable deletion intents after a process restart', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = { deleteProjectSessions: vi.fn().mockResolvedValue(undefined) }
    const reviews = { deleteReviewsForProject: vi.fn().mockResolvedValue(undefined) }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      { delete: vi.fn().mockResolvedValue(undefined) },
      reviews
    )

    await coordinator.recoverPendingDeletions()

    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(reviews.deleteReviewsForProject).toHaveBeenCalledWith('project-1')
  })

  it('keeps the recovery intent until derived project cleanup has finished', async () => {
    const order: string[] = []
    const projects = createProjects()
    projects.delete = vi.fn(async () => {
      order.push('project')
    })
    projects.deleteDeletionIntent = vi.fn(async () => {
      order.push('intent')
    })
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      { deleteProjectSessions: vi.fn().mockResolvedValue(undefined) },
      {
        delete: vi.fn(async () => {
          order.push('preview')
        })
      },
      {
        deleteReviewsForProject: vi.fn(async () => {
          order.push('reviews')
        })
      }
    )

    await coordinator.deleteProject('project-1')

    expect(order).toEqual(['project', 'preview', 'reviews', 'intent'])
  })

  it('reuses a successful recovery gate for later operations', async () => {
    const projects = createProjects()
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      { deleteProjectSessions: vi.fn().mockResolvedValue(undefined) },
      { delete: vi.fn().mockResolvedValue(undefined) }
    )

    await coordinator.recoverPendingDeletions()
    await coordinator.recoverPendingDeletions()

    expect(projects.listDeletionIntents).toHaveBeenCalledOnce()
  })

  it('makes concurrent recovery wait for a newly started deletion', async () => {
    const deletionGate = createDeferred<void>()
    const coordinator = new ProjectDeletionCoordinator(
      createProjects(),
      {
        deleteProjectSessions: vi.fn(async () => {
          await deletionGate.promise
        })
      },
      { delete: vi.fn().mockResolvedValue(undefined) }
    )
    await coordinator.recoverPendingDeletions()

    const deletion = coordinator.deleteProject('project-1')
    await flushMicrotasks()
    let recoveryFinished = false
    const recovery = coordinator.recoverPendingDeletions().then(() => {
      recoveryFinished = true
    })
    await flushMicrotasks()
    expect(recoveryFinished).toBe(false)

    deletionGate.resolve()
    await Promise.all([deletion, recovery])
    expect(recoveryFinished).toBe(true)
  })

  it('keeps recovery blocked until every concurrently requested deletion finishes', async () => {
    const firstGate = createDeferred<void>()
    const secondGate = createDeferred<void>()
    const sessions = {
      deleteProjectSessions: vi.fn(async (projectId: string) => {
        await (projectId === 'project-1' ? firstGate.promise : secondGate.promise)
      })
    }
    const coordinator = new ProjectDeletionCoordinator(createProjects(), sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })
    await coordinator.recoverPendingDeletions()

    const firstDeletion = coordinator.deleteProject('project-1')
    const secondDeletion = coordinator.deleteProject('project-2')
    await flushMicrotasks()
    await flushMicrotasks()

    let recoveryFinished = false
    const recovery = coordinator.recoverPendingDeletions().then(() => {
      recoveryFinished = true
    })
    secondGate.resolve(undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(recoveryFinished).toBe(false)

    firstGate.resolve(undefined)
    await Promise.all([firstDeletion, secondDeletion, recovery])
    expect(recoveryFinished).toBe(true)
  })
})

const createProjects = (): ProjectDeletionRepository => ({
  get: vi.fn().mockResolvedValue(project),
  delete: vi.fn().mockResolvedValue(undefined),
  createDeletionIntent: vi.fn().mockResolvedValue(undefined),
  deleteDeletionIntent: vi.fn().mockResolvedValue(undefined),
  listDeletionIntents: vi.fn().mockResolvedValue([])
})

const createDeferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}
