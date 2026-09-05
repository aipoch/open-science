import { describe, expect, it, vi } from 'vitest'

import type { ArtifactProjectReconciliationSnapshot } from '../artifacts/provenance-repository'
import type {
  PersistedChatSession,
  SessionPlanRuntimeContext
} from '../../shared/session-persistence'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from './coordinator'

const createSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

const createPlan = (
  overrides: Partial<SessionPlanRuntimeContext> = {}
): SessionPlanRuntimeContext => ({
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  approval: 'pending',
  stepStatuses: {},
  ...overrides
})

const createDeferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createRepository = (
  initialSessions: PersistedChatSession[] = [createSession()],
  overrides: Partial<SessionMutationRepository> = {}
): { repository: SessionMutationRepository; sessions: Map<string, PersistedChatSession> } => {
  const sessions = new Map(
    initialSessions.map((session) => [session.id, structuredClone(session)] as const)
  )
  const repository: SessionMutationRepository = {
    loadAllWithDiagnostics: vi.fn(async () => ({
      result: {
        sessions: [...sessions.values()].map((session) => structuredClone(session)),
        manifest: { version: 1 as const }
      },
      isComplete: true
    })),
    loadProjectWithDiagnostics: vi.fn(async (projectId) => ({
      sessions: [...sessions.values()]
        .filter((session) => session.projectId === projectId)
        .map((session) => structuredClone(session)),
      isComplete: true
    })),
    loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
      sessions: [],
      isComplete: true
    })),
    loadSessionWithDiagnostics: vi.fn(async (_projectId, sessionId) => {
      const session = sessions.get(sessionId)
      return session
        ? { status: 'found' as const, session: structuredClone(session) }
        : { status: 'missing' as const }
    }),
    assertSessionIdentityOwnership: vi.fn(async () => undefined),
    saveSession: vi.fn(async (session) => {
      sessions.set(session.id, structuredClone(session))
    }),
    saveCommittedProjectSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async (_projectId, sessionId) => {
      sessions.delete(sessionId)
    }),
    deleteProjectSessions: vi.fn(async (projectId) => {
      for (const [sessionId, session] of sessions) {
        if (session.projectId === projectId) sessions.delete(sessionId)
      }
    }),
    getProjectSessionDeletionState: vi.fn(async () => 'live' as const),
    markCommittedProjectSessionsPrepared: vi.fn(async () => undefined),
    completeProjectSessionDeletion: vi.fn(async () => undefined),
    listLegacyProjectSessionTombstones: vi.fn(async () => []),
    saveManifest: vi.fn(async () => undefined),
    ...overrides
  }
  return { repository, sessions }
}

const createFileIndex = (overrides: Partial<SessionFileIndex> = {}): SessionFileIndex => ({
  syncSession: vi.fn(async () => []),
  softDeleteSession: vi.fn(async () => 'session-delete-token'),
  restoreSession: vi.fn(async () => undefined),
  softDeleteProject: vi.fn(async () => 'project-delete-token'),
  reconcileActiveSessions: vi.fn(async () => undefined),
  markReconciliationIncomplete: vi.fn(),
  ...overrides,
  reconcileProjectSessions: overrides.reconcileProjectSessions ?? vi.fn(async () => undefined)
})

describe('SessionPersistenceCoordinator contracts', () => {
  it('keeps scoped lanes failure-tolerant and snapshots behind a global barrier', async () => {
    const gate = createDeferred()
    const order: string[] = []
    const { repository } = createRepository()
    repository.saveManifest = vi.fn(async () => {
      order.push('manifest')
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const mutation = coordinator.runSessionMutation('project-1', 'session-1', async () => {
      order.push('mutation:start')
      await gate.promise
      order.push('mutation:end')
    })
    const manifest = coordinator.saveManifest({ lastSessionId: 'session-1' })
    const snapshot = coordinator.sessionMetadataSnapshot().then((value) => {
      order.push('snapshot')
      return value
    })

    await vi.waitFor(() => expect(order).toEqual(['mutation:start', 'manifest']))
    gate.resolve()
    await expect(mutation).resolves.toBeUndefined()
    await expect(manifest).resolves.toBeUndefined()
    await expect(snapshot).resolves.toEqual({ sessions: [], isComplete: false })
    expect(order).toEqual(['mutation:start', 'manifest', 'mutation:end', 'snapshot'])

    await expect(
      coordinator.runSessionMutation('project-1', 'session-1', async () => {
        throw new Error('isolated failure')
      })
    ).rejects.toThrow('isolated failure')
    await expect(
      coordinator.runSessionMutation('project-1', 'session-1', async () => {
        order.push('mutation:recovered')
      })
    ).resolves.toBeUndefined()
    await expect(coordinator.saveManifest({ lastSessionId: undefined })).resolves.toBeUndefined()
    expect(order.slice(-2)).toEqual(['mutation:recovered', 'manifest'])
    expect(repository.saveManifest).toHaveBeenCalledTimes(2)
  })

  it('does not let a blocked Project mutation stall an independent Project', async () => {
    const projectOneGate = createDeferred()
    const projectTwoStarted = createDeferred()
    const { repository } = createRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const projectOne = coordinator.runSessionMutation('project-1', 'session-1', async () => {
      await projectOneGate.promise
    })
    const projectTwo = coordinator.runSessionMutation('project-2', 'session-2', async () => {
      projectTwoStarted.resolve()
    })

    const outcome = await Promise.race([
      projectTwoStarted.promise.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50))
    ])
    projectOneGate.resolve()
    await Promise.all([projectOne, projectTwo])

    expect(outcome).toBe('started')
  })

  it('keeps one Session identity owner while different Projects save concurrently', async () => {
    const firstWriteGate = createDeferred()
    const firstWriteStarted = createDeferred()
    const { repository, sessions } = createRepository([])
    repository.saveSession = vi.fn(async (session) => {
      if (session.projectId === 'project-1') {
        firstWriteStarted.resolve()
        await firstWriteGate.promise
      }
      sessions.set(session.id, structuredClone(session))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const first = coordinator.saveSession(
      createSession({ id: 'shared-session', projectId: 'project-1' })
    )
    await firstWriteStarted.promise

    const conflicting = coordinator.saveSession(
      createSession({ id: 'shared-session', projectId: 'project-2' })
    )
    firstWriteGate.resolve()
    await expect(first).resolves.toMatchObject({ projectId: 'project-1' })
    await expect(conflicting).rejects.toThrow(/already owned by another Project/)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('holds deleted Session identities until Project cleanup finishes', async () => {
    const projectCleanupGate = createDeferred()
    const projectCleanupStarted = createDeferred()
    const reusedSessionSaveStarted = createDeferred()
    const { repository, sessions } = createRepository([
      createSession({ id: 'shared-session', projectId: 'project-1' })
    ])
    repository.saveSession = vi.fn(async (session) => {
      reusedSessionSaveStarted.resolve()
      sessions.set(session.id, structuredClone(session))
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({
        softDeleteProject: vi.fn(async () => {
          projectCleanupStarted.resolve()
          await projectCleanupGate.promise
          return 'project-delete-token'
        })
      })
    )
    await coordinator.loadAll()
    vi.mocked(repository.loadProjectWithDiagnostics).mockResolvedValueOnce({
      sessions: [],
      isComplete: false
    })

    const deletion = coordinator.deleteProjectSessions('project-1')
    await projectCleanupStarted.promise
    const reuse = coordinator.saveSession(
      createSession({ id: 'shared-session', projectId: 'project-2' })
    )
    const outcome = await Promise.race([
      reusedSessionSaveStarted.promise.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50))
    ])

    expect(outcome).toBe('blocked')
    projectCleanupGate.resolve()
    await expect(deletion).resolves.toEqual({ status: 'completed' })
    await expect(reuse).resolves.toMatchObject({
      id: 'shared-session',
      projectId: 'project-2'
    })
  })

  it('holds legacy Project Session identities while upload deletion authority is prepared', async () => {
    const uploadPreparationGate = createDeferred()
    const uploadPreparationStarted = createDeferred()
    const reusedSessionSaveStarted = createDeferred()
    const committedSession = createSession({
      id: 'shared-session',
      projectId: 'project-1'
    })
    const { repository, sessions } = createRepository([], {
      getProjectSessionDeletionState: vi.fn(async () => 'legacy-committed' as const),
      loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
        sessions: [structuredClone(committedSession)],
        isComplete: true
      }))
    })
    repository.saveSession = vi.fn(async (session) => {
      reusedSessionSaveStarted.resolve()
      sessions.set(session.id, structuredClone(session))
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      {
        upgradeLegacySessionUploads: vi.fn(async (session) => {
          if (session.projectId === 'project-1') {
            uploadPreparationStarted.resolve()
            await uploadPreparationGate.promise
          }
          return session
        })
      }
    )

    const deletion = coordinator.deleteProjectSessions('project-1')
    await uploadPreparationStarted.promise
    const reuse = coordinator.saveSession(
      createSession({ id: 'shared-session', projectId: 'project-2' })
    )
    const outcome = await Promise.race([
      reusedSessionSaveStarted.promise.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50))
    ])

    expect(outcome).toBe('blocked')
    uploadPreparationGate.resolve()
    await expect(deletion).resolves.toEqual({ status: 'completed' })
    await expect(reuse).resolves.toMatchObject({
      id: 'shared-session',
      projectId: 'project-2'
    })
  })

  it('runs post-delete catalog reconciliation behind a global barrier', async () => {
    const reconciliationGate = createDeferred()
    const reconciliationStarted = createDeferred()
    const independentSaveStarted = createDeferred()
    const { repository, sessions } = createRepository([
      createSession({ id: 'deleted-session', projectId: 'project-1' })
    ])
    repository.saveSession = vi.fn(async (session) => {
      independentSaveStarted.resolve()
      sessions.set(session.id, structuredClone(session))
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({
        reconcileActiveSessions: vi.fn(async () => {
          reconciliationStarted.resolve()
          await reconciliationGate.promise
        })
      })
    )

    const deletion = coordinator.deleteSession('project-1', 'deleted-session')
    await reconciliationStarted.promise
    const independentSave = coordinator.saveSession(
      createSession({ id: 'new-session', projectId: 'project-2' })
    )
    const outcome = await Promise.race([
      independentSaveStarted.promise.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50))
    ])

    expect(outcome).toBe('blocked')
    reconciliationGate.resolve()
    await expect(deletion).resolves.toBeUndefined()
    await expect(independentSave).resolves.toMatchObject({
      id: 'new-session',
      projectId: 'project-2'
    })
  })

  it('publishes metadata only from queued durable state and marks degraded projections incomplete', async () => {
    const { repository } = createRepository()
    const syncSession = vi.fn(async () => [])
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ syncSession })
    )

    await coordinator.loadAll()
    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Session' }],
      isComplete: true
    })

    await coordinator.saveSession(createSession({ title: 'Renamed' }))
    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Renamed' }],
      isComplete: true
    })

    syncSession.mockRejectedValueOnce(new Error('index unavailable'))
    await expect(
      coordinator.saveSession(createSession({ title: 'Durable but unindexed', updatedAt: 3 }))
    ).rejects.toThrow('index unavailable')
    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Durable but unindexed' }],
      isComplete: false
    })
  })

  it('keeps runtime context as revisioned main-owned authority across renderer saves', async () => {
    const { repository, sessions } = createRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const command = {
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 0,
      patch: { plan: createPlan() }
    } as const

    await expect(coordinator.patchSessionRuntimeContext(command)).resolves.toEqual({
      version: 1,
      revision: 1,
      plan: createPlan()
    })
    await expect(coordinator.patchSessionRuntimeContext(command)).rejects.toMatchObject({
      code: 'revision-conflict',
      expectedRevision: 0,
      actualRevision: 1
    })

    const staleRendererSession = createSession({
      title: 'Renderer rename',
      status: 'idle',
      runtimeContext: undefined,
      updatedAt: 4
    })
    await expect(coordinator.saveSession(staleRendererSession)).resolves.toMatchObject({
      title: 'Renderer rename',
      runtimeContext: { version: 1, revision: 1, plan: createPlan() }
    })
    expect(sessions.get('session-1')).toMatchObject({
      title: 'Renderer rename',
      runtimeContext: { version: 1, revision: 1, plan: createPlan() }
    })
  })

  it('applies optimistic archive checks before changing durable Session visibility', async () => {
    const { repository, sessions } = createRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const archived = await coordinator.updateArchive({
      projectId: 'project-1',
      sessionId: 'session-1',
      archived: true,
      expectedArchivedAt: null
    })
    expect(archived.archivedAt).toEqual(expect.any(Number))

    await expect(
      coordinator.updateArchive({
        projectId: 'project-1',
        sessionId: 'session-1',
        archived: false,
        expectedArchivedAt: null
      })
    ).rejects.toThrow('Session archive state changed elsewhere.')

    const running = createSession({ id: 'session-2', status: 'running' })
    sessions.set(running.id, running)
    await expect(
      coordinator.updateArchive({
        projectId: 'project-1',
        sessionId: 'session-2',
        archived: true,
        expectedArchivedAt: null
      })
    ).rejects.toThrow('Finish or stop this session before archiving.')
  })

  it('keeps successful deletion tombstones authoritative and clears failed attempts', async () => {
    const enteredDelete = createDeferred()
    const releaseDelete = createDeferred()
    const { repository, sessions } = createRepository()
    repository.deleteSession = vi.fn(async (_projectId, sessionId) => {
      enteredDelete.resolve()
      await releaseDelete.promise
      sessions.delete(sessionId)
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const deletion = coordinator.deleteSession('project-1', 'session-1')
    await enteredDelete.promise
    const lateSave = coordinator.saveSession(createSession({ title: 'Late save' }))
    releaseDelete.resolve()

    await expect(deletion).resolves.toBeUndefined()
    await expect(lateSave).rejects.toThrow('Cannot save a session that has been deleted.')
    await expect(
      coordinator.runSessionMutation('project-1', 'session-1', async () => 'revived')
    ).rejects.toThrow('Cannot mutate a session that has been deleted.')
    expect(sessions.has('session-1')).toBe(false)

    const failed = createRepository()
    failed.repository.deleteSession = vi.fn(async () => {
      throw new Error('disk locked')
    })
    const retryable = new SessionPersistenceCoordinator(failed.repository, createFileIndex())
    await expect(retryable.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')
    await expect(
      retryable.saveSession(createSession({ title: 'Retry remains live' }))
    ).resolves.toMatchObject({
      title: 'Retry remains live'
    })
  })

  it('reconciles authorities before derived indexes and limits destructive work to startup', async () => {
    const sessions = [createSession(), createSession({ id: 'session-2', projectId: 'project-2' })]
    const order: string[] = []
    const { repository } = createRepository(sessions)
    repository.loadAllWithDiagnostics = vi.fn(async () => {
      order.push('load')
      return {
        result: { sessions: structuredClone(sessions), manifest: { version: 1 as const } },
        isComplete: true
      }
    })
    const deletionHandlers = {
      commit: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => {
        order.push('unread')
      })
    }
    const permissionGrants = {
      reconcileSessions: vi.fn(async () => {
        order.push('permission')
      })
    }
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (session: PersistedChatSession) => {
        order.push(`upload:${session.id}`)
        return session
      })
    }
    const provenance = {
      validateFinalizedMessageBindings: vi.fn(async () => undefined),
      captureFinalizedMessages: vi.fn(async () => undefined),
      reconcileSessionDeletions: vi.fn(async () => {
        order.push('provenance')
      }),
      reconcileSessionCleanup: vi.fn(async () => {
        order.push('provenance:cleanup')
      }),
      reconcileMessageSnapshots: vi.fn(async () => {
        order.push('provenance:snapshots')
      }),
      prepareSessionDeletion: vi.fn(async (session: PersistedChatSession) => ({
        kind: 'ordinary' as const,
        projectId: session.projectId,
        sessionId: session.id
      })),
      completeSessionDeletion: vi.fn(async () => undefined),
      abortSessionDeletion: vi.fn(async () => undefined)
    }
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn(async (projectId: string) => {
        order.push(`artifact-project:${projectId}`)
        return {} as ArtifactProjectReconciliationSnapshot
      }),
      reconcileSession: vi.fn(async (_projectId: string, sessionId: string) => {
        order.push(`artifact-session:${sessionId}`)
        return { recoveredMessageArtifacts: [] }
      })
    }
    const fileIndex = createFileIndex({
      reconcileActiveSessions: vi.fn(async () => {
        order.push('files:reconcile')
      }),
      syncSession: vi.fn(async (session) => {
        order.push(`files:sync:${session.id}`)
        return []
      })
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance,
      uploads,
      artifactStorage,
      permissionGrants
    )
    coordinator.setSessionDeletionHandlers(deletionHandlers)

    await coordinator.loadAll()
    expect(order).toEqual([
      'load',
      'unread',
      'permission',
      'provenance:cleanup',
      'upload:session-1',
      'upload:session-2',
      'artifact-project:project-1',
      'artifact-project:project-2',
      'artifact-session:session-1',
      'artifact-session:session-2',
      'provenance:snapshots',
      'files:reconcile',
      'files:sync:session-1',
      'files:sync:session-2'
    ])
    expect(artifactStorage.reconcileSession).toHaveBeenNthCalledWith(
      1,
      'project-1',
      'session-1',
      expect.any(Object),
      expect.objectContaining({ removeOrphanStaging: true })
    )

    order.length = 0
    await coordinator.loadAll()
    expect(permissionGrants.reconcileSessions).toHaveBeenCalledOnce()
    expect(artifactStorage.reconcileSession).toHaveBeenLastCalledWith(
      'project-2',
      'session-2',
      expect.any(Object),
      expect.objectContaining({ removeOrphanStaging: false })
    )
  })

  it('runs independent Provenance cleanup before fallible Artifact recovery', async () => {
    const session = createSession()
    const { repository } = createRepository([session])
    const reconcileSessionCleanup = vi.fn(async () => undefined)
    const reconcileMessageSnapshots = vi.fn(async () => undefined)
    const provenance = {
      validateFinalizedMessageBindings: vi.fn(async () => undefined),
      captureFinalizedMessages: vi.fn(async () => undefined),
      reconcileSessionDeletions: vi.fn(async () => undefined),
      reconcileSessionCleanup,
      reconcileMessageSnapshots,
      prepareSessionDeletion: vi.fn(async () => ({
        kind: 'ordinary' as const,
        projectId: session.projectId,
        sessionId: session.id
      })),
      completeSessionDeletion: vi.fn(async () => undefined),
      abortSessionDeletion: vi.fn(async () => undefined)
    }
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn(async () => {
        throw new Error('artifact recovery failed')
      }),
      reconcileSession: vi.fn(async () => ({ recoveredMessageArtifacts: [] }))
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance,
      undefined,
      artifactStorage
    )

    await coordinator.loadAll()

    expect(reconcileSessionCleanup).toHaveBeenCalledOnce()
    expect(reconcileSessionCleanup).toHaveBeenCalledWith([session])
    expect(reconcileMessageSnapshots).not.toHaveBeenCalled()
  })
})
