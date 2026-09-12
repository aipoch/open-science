import { describe, expect, it, vi } from 'vitest'

import { ArchiveCoordinator } from './coordinator'

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 2
}

const session = {
  id: 'session-1',
  projectId: project.id,
  title: 'Session',
  cwd: '/workspace',
  status: 'idle' as const,
  messages: [],
  createdAt: 1,
  updatedAt: 2
}

describe('ArchiveCoordinator', () => {
  it.each(['session', 'project'] as const)(
    'drains background checks on %s archive before admitting more work',
    async (scope) => {
      let finish!: () => void
      const waiting = new Promise<void>((resolve) => {
        finish = resolve
      })
      let projectArchived = false
      let sessionArchived = false
      const stop = vi.fn(async () => waiting)
      const coordinator = new ArchiveCoordinator(
        {
          get: async () => ({ ...project, ...(projectArchived ? { archivedAt: 50 } : {}) }),
          updateArchive: async () => {
            projectArchived = true
            return { ...project, archivedAt: 50 }
          }
        },
        {
          assertProjectArchivable: async () => [session.id],
          sessionProjectId: async () => project.id,
          assertSessionAvailable: async () => {
            if (sessionArchived) throw new Error('Session archived')
          },
          updateArchive: async () => {
            sessionArchived = true
            return { ...session, archivedAt: 50 }
          }
        },
        {
          isSessionBusy: () => false,
          isProjectBusy: () => false,
          liveSessionProjectId: () => project.id
        },
        {
          cancelSession: stop,
          cancelProject: stop
        }
      )
      const archived =
        scope === 'session'
          ? coordinator.updateSessionArchive({
              projectId: project.id,
              sessionId: session.id,
              archived: true,
              expectedRevision: 0
            })
          : coordinator.updateProjectArchive({
              id: project.id,
              archived: true,
              expectedArchiveRevision: 0
            })
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
      const start = vi.fn(async () => undefined)
      const admission = coordinator.withSessionAvailable(project.id, session.id, start)
      const rejection = expect(admission).rejects.toThrow()
      await Promise.resolve()
      expect(start).not.toHaveBeenCalled()
      finish()
      await archived
      await rejection
      expect(start).not.toHaveBeenCalled()
      expect(stop).toHaveBeenCalledWith(
        ...(scope === 'session' ? [project.id, session.id] : [project.id])
      )
    }
  )

  it('retains the durable archive and retries a failed background cleanup', async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error('worker remains'))
      .mockResolvedValue(undefined)
    let archivedAt: number | undefined
    const coordinator = new ArchiveCoordinator(
      {
        get: async () => ({ ...project, archivedAt, archiveRevision: archivedAt ? 1 : 0 }),
        updateArchive: async () => {
          archivedAt = 50
          return { ...project, archivedAt }
        }
      },
      {
        assertProjectArchivable: async () => [session.id],
        assertSessionAvailable: vi.fn(),
        sessionProjectId: async () => project.id,
        updateArchive: vi.fn()
      },
      {
        isSessionBusy: () => false,
        isProjectBusy: () => false,
        liveSessionProjectId: () => project.id
      },
      { cancelProject: stop, cancelSession: vi.fn() }
    )
    await expect(
      coordinator.updateProjectArchive({
        id: project.id,
        archived: true,
        expectedArchiveRevision: 0
      })
    ).rejects.toThrow('worker remains')
    await expect(
      coordinator.withSessionAvailable(project.id, session.id, vi.fn())
    ).rejects.toThrow()
    await coordinator.updateProjectArchive({
      id: project.id,
      archived: true,
      expectedArchiveRevision: 1
    })
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it.each(['export', 'import'] as const)(
    'cancels queued %s admission without installing a late reservation',
    async (kind) => {
      const coordinator = new ArchiveCoordinator(
        { get: async () => project, updateArchive: vi.fn() },
        {
          assertProjectArchivable: vi.fn(),
          assertSessionAvailable: vi.fn(),
          updateArchive: vi.fn(),
          sessionProjectId: async () => project.id
        },
        {
          isSessionBusy: () => false,
          isProjectBusy: () => false,
          liveSessionProjectId: () => project.id
        }
      )
      let unblock!: () => void
      let started!: () => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const blocked = coordinator.withProjectAvailable(project.id, () => {
        started()
        return new Promise<void>((resolve) => {
          unblock = resolve
        })
      })
      await entered
      const controller = new AbortController()
      const assertIdle = vi.fn(async () => undefined)
      const reservation =
        kind === 'export'
          ? coordinator.reserveSessionExport(project.id, session.id, assertIdle, controller.signal)
          : coordinator.reserveProjectImport(project.id, controller.signal)
      const rejected = vi.fn()
      const settled = reservation.then((release) => release(), rejected)
      const reason = new Error('Cancel package admission')
      controller.abort(reason)
      const laterWork = vi.fn(async () => undefined)
      const later = coordinator.withProjectAvailable(project.id, laterWork)
      try {
        await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(reason))
        expect(laterWork).not.toHaveBeenCalled()
      } finally {
        unblock()
        await blocked
        await settled
        await later
      }
      expect(laterWork).toHaveBeenCalledOnce()
      expect(assertIdle).not.toHaveBeenCalled()
      expect(coordinator.isSessionExporting(project.id, session.id)).toBe(false)
      const remove = vi.fn(async () => undefined)
      await coordinator.withProjectDeletion(project.id, remove)
      expect(remove).toHaveBeenCalledOnce()
    }
  )

  it('keeps existing Sessions available while import fences Project deletion', async () => {
    const coordinator = new ArchiveCoordinator(
      { get: async () => project, updateArchive: vi.fn() },
      {
        assertProjectArchivable: vi.fn(),
        assertSessionAvailable: vi.fn(),
        updateArchive: vi.fn(),
        sessionProjectId: async () => project.id
      },
      {
        isSessionBusy: () => false,
        isProjectBusy: () => false,
        liveSessionProjectId: () => project.id
      }
    )
    const release = await coordinator.reserveProjectImport(project.id)
    await expect(
      coordinator.assertSessionAvailable(project.id, session.id)
    ).resolves.toBeUndefined()
    const remove = vi.fn(async () => undefined)
    await expect(coordinator.withProjectDeletion(project.id, remove)).rejects.toThrow('import')
    expect(remove).not.toHaveBeenCalled()
    expect(() => coordinator.restoreProjectDeletion(project.id)).toThrow('import')
    release()
    release()
    await coordinator.withProjectDeletion(project.id, remove)
    expect(remove).toHaveBeenCalledOnce()
  })
  it.each(['sync', 'async'] as const)(
    'reserves idle export with %s activity before prompt admission and rejects deletion before installing its fence',
    async (activity) => {
      const coordinator = new ArchiveCoordinator(
        { get: async () => project, updateArchive: vi.fn() },
        {
          assertProjectArchivable: vi.fn(),
          assertSessionAvailable: vi.fn(),
          updateArchive: vi.fn(),
          sessionProjectId: async () => project.id
        },
        {
          isSessionBusy: () => (activity === 'async' ? Promise.resolve(false) : false),
          isProjectBusy: () => false,
          liveSessionProjectId: () => project.id
        }
      )
      const release = await coordinator.reserveSessionExport(
        project.id,
        session.id,
        async () => undefined
      )
      const dispatch = vi.fn(async () => undefined)
      await expect(
        coordinator.withSessionDeletionAdmissionById(session.id, dispatch)
      ).rejects.toThrow('locked')
      expect(dispatch).not.toHaveBeenCalled()
      expect(() => coordinator.restoreProjectDeletion(project.id)).toThrow('export')
      await expect(coordinator.assertProjectAvailable(project.id)).resolves.toBeUndefined()
      release()
      await coordinator.withSessionDeletionAdmissionById(session.id, dispatch)
      expect(dispatch).toHaveBeenCalledOnce()
    }
  )

  it.each(['idle', 'busy', 'failed'] as const)(
    'fences new work during asynchronous activity checks and releases an %s result',
    async (result) => {
      let finish!: (busy: boolean) => void
      let fail!: (error: Error) => void
      let checking!: () => void
      const started = new Promise<void>((resolve) => {
        checking = resolve
      })
      const activity = new Promise<boolean>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
      const coordinator = new ArchiveCoordinator(
        { get: async () => project, updateArchive: vi.fn() },
        {
          assertProjectArchivable: vi.fn(),
          assertSessionAvailable: vi.fn(),
          updateArchive: vi.fn(),
          sessionProjectId: async () => project.id
        },
        {
          isSessionBusy: () => {
            checking()
            return activity
          },
          isProjectBusy: () => false,
          liveSessionProjectId: () => project.id
        }
      )
      const reserve = coordinator.reserveSessionExport(
        project.id,
        session.id,
        async () => undefined
      )
      await started
      expect(() => coordinator.admitSessionWork(project.id, session.id)).toThrow('locked')
      if (result === 'failed') fail(new Error('Activity lookup failed'))
      else finish(result === 'busy')
      if (result === 'idle') {
        const release = await reserve
        expect(() => coordinator.admitSessionWork(project.id, session.id)).toThrow('locked')
        release()
      } else {
        await expect(reserve).rejects.toThrow(result === 'busy' ? 'idle' : 'Activity lookup failed')
      }
      const releaseWork = coordinator.admitSessionWork(project.id, session.id)
      releaseWork()
    }
  )

  it('rejects export while an admitted dispatch has not settled', async () => {
    const coordinator = new ArchiveCoordinator(
      { get: async () => project, updateArchive: vi.fn() },
      {
        assertProjectArchivable: vi.fn(),
        assertSessionAvailable: vi.fn(),
        updateArchive: vi.fn(),
        sessionProjectId: async () => project.id
      },
      {
        isSessionBusy: () => false,
        isProjectBusy: () => false,
        liveSessionProjectId: () => project.id
      }
    )
    let finish!: () => void
    let started!: () => void
    const admitted = new Promise<void>((resolve) => {
      started = resolve
    })
    const work = new Promise<void>((resolve) => {
      finish = resolve
    })
    const dispatch = coordinator.withSessionDeletionAdmissionById(session.id, () => {
      started()
      return work
    })
    await admitted
    await expect(
      coordinator.reserveSessionExport(project.id, session.id, async () => undefined)
    ).rejects.toThrow('idle')
    finish()
    await dispatch
    const release = await coordinator.reserveSessionExport(
      project.id,
      session.id,
      async () => undefined
    )
    release()
  })

  it('archives a project only after the complete idle child catalog is checked', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn().mockResolvedValue({ ...project, archivedAt: 50 })
    }
    const sessions = {
      assertProjectArchivable: vi.fn().mockResolvedValue([session.id]),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })
    const markRead = vi.fn().mockResolvedValue(undefined)
    coordinator.setMarkReadSessions(markRead)

    await expect(
      coordinator.updateProjectArchive({
        id: project.id,
        archived: true,
        expectedArchiveRevision: 0
      })
    ).resolves.toMatchObject({ archivedAt: 50 })

    expect(sessions.assertProjectArchivable).toHaveBeenCalledWith(project.id, expect.any(Function))
    expect(projects.updateArchive).toHaveBeenCalledWith(
      { id: project.id, archived: true, expectedArchiveRevision: 0 },
      expect.any(Number)
    )
    expect(markRead).toHaveBeenCalledWith([session.id])
  })

  it('rejects an archive request whose compare-and-set value is stale', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue({ ...project, archivedAt: 40, archiveRevision: 1 }),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })

    await expect(
      coordinator.updateProjectArchive({
        id: project.id,
        archived: false,
        expectedArchiveRevision: 0
      })
    ).rejects.toThrow('Project archive state changed elsewhere.')

    expect(projects.updateArchive).not.toHaveBeenCalled()
  })

  it('does not restore a session while its project remains archived', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue({ ...project, archivedAt: 40, archiveRevision: 1 }),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })

    await expect(
      coordinator.updateSessionArchive({
        projectId: project.id,
        sessionId: session.id,
        archived: false,
        expectedRevision: 0
      })
    ).rejects.toThrow('Restore this archived Project before continuing.')

    expect(sessions.assertSessionAvailable).not.toHaveBeenCalled()
  })

  it('rejects a known session addressed through another project', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(project.id)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })

    await expect(coordinator.assertSessionAvailable('other-project', session.id)).rejects.toThrow(
      'Session does not belong to the requested Project.'
    )

    expect(sessions.assertSessionAvailable).not.toHaveBeenCalled()
  })

  it('keeps archive updates behind an admitted session operation', async () => {
    let markStarted!: () => void
    let releaseOperation!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn().mockResolvedValue(undefined),
      updateArchive: vi.fn().mockResolvedValue({ ...session, archivedAt: 50 }),
      sessionProjectId: vi.fn().mockResolvedValue(project.id)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn().mockReturnValue(false),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })

    const admitted = coordinator.withSessionAvailable(project.id, session.id, async () => {
      markStarted()
      await operationGate
      return 'resumed'
    })
    await started

    const archive = coordinator.updateSessionArchive({
      projectId: project.id,
      sessionId: session.id,
      archived: true,
      expectedRevision: 0
    })
    await Promise.resolve()
    expect(sessions.updateArchive).not.toHaveBeenCalled()

    releaseOperation()
    await expect(admitted).resolves.toBe('resumed')
    await expect(archive).resolves.toMatchObject({ archivedAt: 50 })
  })

  it('rejects a Session archive while its runtime activity is still busy', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(
        async (_request: unknown, isRuntimeBusy: () => boolean): Promise<typeof session> => {
          if (isRuntimeBusy()) throw new Error('Finish or stop this session before archiving.')
          return session
        }
      ),
      sessionProjectId: vi.fn()
    }
    const runtime = {
      isSessionBusy: vi.fn().mockReturnValue(true),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, runtime)

    await expect(
      coordinator.updateSessionArchive({
        projectId: project.id,
        sessionId: session.id,
        archived: true,
        expectedRevision: 0
      })
    ).rejects.toThrow('Finish or stop this session before archiving.')

    expect(runtime.isSessionBusy).toHaveBeenCalledWith(project.id, session.id)
  })

  it('rejects a project archive while a fresh live session is running', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn().mockReturnValue(true),
      liveSessionProjectId: vi.fn()
    })

    await expect(
      coordinator.updateProjectArchive({
        id: project.id,
        archived: true,
        expectedArchiveRevision: 0
      })
    ).rejects.toThrow('Finish or stop active sessions before archiving this project.')

    expect(sessions.assertProjectArchivable).not.toHaveBeenCalled()
    expect(projects.updateArchive).not.toHaveBeenCalled()
  })

  it('waits for asynchronous Project activity before archiving', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn().mockResolvedValue({ ...project, archivedAt: 40 })
    }
    const sessions = {
      assertProjectArchivable: vi.fn().mockResolvedValue([]),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn().mockResolvedValue(false),
      liveSessionProjectId: vi.fn()
    })

    await expect(
      coordinator.updateProjectArchive({
        id: project.id,
        archived: true,
        expectedArchiveRevision: 0
      })
    ).resolves.toMatchObject({ archivedAt: 40 })

    expect(projects.updateArchive).toHaveBeenCalledOnce()
  })

  it('resolves a fresh live session owner before archive admission', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue({ ...project, archivedAt: 40, archiveRevision: 1 }),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn().mockReturnValue(project.id)
    })

    await expect(coordinator.assertSessionAvailableById(session.id)).rejects.toThrow(
      'Restore this archived Project before continuing.'
    )
    expect(sessions.assertSessionAvailable).not.toHaveBeenCalled()
  })

  it('runs an id-only operation inside archive admission', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn().mockResolvedValue(undefined),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(project.id)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })
    const operation = vi.fn().mockResolvedValue('resumed')

    await expect(coordinator.withSessionAvailableById(session.id, operation)).resolves.toBe(
      'resumed'
    )

    expect(sessions.assertSessionAvailable).toHaveBeenCalledWith(project.id, session.id)
    expect(operation).toHaveBeenCalledWith(project.id)
  })

  it('fails closed when a session owner cannot be resolved', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn().mockReturnValue(undefined)
    })

    await expect(coordinator.assertSessionAvailableById(session.id)).rejects.toThrow(
      'Cannot use a Session whose Project owner is unavailable.'
    )
    expect(sessions.assertSessionAvailable).not.toHaveBeenCalled()
  })

  it('establishes a Project deletion fence after admitted Session work drains', async () => {
    const admitted = createDeferred<void>()
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn().mockResolvedValue(undefined),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(project.id)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })
    const quiesce = vi.fn().mockResolvedValue(undefined)

    const existing = coordinator.withSessionAvailable(
      project.id,
      session.id,
      () => admitted.promise
    )
    await vi.waitFor(() => expect(sessions.assertSessionAvailable).toHaveBeenCalledOnce())
    const deletion = coordinator.withProjectDeletion(project.id, quiesce)
    await Promise.resolve()

    expect(quiesce).not.toHaveBeenCalled()
    admitted.resolve(undefined)
    await existing
    await deletion

    expect(quiesce).toHaveBeenCalledOnce()
    await expect(coordinator.assertProjectAvailable(project.id)).rejects.toThrow(
      'Project is being deleted.'
    )
    const blockedDispatch = vi.fn().mockResolvedValue(undefined)
    await expect(
      coordinator.withSessionDeletionAdmissionById(session.id, blockedDispatch)
    ).rejects.toThrow('Project is being deleted.')
    expect(blockedDispatch).not.toHaveBeenCalled()
    coordinator.releaseProjectDeletion(project.id)
    await expect(coordinator.assertProjectAvailable(project.id)).resolves.toBeUndefined()
  })

  it('retains and re-enters a Project deletion fence after teardown fails', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn().mockResolvedValue(undefined),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(project.id)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })
    const failedTeardown = vi.fn().mockRejectedValue(new Error('runtime cleanup failed'))

    await expect(coordinator.withProjectDeletion(project.id, failedTeardown)).rejects.toThrow(
      'runtime cleanup failed'
    )
    await expect(coordinator.assertProjectAvailable(project.id)).rejects.toThrow(
      'Project is being deleted.'
    )

    const retry = vi.fn().mockResolvedValue(undefined)
    await expect(coordinator.withProjectDeletion(project.id, retry)).resolves.toBeUndefined()
    expect(retry).toHaveBeenCalledOnce()

    coordinator.releaseProjectDeletion(project.id)
    await expect(coordinator.assertProjectAvailable(project.id)).resolves.toBeUndefined()
  })

  it('keeps an unrelated Project available while deletion quiescence is in flight', async () => {
    const deletionGate = createDeferred<void>()
    const projects = {
      get: vi.fn(async (projectId: string) => ({ ...project, id: projectId })),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })
    const quiesce = vi.fn(() => deletionGate.promise)

    const deletion = coordinator.withProjectDeletion(project.id, quiesce)
    await vi.waitFor(() => expect(quiesce).toHaveBeenCalledOnce())

    const unrelatedOperation = vi.fn().mockResolvedValue('available')
    const unrelated = coordinator.withProjectAvailable('project-2', unrelatedOperation)
    await flushMicrotasks()
    const wasAdmittedDuringDeletion = unrelatedOperation.mock.calls.length === 1

    deletionGate.resolve(undefined)
    await expect(deletion).resolves.toBeUndefined()
    await expect(unrelated).resolves.toBe('available')
    expect(wasAdmittedDuringDeletion).toBe(true)
  })

  it('releases admission after prompt dispatch starts without awaiting prompt completion', async () => {
    const prompt = createDeferred<string>()
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn().mockResolvedValue(undefined),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(project.id)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })
    const dispatch = vi.fn(() => prompt.promise)
    const quiesce = vi.fn().mockResolvedValue(undefined)

    const prompting = coordinator.withSessionDeletionAdmissionById(session.id, dispatch)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    await coordinator.withProjectDeletion(project.id, quiesce)

    expect(quiesce).toHaveBeenCalledOnce()
    prompt.resolve('complete')
    await expect(prompting).resolves.toBe('complete')
  })

  it('drains an admitted Project continuation before establishing its deletion fence', async () => {
    const continuation = createDeferred<string>()
    const projects = {
      get: vi.fn().mockResolvedValue(project),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn()
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn()
    })
    const deliver = vi.fn(() => continuation.promise)
    const quiesce = vi.fn().mockResolvedValue(undefined)

    const delivering = coordinator.withProjectDeletionAdmission(project.id, deliver)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
    const deletion = coordinator.withProjectDeletion(project.id, quiesce)
    await Promise.resolve()

    expect(quiesce).not.toHaveBeenCalled()
    continuation.resolve('accepted')
    await expect(delivering).resolves.toBe('accepted')
    await deletion

    expect(quiesce).toHaveBeenCalledOnce()
    const lateDelivery = vi.fn().mockResolvedValue('accepted')
    await expect(
      coordinator.withProjectDeletionAdmission(project.id, lateDelivery)
    ).rejects.toThrow('Project is being deleted.')
    expect(lateDelivery).not.toHaveBeenCalled()
  })

  it('allows deletion-only dispatch admission for a non-Project runtime', async () => {
    const projects = {
      get: vi.fn(),
      updateArchive: vi.fn()
    }
    const sessions = {
      assertProjectArchivable: vi.fn(),
      assertSessionAvailable: vi.fn(),
      updateArchive: vi.fn(),
      sessionProjectId: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new ArchiveCoordinator(projects, sessions, {
      isSessionBusy: vi.fn(),
      isProjectBusy: vi.fn(),
      liveSessionProjectId: vi.fn().mockReturnValue(undefined)
    })
    const dispatch = vi.fn().mockResolvedValue('reviewed')

    await expect(
      coordinator.withSessionDeletionAdmissionById('reviewer-session', dispatch)
    ).resolves.toBe('reviewed')

    expect(dispatch).toHaveBeenCalledOnce()
    expect(projects.get).not.toHaveBeenCalled()
  })
})

const createDeferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
