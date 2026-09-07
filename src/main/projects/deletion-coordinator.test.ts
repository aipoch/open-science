import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ProjectDeletionRecoveryLoop,
  ProjectDeletionCoordinator,
  type ProjectDeletionRepository,
  type ProjectSessionDeletion
} from './deletion-coordinator'
import { beginMigration, clearMigrationPending } from '../storage/migration-state'

afterEach(() => {
  clearMigrationPending()
  vi.useRealTimers()
})

describe('ProjectDeletionCoordinator', () => {
  it('rejects deletion recovery while a data-root migration is pending', async () => {
    const projects = createProjects()
    const coordinator = new ProjectDeletionCoordinator(projects, createSessions())
    beginMigration()

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow(/moving your data/i)
    expect(projects.listDeletionIntents).not.toHaveBeenCalled()
  })

  it('soft-deletes the project metadata and removes active-only project data', async () => {
    const projects = createProjects()
    projects.delete = vi.fn().mockResolvedValue({ memoryRevision: 7 })
    const sessions = createSessions()
    const reviews = { deleteReviewsForProject: vi.fn().mockResolvedValue(undefined) }
    const provenance = { deleteProjectProvenance: vi.fn().mockResolvedValue(undefined) }
    const permissionGrants = {
      prune: vi.fn().mockResolvedValue([]),
      finalizeOwnerDeletion: vi.fn().mockResolvedValue(undefined)
    }
    const finalizeProjectDeletion = vi.fn().mockResolvedValue(undefined)
    const completeProjectDeletion = vi.fn()
    const abortProjectDeletion = vi.fn()
    const events = { publish: vi.fn() }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      reviews,
      provenance,
      permissionGrants,
      {
        beforeProjectDelete: vi.fn().mockResolvedValue(undefined),
        finalizeProjectDeletion,
        completeProjectDeletion,
        abortProjectDeletion
      },
      events
    )

    await coordinator.deleteProject('project-1')

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
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
    expect(finalizeProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(completeProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(abortProjectDeletion).not.toHaveBeenCalled()
    expect(events.publish).toHaveBeenCalledWith('memory:changed', { revision: 7 })
    expect(events.publish).toHaveBeenCalledWith('project:deleted', {
      projectId: 'project-1',
      status: 'cleanup-pending'
    })
    expect(events.publish).toHaveBeenCalledWith('project:deleted', {
      projectId: 'project-1',
      status: 'deleted'
    })
    const pendingEventIndex = events.publish.mock.calls.findIndex(
      ([channel, payload]) =>
        channel === 'project:deleted' &&
        (payload as { status?: string }).status === 'cleanup-pending'
    )
    expect(pendingEventIndex).toBeGreaterThan(-1)
    const pendingEventOrder = events.publish.mock.invocationCallOrder[pendingEventIndex]
    expect(pendingEventOrder).toBeDefined()
    expect(vi.mocked(projects.delete).mock.invocationCallOrder[0]).toBeLessThan(
      pendingEventOrder as number
    )
    expect(pendingEventOrder).toBeLessThan(
      reviews.deleteReviewsForProject.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(vi.mocked(permissionGrants.prune).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(projects.delete).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(projects.delete).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(permissionGrants.finalizeOwnerDeletion).mock.invocationCallOrder[0]
    )
  })

  it('installs the deletion fence before committing retry authority and starting teardown', async () => {
    const projects = createProjects()
    const sessions = createSessions()
    const invalidated = createDeferred<void>()
    const restoreProjectDeletion = vi.fn().mockResolvedValue(undefined)
    const beforeProjectDelete = vi.fn(() => invalidated.promise)
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      undefined,
      undefined,
      undefined,
      { beforeProjectDelete, restoreProjectDeletion }
    )

    const deletion = coordinator.deleteProject('project-1')
    await vi.waitFor(() => expect(beforeProjectDelete).toHaveBeenCalledWith('project-1'))
    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(restoreProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(sessions.deleteProjectSessions).not.toHaveBeenCalled()
    expect(restoreProjectDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(projects.createDeletionIntent).mock.invocationCallOrder[0]
    )
    expect(vi.mocked(projects.createDeletionIntent).mock.invocationCallOrder[0]).toBeLessThan(
      beforeProjectDelete.mock.invocationCallOrder[0]
    )

    invalidated.resolve(undefined)
    await deletion

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
  })

  it('releases the deletion fence without starting teardown when intent creation fails', async () => {
    const projects = createProjects()
    projects.createDeletionIntent = vi.fn().mockRejectedValue(new Error('intent unavailable'))
    const aborted = createDeferred<void>()
    const abortProjectDeletion = vi.fn(() => aborted.promise)
    const beforeProjectDelete = vi.fn().mockResolvedValue(undefined)
    const restoreProjectDeletion = vi.fn().mockResolvedValue(undefined)
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      createSessions(),
      undefined,
      undefined,
      undefined,
      {
        beforeProjectDelete,
        restoreProjectDeletion,
        abortProjectDeletion
      }
    )

    const deletion = coordinator.deleteProject('project-1')
    let deletionSettled = false
    void deletion.then(
      () => {
        deletionSettled = true
      },
      () => {
        deletionSettled = true
      }
    )

    await vi.waitFor(() => expect(abortProjectDeletion).toHaveBeenCalledWith('project-1'))
    await Promise.resolve()

    expect(restoreProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(beforeProjectDelete).not.toHaveBeenCalled()
    expect(deletionSettled).toBe(false)
    expect(restoreProjectDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(projects.createDeletionIntent).mock.invocationCallOrder[0]
    )

    aborted.resolve(undefined)
    await expect(deletion).rejects.toThrow('intent unavailable')
  })

  it('preserves intent creation and deletion-fence rollback failures', async () => {
    const intentError = new Error('intent unavailable')
    const rollbackError = new Error('deletion fence unavailable')
    const projects = createProjects()
    projects.createDeletionIntent = vi.fn().mockRejectedValue(intentError)
    const abortProjectDeletion = vi.fn().mockRejectedValue(rollbackError)
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      createSessions(),
      undefined,
      undefined,
      undefined,
      {
        beforeProjectDelete: vi.fn().mockResolvedValue(undefined),
        restoreProjectDeletion: vi.fn().mockResolvedValue(undefined),
        abortProjectDeletion
      }
    )

    const failure = await coordinator.deleteProject('project-1').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([intentError, rollbackError])
    expect(abortProjectDeletion).toHaveBeenCalledWith('project-1')
  })

  it('retains the durable intent and deletion barrier when runtime quiescence fails', async () => {
    const projects = createProjects()
    const abortProjectDeletion = vi.fn()
    const restoreProjectDeletion = vi.fn().mockResolvedValue(undefined)
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      createSessions(),
      undefined,
      undefined,
      undefined,
      {
        beforeProjectDelete: vi.fn().mockRejectedValue(new Error('runtime cleanup failed')),
        restoreProjectDeletion,
        abortProjectDeletion
      }
    )

    await expect(coordinator.deleteProject('project-1')).rejects.toThrow('runtime cleanup failed')

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(restoreProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
    expect(abortProjectDeletion).not.toHaveBeenCalled()
  })

  it('retains the Project and deletion intent when grant pruning fails, then resumes idempotently', async () => {
    let projectExists = true
    let intentExists = false
    const projects = createProjects()
    projects.exists = vi.fn(async () => projectExists)
    projects.delete = vi.fn(async () => {
      projectExists = false
      return undefined
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

    await expect(coordinator.deleteProject('project-1')).resolves.toEqual({ status: 'deleted' })

    expect(permissionGrants.prune).toHaveBeenCalledTimes(2)
    expect(sessions.deleteProjectSessions).toHaveBeenCalledTimes(2)
    expect(projects.delete).toHaveBeenCalledOnce()
    expect(sessions.completeProjectSessionDeletion).toHaveBeenCalledOnce()
    expect(projectExists).toBe(false)
    expect(intentExists).toBe(false)
  })

  it('does not report a false deletion failure after the Project soft delete commits', async () => {
    const projects = createProjects()
    const sessions = createSessions()
    const permissionGrants = {
      prune: vi.fn().mockResolvedValue([]),
      finalizeOwnerDeletion: vi.fn().mockRejectedValue(new Error('listener unavailable'))
    }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      undefined,
      undefined,
      permissionGrants
    )

    await expect(coordinator.deleteProject('project-1')).resolves.toEqual({ status: 'deleted' })

    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(sessions.completeProjectSessionDeletion).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
  })

  it('retains the deletion intent when Review cleanup fails after the Project soft delete', async () => {
    const reviewFailures = [new Error('review unavailable'), undefined]
    let projectExists = true
    let intentExists = false
    const projects = createProjects()
    projects.exists = vi.fn(async () => projectExists)
    projects.delete = vi.fn(async () => {
      projectExists = false
      return undefined
    })
    projects.createDeletionIntent = vi.fn(async () => {
      intentExists = true
    })
    projects.deleteDeletionIntent = vi.fn(async () => {
      intentExists = false
    })
    projects.listDeletionIntents = vi.fn(async () => (intentExists ? ['project-1'] : []))
    const sessions = createSessions()
    const reviews = {
      deleteReviewsForProject: vi
        .fn()
        .mockImplementationOnce(async () => {
          if (reviewFailures[0]) throw reviewFailures[0]
        })
        .mockImplementationOnce(async () => {
          if (reviewFailures[1]) throw reviewFailures[1]
        })
    }
    const provenance = { deleteProjectProvenance: vi.fn().mockResolvedValue(undefined) }
    const completeProjectDeletion = vi.fn()
    const abortProjectDeletion = vi.fn()
    const events = { publish: vi.fn() }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      reviews,
      provenance,
      undefined,
      {
        beforeProjectDelete: vi.fn().mockResolvedValue(undefined),
        completeProjectDeletion,
        abortProjectDeletion
      },
      events
    )

    await expect(coordinator.deleteProject('project-1')).resolves.toEqual({
      status: 'cleanup-pending'
    })

    expect(projectExists).toBe(false)
    expect(intentExists).toBe(true)
    expect(reviews.deleteReviewsForProject).toHaveBeenCalledOnce()
    expect(provenance.deleteProjectProvenance).not.toHaveBeenCalled()
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()
    expect(completeProjectDeletion).not.toHaveBeenCalled()
    expect(abortProjectDeletion).not.toHaveBeenCalled()
    expect(events.publish).toHaveBeenCalledWith('project:deleted', {
      projectId: 'project-1',
      status: 'cleanup-pending'
    })

    await expect(coordinator.recoverPendingDeletions()).resolves.toBeUndefined()

    expect(reviews.deleteReviewsForProject).toHaveBeenCalledTimes(2)
    expect(provenance.deleteProjectProvenance).toHaveBeenCalledWith('project-1')
    expect(sessions.completeProjectSessionDeletion).toHaveBeenCalledWith('project-1')
    expect(intentExists).toBe(false)
    expect(completeProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(abortProjectDeletion).not.toHaveBeenCalled()
  })

  it('keeps the project row, intent, and fence when session cleanup fails', async () => {
    const projects = createProjects()
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('directory busy'))
    })
    const abortProjectDeletion = vi.fn()
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      undefined,
      undefined,
      undefined,
      {
        beforeProjectDelete: vi.fn().mockResolvedValue(undefined),
        abortProjectDeletion
      }
    )

    await expect(coordinator.deleteProject('project-1')).rejects.toThrow('directory busy')

    expect(projects.delete).not.toHaveBeenCalled()
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
    expect(abortProjectDeletion).not.toHaveBeenCalled()
  })

  it('keeps an online intent when Session authority committed before a derived failure', async () => {
    const projects = createProjects()
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('index unavailable')),
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('prepared')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.deleteProject('project-1')).rejects.toThrow('index unavailable')

    expect(projects.delete).not.toHaveBeenCalled()
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
  })

  it('replays durable deletion intents after a process restart', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = createSessions()
    const reviews = { deleteReviewsForProject: vi.fn().mockResolvedValue(undefined) }
    const restoreProjectDeletion = vi.fn().mockResolvedValue(undefined)
    const beforeProjectDelete = vi.fn().mockResolvedValue(undefined)
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      reviews,
      undefined,
      undefined,
      { restoreProjectDeletion, beforeProjectDelete }
    )

    await coordinator.recoverPendingDeletions()

    expect(restoreProjectDeletion).toHaveBeenCalledWith('project-1')
    expect(beforeProjectDelete).toHaveBeenCalledWith('project-1')
    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    expect(beforeProjectDelete.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessions.deleteProjectSessions).mock.invocationCallOrder[0]
    )
    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
    expect(reviews.deleteReviewsForProject).toHaveBeenCalledWith('project-1')
    expect(sessions.listLegacyProjectSessionTombstones).toHaveBeenCalledOnce()
  })

  it('restores local barriers for pending intents and legacy tombstones without running cleanup', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1', 'project-old'])
    const sessions = createSessions({
      listLegacyProjectSessionTombstones: vi
        .fn()
        .mockResolvedValue(['project-old', 'project-legacy'])
    })
    const restoreProjectDeletion = vi.fn().mockResolvedValue(undefined)
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      undefined,
      undefined,
      undefined,
      {
        beforeProjectDelete: vi.fn().mockResolvedValue(undefined),
        restoreProjectDeletion
      }
    )

    await coordinator.restorePendingDeletionBarriers()

    expect(restoreProjectDeletion.mock.calls).toEqual([
      ['project-1'],
      ['project-old'],
      ['project-legacy']
    ])
    expect(sessions.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('runs startup recovery in the background and retries a transient failure', async () => {
    vi.useFakeTimers()
    const recover = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('compute host offline'))
      .mockResolvedValueOnce(undefined)
    const onError = vi.fn()
    const recovery = new ProjectDeletionRecoveryLoop(recover, {
      retryDelayMs: 1_000,
      onError
    })

    expect(recovery.start()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)

    expect(recover).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'compute host offline' })
    )

    await vi.advanceTimersByTimeAsync(999)
    expect(recover).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(recover).toHaveBeenCalledTimes(2)

    await recovery.stop()
  })

  it('projects retry timing and failure counts per project without exposing errors', async () => {
    vi.useFakeTimers()
    const onStatusChanged = vi.fn()
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1', 'project-2'])
    const sessions = createSessions({
      deleteProjectSessions: vi.fn(async (projectId) => {
        if (projectId === 'project-1') {
          throw new Error('/Users/private/project cleanup failed')
        }
        return { status: 'completed' as const }
      })
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)
    const recovery = new ProjectDeletionRecoveryLoop(() => coordinator.recoverPendingDeletions(), {
      retryDelayMs: 1_000,
      now: () => 5_000,
      onStatusChanged
    })

    recovery.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(
      recovery.projectCleanup([
        { projectId: 'project-1', projectName: 'Research' },
        { projectId: 'project-2', projectName: 'Completed' },
        { projectId: 'project-new', projectName: 'New deletion' }
      ])
    ).toEqual([
      {
        projectId: 'project-1',
        projectName: 'Research',
        phase: 'retry-scheduled',
        failureCount: 1,
        nextRetryAt: 6_000
      },
      {
        projectId: 'project-2',
        projectName: 'Completed',
        phase: 'retry-scheduled',
        failureCount: 0,
        nextRetryAt: 6_000
      },
      {
        projectId: 'project-new',
        projectName: 'New deletion',
        phase: 'retry-scheduled',
        failureCount: 0,
        nextRetryAt: 6_000
      }
    ])
    expect(onStatusChanged).toHaveBeenCalledTimes(2)

    await recovery.stop()
  })

  it('lists pending cleanup and wakes the bound recovery loop on demand', async () => {
    const projects = createProjects()
    projects.listDeletionCleanupProjects = vi
      .fn()
      .mockResolvedValue([
        { projectId: 'project-1', projectName: 'Research' },
        { projectId: 'project-orphan' }
      ])
    const coordinator = new ProjectDeletionCoordinator(projects, createSessions())
    const recovery = new ProjectDeletionRecoveryLoop(vi.fn())
    const wake = vi.spyOn(recovery, 'wake')
    coordinator.setRecoveryLoop(recovery)

    await expect(coordinator.listDeletionCleanup()).resolves.toEqual([
      { projectId: 'project-1', projectName: 'Research', phase: 'running', failureCount: 0 },
      { projectId: 'project-orphan', phase: 'running', failureCount: 0 }
    ])
    coordinator.retryDeletionCleanup()

    expect(wake).toHaveBeenCalledOnce()
  })

  it('wakes background recovery after its successful startup run has completed', async () => {
    const recover = vi.fn().mockResolvedValue(undefined)
    const recovery = new ProjectDeletionRecoveryLoop(recover)

    recovery.start()
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())

    recovery.wake()
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2))

    await recovery.stop()
  })

  it('honors a manual retry queued while a failing recovery run is active', async () => {
    vi.useFakeTimers()
    const firstRun = createDeferred<void>()
    const secondRun = createDeferred<void>()
    const recover = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstRun.promise)
      .mockImplementationOnce(() => secondRun.promise)
    const recovery = new ProjectDeletionRecoveryLoop(recover, { retryDelayMs: 1_000 })

    recovery.start()
    await vi.advanceTimersByTimeAsync(0)
    recovery.wake()
    firstRun.reject(new Error('compute host offline'))
    await vi.advanceTimersByTimeAsync(0)

    expect(recover).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(recover).toHaveBeenCalledTimes(2)

    secondRun.resolve(undefined)
    await recovery.stop()
  })

  it('awaits active background recovery when stopping', async () => {
    const active = createDeferred<void>()
    const recover = vi.fn(() => active.promise)
    const recovery = new ProjectDeletionRecoveryLoop(recover)
    recovery.start()
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())

    let stopped = false
    const stopping = Promise.resolve(recovery.stop()).then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    active.resolve(undefined)
    await stopping
    expect(stopped).toBe(true)
  })

  it('adopts an orphaned legacy tombstone into an intent before preparing its Session authority', async () => {
    const order: string[] = []
    const projects = createProjects()
    projects.exists = vi.fn().mockResolvedValue(false)
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
    const coordinator = new ProjectDeletionCoordinator(projects, sessions, undefined, provenance)

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
    projects.exists = vi.fn().mockResolvedValue(false)
    const sessions = createSessions({
      listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue(['project-old']),
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('index temporarily unavailable'))
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow(
      'index temporarily unavailable'
    )

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-old')
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()
  })

  it('continues adopting unrelated legacy tombstones after one cleanup fails', async () => {
    const projects = createProjects()
    projects.exists = vi.fn().mockResolvedValue(false)
    const sessions = createSessions({
      listLegacyProjectSessionTombstones: vi
        .fn()
        .mockResolvedValue(['project-old-1', 'project-old-2']),
      deleteProjectSessions: vi.fn(async (projectId: string) => {
        if (projectId === 'project-old-1') throw new Error('index temporarily unavailable')
        return { status: 'completed' as const }
      })
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow(
      'index temporarily unavailable'
    )

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-old-1')
    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-old-2')
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalledWith('project-old-1')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-old-2')
  })

  it('drops the temporary intent and continues when an adopted orphan must be retained', async () => {
    const projects = createProjects()
    projects.exists = vi.fn().mockResolvedValue(false)
    const sessions = createSessions({
      listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue(['project-old']),
      deleteProjectSessions: vi.fn().mockResolvedValue({
        status: 'orphan-retained',
        reason: 'missing-upload-authority'
      })
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.recoverPendingDeletions()).resolves.toBeUndefined()

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-old')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-old')
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()
  })

  it('re-derives orphan authority policy when replaying an adopted intent after restart', async () => {
    const projects = createProjects()
    projects.exists = vi.fn().mockResolvedValue(false)
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-old'])
    const sessions = createSessions({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await coordinator.recoverPendingDeletions()

    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-old', {
      requireExistingUploadAuthority: true
    })
  })

  it('releases a replayed orphan-retained intent without adopting it twice in one recovery', async () => {
    const projects = createProjects()
    projects.exists = vi.fn().mockResolvedValue(false)
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-old'])
    const sessions = createSessions({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue(['project-old']),
      deleteProjectSessions: vi.fn().mockResolvedValue({
        status: 'orphan-retained',
        reason: 'missing-upload-authority'
      })
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.recoverPendingDeletions()).resolves.toBeUndefined()

    expect(sessions.deleteProjectSessions).toHaveBeenCalledOnce()
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-old')
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()
  })

  it('retains a failed recovery intent while continuing unrelated recovery', async () => {
    const projects = createProjects()
    const pendingIntents = new Set(['project-1', 'project-2'])
    projects.listDeletionIntents = vi.fn(async () => [...pendingIntents])
    projects.deleteDeletionIntent = vi.fn(async (projectId: string) => {
      pendingIntents.delete(projectId)
    })
    let projectOneAttempts = 0
    const sessions = createSessions({
      deleteProjectSessions: vi.fn(async (projectId: string) => {
        if (projectId === 'project-1' && projectOneAttempts++ === 0) {
          throw new Error('transient session cleanup failure')
        }
        return { status: 'completed' as const }
      })
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow(
      'transient session cleanup failure'
    )

    expect(sessions.deleteProjectSessions).toHaveBeenCalledTimes(2)
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalledWith('project-1')
    expect(projects.delete).not.toHaveBeenCalledWith('project-1')
    expect(projects.delete).toHaveBeenCalledWith('project-2')
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-2')

    await expect(coordinator.recoverPendingDeletions()).resolves.toBeUndefined()

    expect(sessions.deleteProjectSessions).toHaveBeenCalledTimes(3)
    expect(projects.deleteDeletionIntent).toHaveBeenCalledWith('project-1')
  })

  it('admits unrelated Project operations while keeping the failed Project closed', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('tail cleanup unavailable'))
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.waitForProjectOperations([])).resolves.toBeUndefined()
    await expect(coordinator.waitForProjectOperations(['project-2'])).resolves.toBeUndefined()
    await expect(coordinator.waitForProjectOperations(['project-1'])).rejects.toThrow(
      'tail cleanup unavailable'
    )
  })

  it('keeps infrastructure recovery failures global', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockRejectedValue(new Error('intent store unavailable'))
    const coordinator = new ProjectDeletionCoordinator(projects, createSessions())

    await expect(coordinator.waitForProjectOperations(['project-2'])).rejects.toThrow(
      'intent store unavailable'
    )
  })

  it('deletes an unrelated Project while another deletion tail remains failed', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = createSessions({
      deleteProjectSessions: vi.fn(async (projectId: string) => {
        if (projectId === 'project-1') throw new Error('tail cleanup unavailable')
        return { status: 'completed' as const }
      })
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.deleteProject('project-2')).resolves.toEqual({ status: 'deleted' })

    await expect(coordinator.waitForProjectOperations(['project-1'])).rejects.toThrow(
      'tail cleanup unavailable'
    )

    expect(projects.createDeletionIntent).toHaveBeenCalledWith('project-2')
    expect(projects.delete).toHaveBeenCalledWith('project-2')
    expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    expect(sessions.deleteProjectSessions).toHaveBeenCalledTimes(2)
  })

  it('keeps a committed recovery intent when the Project row still exists and replay fails', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('tail cleanup unavailable')),
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('prepared')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

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
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow(replayFailure.message)

    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
  })

  it('keeps a recovery intent when failed replay finds Session authority absent', async () => {
    const projects = createProjects()
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const sessions = createSessions({
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('session replay failed')),
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('absent')
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.recoverPendingDeletions()).rejects.toThrow('session replay failed')

    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
  })

  it('keeps the intent when committed Session tombstone cleanup fails', async () => {
    const projects = createProjects()
    const sessions = createSessions({
      completeProjectSessionDeletion: vi.fn().mockRejectedValue(new Error('tombstone busy'))
    })
    const coordinator = new ProjectDeletionCoordinator(projects, sessions)

    await expect(coordinator.deleteProject('project-1')).resolves.toEqual({
      status: 'cleanup-pending'
    })

    expect(projects.delete).toHaveBeenCalledWith('project-1')
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
  })

  it('retains the intent, tombstone, and fences when final runtime cleanup fails', async () => {
    let projectExists = true
    let intentExists = false
    const projects = createProjects()
    projects.exists = vi.fn(async () => projectExists)
    projects.delete = vi.fn(async () => {
      projectExists = false
      return undefined
    })
    projects.createDeletionIntent = vi.fn(async () => {
      intentExists = true
    })
    projects.deleteDeletionIntent = vi.fn(async () => {
      intentExists = false
    })
    projects.listDeletionIntents = vi.fn(async () => (intentExists ? ['project-1'] : []))
    const sessions = createSessions()
    const cleanupFailure = new Error('side chat profile busy')
    const finalizeProjectDeletion = vi
      .fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined)
    const completeProjectDeletion = vi.fn()
    const events = { publish: vi.fn() }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      sessions,
      undefined,
      undefined,
      undefined,
      {
        beforeProjectDelete: vi.fn().mockResolvedValue(undefined),
        finalizeProjectDeletion,
        completeProjectDeletion
      },
      events
    )

    await expect(coordinator.deleteProject('project-1')).resolves.toEqual({
      status: 'cleanup-pending'
    })

    expect(projectExists).toBe(false)
    expect(intentExists).toBe(true)
    expect(sessions.completeProjectSessionDeletion).not.toHaveBeenCalled()
    expect(projects.deleteDeletionIntent).not.toHaveBeenCalled()
    expect(completeProjectDeletion).not.toHaveBeenCalled()
    expect(events.publish).not.toHaveBeenCalledWith('project:deleted', {
      projectId: 'project-1',
      status: 'deleted'
    })

    await expect(coordinator.recoverPendingDeletions()).resolves.toBeUndefined()

    expect(finalizeProjectDeletion).toHaveBeenCalledTimes(2)
    expect(sessions.completeProjectSessionDeletion).toHaveBeenCalledWith('project-1')
    expect(intentExists).toBe(false)
    expect(completeProjectDeletion).toHaveBeenCalledWith('project-1')
  })

  it('publishes Project deletion when background recovery reaches the terminal state', async () => {
    const projects = createProjects()
    projects.exists = vi.fn().mockResolvedValue(false)
    projects.listDeletionIntents = vi.fn().mockResolvedValue(['project-1'])
    const events = { publish: vi.fn() }
    const coordinator = new ProjectDeletionCoordinator(
      projects,
      createSessions(),
      undefined,
      undefined,
      undefined,
      undefined,
      events
    )

    await coordinator.recoverPendingDeletions()

    expect(events.publish).toHaveBeenCalledWith('project:deleted', {
      projectId: 'project-1',
      status: 'deleted'
    })
    expect(events.publish).toHaveBeenCalledOnce()
  })

  it('keeps the recovery intent until derived project cleanup has finished', async () => {
    const order: string[] = []
    const projects = createProjects()
    projects.delete = vi.fn(async () => {
      order.push('project')
      return undefined
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
        deleteReviewsForProject: vi.fn(async () => {
          order.push('reviews')
        })
      },
      {
        deleteProjectProvenance: vi.fn(async () => {
          order.push('provenance')
        })
      },
      undefined,
      {
        beforeProjectDelete: vi.fn().mockResolvedValue(undefined),
        finalizeProjectDeletion: vi.fn(async () => {
          order.push('finalize')
        }),
        completeProjectDeletion: vi.fn(() => {
          order.push('complete')
        })
      }
    )

    await coordinator.deleteProject('project-1')

    expect(order).toEqual([
      'project',
      'reviews',
      'provenance',
      'finalize',
      'tombstone',
      'intent',
      'complete'
    ])
  })

  it('reuses a successful recovery gate for later operations', async () => {
    const projects = createProjects()
    const coordinator = new ProjectDeletionCoordinator(projects, createSessions())

    await coordinator.recoverPendingDeletions()
    await coordinator.recoverPendingDeletions()

    expect(projects.listDeletionIntents).toHaveBeenCalledOnce()
  })

  it('restores sticky recovery completion after deletion without suppressed failures', async () => {
    const projects = createProjects()
    const coordinator = new ProjectDeletionCoordinator(projects, createSessions())

    await coordinator.deleteProject('project-1')
    await coordinator.waitForProjectOperations([])

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
      })
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
    const coordinator = new ProjectDeletionCoordinator(createProjects(), sessions)
    await coordinator.recoverPendingDeletions()

    const firstDeletion = coordinator.deleteProject('project-1')
    const secondDeletion = coordinator.deleteProject('project-2')
    await vi.waitFor(() => {
      expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-1')
      expect(sessions.deleteProjectSessions).toHaveBeenCalledWith('project-2')
    })

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
  exists: vi.fn().mockResolvedValue(true),
  delete: vi.fn().mockResolvedValue(undefined),
  createDeletionIntent: vi.fn().mockResolvedValue(undefined),
  deleteDeletionIntent: vi.fn().mockResolvedValue(undefined),
  listDeletionIntents: vi.fn().mockResolvedValue([]),
  listDeletionCleanupProjects: vi.fn().mockResolvedValue([])
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

const createDeferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}
