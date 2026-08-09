import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ProjectDeletionCoordinator,
  type ProjectDeletionRepository,
  type ProjectSessionDeletion
} from './deletion-coordinator'
import { beginMigration, clearMigrationPending } from '../storage/migration-state'

afterEach(() => clearMigrationPending())

const project = {
  id: 'project-1',
  name: 'Project',
  description: 'Description',
  isExample: false,
  createdAt: 1,
  updatedAt: 2
}

describe('ProjectDeletionCoordinator', () => {
  it('rejects deletion recovery while a data-root migration is pending', async () => {
    const projects = createProjects()
    const coordinator = new ProjectDeletionCoordinator(projects, createSessions(), {
      delete: vi.fn().mockResolvedValue(undefined)
    })
    beginMigration()

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow(/moving your data/i)
    expect(projects.listDeletionIntents).not.toHaveBeenCalled()
  })

  it('deletes the project row, sessions, index, and preview state', async () => {
    const projects = createProjects()
    const sessions = createSessions()
    const preview = { delete: vi.fn().mockResolvedValue(undefined) }
    const reviews = { deleteReviewsForProject: vi.fn().mockResolvedValue(undefined) }
    const provenance = { deleteProjectProvenance: vi.fn().mockResolvedValue(undefined) }
    const permissionGrants = {
      prune: vi.fn().mockResolvedValue([]),
      finalizeOwnerDeletion: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      preview,
      reviews,
      provenance,
      permissionGrants
    )

    await coordinator.deleteProject('project-1')

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(preview.delete).toHaveBeenCalledWith('project-1')
    expect(reviews.deleteReviewsForProject).toHaveBeenCalledWith('project-1')
    expect(provenance.deleteProjectProvenance).toHaveBeenCalledWith('project-1')
    expect(permissionGrants.prune).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'project-1'
    })
    expect(permissionGrants.finalizeOwnerDeletion).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'project-1'
    })
    expect(vi.mocked(permissionGrants.prune).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(projects.delete).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(projects.delete).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(permissionGrants.finalizeOwnerDeletion).mock.invocationCallOrder[0]
    )
  })

  it('awaits runtime invalidation before starting whole-project deletion', async () => {
    const projects = createProjects()
    const sessions = createSessions()
    const invalidated = createDeferred<void>()
    const beforeProjectDelete = vi.fn(() => invalidated.promise)
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      { delete: vi.fn().mockResolvedValue(undefined) },
      undefined,
      undefined,
      undefined,
      { beforeProjectDelete }
    )

    const deletion = coordinator.deleteProject('project-1')
    await vi.waitFor(() => expect(beforeProjectDelete).toHaveBeenCalledWith('project-1'))
    expect(projects.createDeletionIntent).not.toHaveBeenCalled()
    expect(sessions.deleteProjectSessions).not.toHaveBeenCalled()

    invalidated.resolve(undefined)
    await deletion

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
  })

  it('retains the Project and deletion intent when grant pruning fails, then resumes idempotently', async () => {
    let projectExists = true
    let intentExists = false
    const projects = createProjects()
    projects.get = vi.fn(async () => (projectExists ? project : null))
    projects.delete = vi.fn(async () => {
      projectExists = false
    })
    projects.createDeletionIntent = vi.fn(async () => {
      intentExists = true
    })
    projects.deleteDeletionIntent = vi.fn(async () => {
      intentExists = false
    })
    projects.listDeletionIntents = vi.fn(async () => (intentExists ? ['project-1'] : []))
    const sessions = createSessions()
    const permissionGrants = {
      prune: vi
        .fn()
        .mockRejectedValueOnce(new Error('permission registry unavailable'))
        .mockResolvedValueOnce([])
    }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      { delete: vi.fn().mockResolvedValue(undefined) },
      undefined,
      undefined,
      permissionGrants
    )

    await expect(coordinator.deleteProject('project-1')).rejects.toThrow(
      'permission registry unavailable'
    )

    expect(projectExists).toBe(true)
    expect(intentExists).toBe(true)
    expect(projects.delete).not.toHaveBeenCalled()
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()

    await expect(coordinator.deleteProject('project-1')).resolves.toBeUndefined()

    expect(permissionGrants.prune).toHaveBeenCalledTimes(2)
    expect(sessions.deleteProjectSessions).toHaveBeenCalledTimes(2)
    expect(projects.delete).toHaveBeenCalledOnce()
    expect(sessions.completeProjectSessionDeletion).toHaveBeenCalledOnce()
    expect(projectExists).toBe(false)
    expect(intentExists).toBe(false)
  })

  it('does not report a false deletion failure after the Project hard delete commits', async () => {
    const projects = createProjects()
    const sessions = createSessions()
    const permissionGrants = {
      prune: vi.fn().mockResolvedValue([]),
      finalizeOwnerDeletion: vi.fn().mockRejectedValue(new Error('listener unavailable'))
    }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      { delete: vi.fn().mockResolvedValue(undefined) },
      undefined,
      undefined,
      permissionGrants
    )

    await expect(coordinator.deleteProject('project-1')).resolves.toBeUndefined()

    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(sessions.completeProjectSessionDeletion).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
  })

  it('keeps the project row and clears intent when session and index cleanup fails', async () => {
    const projects = createProjects()
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('directory busy'))
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.deleteProject('project-1')).rejects.toThrow('directory busy')

    expect(projects.delete).not.toHaveBeenCalled()
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
  })

  it('keeps an online intent when Session authority committed before a derived failure', async () => {
    const projects = createProjects()
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('index unavailable')),
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('prepared')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.deleteProject('project-1')).rejects.toThrow('index unavailable')

    expect(projects.delete).not.toHaveBeenCalled()
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
  })

  it('replays durable deletion intents after a process restart', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = createSessions()
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
    expect(sessions.listLegacyProjectSessionTombstones).toHaveBeenCalledOnce()
  })

  it('adopts an orphaned legacy tombstone into an intent before preparing its Session authority', async () => {
    const order: string[] = []
    const projects = createProjects()
    projects.get = vi.fn().mockResolvedValue(null)
    projects.createDeletionIntent = vi.fn(async () => {
      order.push('intent-created')
    })
    projects.deleteDeletionIntent = vi.fn(async () => {
      order.push('intent-removed')
    })
    const sessions = createSessions({
      listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue(['project-old']),
      deleteProjectSessions: vi.fn(async () => {
        order.push('sessions-prepared')
        return { status: 'completed' as const }
      }),
      completeProjectSessionDeletion: vi.fn(async () => {
        order.push('tombstone-removed')
      })
    })
    const provenance = {
      deleteProjectProvenance: vi.fn(async () => {
        order.push('provenance-removed')
      })
    }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      { delete: vi.fn().mockResolvedValue(undefined) },
      undefined,
      provenance
    )

    await coordinator.recoverPendingDeletions()

    expect(order).toEqual([
      'intent-created',
      'sessions-prepared',
      'provenance-removed',
      'tombstone-removed',
      'intent-removed'
    ])
  })

  it('retains an adopted legacy intent when retained index deletion fails', async () => {
    const projects = createProjects()
    projects.get = vi.fn().mockResolvedValue(null)
    const sessions = createSessions({
      listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue(['project-old']),
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('index temporarily unavailable'))
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow(
      'index temporarily unavailable'
    )

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-old')
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()
  })

  it('drops the temporary intent and continues when an adopted orphan must be retained', async () => {
    const projects = createProjects()
    projects.get = vi.fn().mockResolvedValue(null)
    const sessions = createSessions({
      listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue(['project-old']),
      deleteProjectSessions: vi.fn().mockResolvedValue({
        status: 'orphan-retained',
        reason: 'missing-upload-authority'
      })
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.recoverPendingDeletions()).resolves.toBeUndefined()

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-old')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-old')
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()
  })

  it('re-derives orphan authority policy when replaying an adopted intent after restart', async () => {
    const projects = createProjects()
    projects.get = vi.fn().mockResolvedValue(null)
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-old'])
    const sessions = createSessions({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await coordinator.recoverPendingDeletions()

    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-old', {
      requireExistingUploadAuthority: true
    })
  })

  it('releases a replayed orphan-retained intent without adopting it twice in one recovery', async () => {
    const projects = createProjects()
    projects.get = vi.fn().mockResolvedValue(null)
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-old'])
    const sessions = createSessions({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue(['project-old']),
      deleteProjectSessions: vi.fn().mockResolvedValue({
        status: 'orphan-retained',
        reason: 'missing-upload-authority'
      })
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.recoverPendingDeletions()).resolves.toBeUndefined()

    expect(sessions.deleteProjectSessions).toHaveBeenCalledOnce()
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-old')
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()
  })

  it('clears a stale pre-commit recovery intent and continues with later Projects', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1', 'project-2'])
    const sessions = createSessions({
      deleteProjectSessions: vi.fn(async (projectId: string) => {
        if (projectId === 'project-1') throw new Error('transient session cleanup failure')
        return { status: 'completed' as const }
      }),
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('live')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.recoverPendingDeletions()).resolves.toBeUndefined()

    expect(sessions.deleteProjectSessions).toHaveBeenCalledTimes(2)
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(projects.delete).not.toHaveBeenCalledWith('project-1')
    expect(projects.delete).toHaveBeenCalledWith('project-2')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-2')
  })

  it('keeps a committed recovery intent when the Project row still exists and replay fails', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('tail cleanup unavailable')),
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('prepared')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow('tail cleanup unavailable')

    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
  })

  it('keeps a recovery intent when durable Session phase state is unknown', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const replayFailure = new Error('session replay failed')
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(replayFailure),
      getProjectSessionDeletionState: vi.fn().mockRejectedValue(new Error('marker unreadable'))
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.recoverPendingDeletions()).rejects.toBe(replayFailure)

    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
  })

  it('keeps a recovery intent when failed replay finds Session authority absent', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('session replay failed')),
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('absent')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow('session replay failed')

    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
  })

  it('keeps the intent when committed Session tombstone cleanup fails', async () => {
    const projects = createProjects()
    const sessions = createSessions({
      completeProjectSessionDeletion: vi.fn().mockRejectedValue(new Error('tombstone busy'))
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await expect(coordinator.deleteProject('project-1')).rejects.toThrow('tombstone busy')

    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
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
    const sessions = createSessions({
      completeProjectSessionDeletion: vi.fn(async () => {
        order.push('tombstone')
      })
    })
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      {
        delete: vi.fn(async () => {
          order.push('preview')
        })
      },
      {
        deleteReviewsForProject: vi.fn(async () => {
          order.push('reviews')
        })
      },
      {
        deleteProjectProvenance: vi.fn(async () => {
          order.push('provenance')
        })
      }
    )

    await coordinator.deleteProject('project-1')

    expect(order).toEqual(['project', 'preview', 'reviews', 'provenance', 'tombstone', 'intent'])
  })

  it('reuses a successful recovery gate for later operations', async () => {
    const projects = createProjects()
    const coordinator = new ProjectDeletionCoordinator(projects, createSessions(), {
      delete: vi.fn().mockResolvedValue(undefined)
    })

    await coordinator.recoverPendingDeletions()
    await coordinator.recoverPendingDeletions()

    expect(projects.listDeletionIntents).toHaveBeenCalledOnce()
  })

  it('makes concurrent recovery wait for a newly started deletion', async () => {
    const deletionGate = createDeferred<void>()
    const coordinator = new ProjectDeletionCoordinator(
      createProjects(),
      createSessions({
        deleteProjectSessions: vi.fn(async () => {
          await deletionGate.promise
          return { status: 'completed' as const }
        })
      }),
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
    const sessions = createSessions({
      deleteProjectSessions: vi.fn(async (projectId: string) => {
        await (projectId === 'project-1' ? firstGate.promise : secondGate.promise)
        return { status: 'completed' as const }
      })
    })
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

const createSessions = (
  overrides: Partial<ProjectSessionDeletion> = {}
): ProjectSessionDeletion => ({
  deleteProjectSessions: vi.fn().mockResolvedValue({ status: 'completed' }),
  getProjectSessionDeletionState: vi.fn().mockResolvedValue('absent'),
  completeProjectSessionDeletion: vi.fn().mockResolvedValue(undefined),
  listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue([]),
  ...overrides
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
