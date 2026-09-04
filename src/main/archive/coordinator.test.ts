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
      coordinator.updateProjectArchive({ id: project.id, archived: true, expectedArchivedAt: null })
    ).resolves.toMatchObject({ archivedAt: 50 })

    expect(sessions.assertProjectArchivable).toHaveBeenCalledWith(project.id, expect.any(Function))
    expect(projects.updateArchive).toHaveBeenCalledWith(
      { id: project.id, archived: true, expectedArchivedAt: null },
      expect.any(Number)
    )
    expect(markRead).toHaveBeenCalledWith([session.id])
  })

  it('rejects an archive request whose compare-and-set value is stale', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue({ ...project, archivedAt: 40 }),
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
      coordinator.updateProjectArchive({ id: project.id, archived: false, expectedArchivedAt: 39 })
    ).rejects.toThrow('Project archive state changed elsewhere.')

    expect(projects.updateArchive).not.toHaveBeenCalled()
  })

  it('does not restore a session while its project remains archived', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue({ ...project, archivedAt: 40 }),
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
        expectedArchivedAt: 40
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
      expectedArchivedAt: null
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
        expectedArchivedAt: null
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
      coordinator.updateProjectArchive({ id: project.id, archived: true, expectedArchivedAt: null })
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
      coordinator.updateProjectArchive({ id: project.id, archived: true, expectedArchivedAt: null })
    ).resolves.toMatchObject({ archivedAt: 40 })

    expect(projects.updateArchive).toHaveBeenCalledOnce()
  })

  it('resolves a fresh live session owner before archive admission', async () => {
    const projects = {
      get: vi.fn().mockResolvedValue({ ...project, archivedAt: 40 }),
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
