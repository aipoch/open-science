import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { ArchiveCoordinator, type SessionRuntimeActivity } from '../archive/coordinator'
import type { Project, UpdateProjectArchiveRequest } from '../../shared/projects'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'

import type { ArtifactProjectReconciliationSnapshot } from '../artifacts/provenance-repository'
import { EnabledComputeHostsRegistry } from '../compute/enabled-hosts-registry'
import { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import type {
  PersistedChatSession,
  UpdateSessionArchiveRequest,
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
  it.each(
    (['read', 'write', 'delete'] as const).flatMap((operation) =>
      [false, true].map((withGlobalBarrier) => ({ operation, withGlobalBarrier }))
    )
  )(
    'rejects Project deletion without stalling a $operation queued during scanning (global barrier: $withGlobalBarrier)',
    async ({ operation, withGlobalBarrier }) => {
      const scanStarted = createDeferred()
      const scanGate = createDeferred()
      const session = createSession()
      const { repository, sessions } = createRepository([session])
      vi.mocked(repository.loadProjectWithDiagnostics).mockImplementationOnce(async () => {
        scanStarted.resolve()
        await scanGate.promise
        return { sessions: [session], isComplete: true }
      })
      const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

      const deletion = coordinator.deleteProjectSessions(session.projectId)
      await scanStarted.promise
      const successor =
        operation === 'read'
          ? coordinator.readSessionRuntimeContext(session.projectId, session.id)
          : operation === 'write'
            ? coordinator.saveSession(session)
            : coordinator.deleteSession(session.projectId, session.id)
      // Observe the successor without leaving a rejection unhandled during the checkpoint.
      const successorResult = Promise.allSettled([successor])
      const independent = coordinator.saveSession(
        createSession({ id: 'session-2', projectId: 'project-2' })
      )
      const snapshot = withGlobalBarrier ? coordinator.sessionMetadataSnapshot() : undefined
      const later = coordinator.runSessionMutation('project-2', 'session-2', async () => 'later')
      let allSettled = false
      void Promise.allSettled([deletion, successor, independent, snapshot, later]).then(() => {
        allSettled = true
      })

      await setImmediate()
      expect(
        vi.mocked(repository.saveSession).mock.calls.some(([saved]) => saved.id === 'session-2')
      ).toBe(true)
      expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
      scanGate.resolve()
      // All fixture I/O is Promise-based. One event-loop turn drains runnable work; a dependency
      // cycle leaves these operations unsettled. Fail on that behavior, not a test timeout.
      await setImmediate()
      expect(allSettled).toBe(true)
      expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
      await expect(deletion).rejects.toThrow(
        'Session identity reservation conflicted with a later operation. Retry the operation.'
      )
      const [result] = await successorResult
      expect(result.status).toBe('fulfilled')
      if (operation === 'read') {
        expect(result).toMatchObject({ value: { version: 1 } })
      } else if (operation === 'write') {
        expect(result).toMatchObject({ value: { id: session.id } })
      } else {
        expect(result).toEqual({ status: 'fulfilled', value: undefined })
      }
      await expect(independent).resolves.toMatchObject({ id: 'session-2' })
      if (snapshot)
        await expect(snapshot).resolves.toMatchObject({
          sessions: expect.arrayContaining([
            { id: 'session-2', projectId: 'project-2', title: 'Session' }
          ])
        })
      await expect(later).resolves.toBe('later')
      expect(sessions.has(session.id)).toBe(operation !== 'delete')
      expect(sessions.has('session-2')).toBe(true)
      const retry = coordinator.deleteProjectSessions(session.projectId)
      let retrySettled = false
      void Promise.allSettled([retry]).then(() => {
        retrySettled = true
      })
      await setImmediate()
      expect(retrySettled).toBe(true)
      await expect(retry).resolves.toEqual({ status: 'completed' })
      expect(sessions.has(session.id)).toBe(false)
    }
  )

  it('finishes deletion cleanup while another Project changes Compute Host access', async () => {
    const scanStarted = createDeferred()
    const scanGate = createDeferred()
    const session = createSession()
    const other = createSession({ id: 'session-2', projectId: 'project-2' })
    const { repository } = createRepository([session, other])
    vi.mocked(repository.loadProjectWithDiagnostics).mockImplementationOnce(async () => {
      scanStarted.resolve()
      await scanGate.promise
      return { sessions: [session], isComplete: true }
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const hosts = new SessionEnabledComputeHostsOwner({
      registry: new EnabledComputeHostsRegistry(),
      hostExists: async () => true,
      listHostIds: async () => [],
      sessionAuthority: coordinator,
      withDataRootWrite: (operation) => operation()
    })
    coordinator.setSessionDeletionHandlers({
      commit: (sessionIds) => hosts.clear(sessionIds),
      reconcile: async () => undefined
    })
    await coordinator.loadAll()
    const deletion = coordinator.deleteProjectSessions(session.projectId)
    await scanStarted.promise
    const update = hosts.setHostEnabled(other.id, 'ssh:host', false)
    await setImmediate()
    let allSettled = false
    const completion = Promise.allSettled([deletion, update])
    void completion.then(() => {
      allSettled = true
    })
    scanGate.resolve()
    await setImmediate()
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith(session.projectId)
    expect(allSettled).toBe(true)
    expect((await completion).every((result) => result.status === 'fulfilled')).toBe(true)
  })

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
    repository.saveSession = vi.fn(async (session) => {
      const next = { ...session, revision: (sessions.get(session.id)?.revision ?? 0) + 1 }
      sessions.set(session.id, next)
      return next
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const archived = await coordinator.updateArchive({
      projectId: 'project-1',
      sessionId: 'session-1',
      archived: true,
      expectedRevision: 0
    })
    expect(archived.archivedAt).toEqual(expect.any(Number))

    await expect(
      coordinator.updateArchive({
        projectId: 'project-1',
        sessionId: 'session-1',
        archived: false,
        expectedRevision: 0
      })
    ).rejects.toThrow('Session revision conflict')

    const running = createSession({ id: 'session-2', status: 'running' })
    sessions.set(running.id, running)
    await expect(
      coordinator.updateArchive({
        projectId: 'project-1',
        sessionId: 'session-2',
        archived: true,
        expectedRevision: 0
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

// Execute the composition root's real activity adapter. Importing ipc.ts would boot Electron and
// unrelated application modules; this test-only extraction keeps its wiring observable without a
// production seam or a duplicate implementation of the archive policy.
const archiveRuntime = (
  jobs: {
    countNonTerminalBySession: (sessionId: string) => Promise<number>
    findNonTerminal: () => Promise<{ project_id: string }[]>
  },
  detect: () => { projectId: string; sessionId: string }[] = () => []
): SessionRuntimeActivity => {
  const source = ts.createSourceFile(
    'ipc.ts',
    readFileSync(new URL('../ipc.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true
  )
  let runtime: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'ArchiveCoordinator') {
      runtime = node.arguments?.[2]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!runtime) throw new Error('ArchiveCoordinator runtime wiring was not found')
  const script = ts.transpileModule(`return (${runtime.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(
    'sideChatOwnerRef',
    'detectArchiveBlockingSessions',
    'reviewerProjectRuntime',
    'computeJobActivityRef',
    'runtimeRef',
    script
  )({}, detect, { isProjectBusy: () => false }, { current: jobs }, {})
}

const createArchiveHarness = (
  runtime?: SessionRuntimeActivity
): {
  coordinator: ArchiveCoordinator
  sessions: Map<string, PersistedChatSession>
  projects: { get(): Promise<Project> }
  repository: SessionMutationRepository
} => {
  const { repository, sessions } = createRepository([createSession({ revision: 1 })])
  // Model the repository's existing durable revision advancement, including archive writes.
  repository.saveSession = vi.fn(async (next) => {
    const persisted = { ...next, revision: (sessions.get(next.id)?.revision ?? 0) + 1 }
    sessions.set(next.id, structuredClone(persisted))
    return persisted
  })
  const persistence = new SessionPersistenceCoordinator(repository, createFileIndex())
  let project: Project = {
    id: 'project-1',
    name: 'Project',
    description: '',
    isExample: false,
    createdAt: 1,
    updatedAt: 2
  }
  const projects = {
    get: vi.fn(async () => ({ ...project })),
    updateArchive: vi.fn(async (request: UpdateProjectArchiveRequest, archivedAt: number) => {
      if ((project.archiveRevision ?? 0) !== request.expectedArchiveRevision) {
        throw new Error('Project archive state changed elsewhere.')
      }
      project = {
        ...project,
        archivedAt: request.archived ? archivedAt : undefined,
        archiveRevision: (project.archiveRevision ?? 0) + 1
      }
      return { ...project }
    })
  }
  const coordinator = new ArchiveCoordinator(
    projects,
    persistence,
    runtime ?? {
      isSessionBusy: () => false,
      isProjectBusy: () => false,
      liveSessionProjectId: () => 'project-1'
    }
  )
  return { coordinator, sessions, projects, repository }
}

const sessionArchiveRequest = (
  archived: boolean,
  expectedRevision: number
): UpdateSessionArchiveRequest => ({
  projectId: 'project-1',
  sessionId: 'session-1',
  archived,
  expectedRevision
})

describe('archive admission regressions', () => {
  it.each(['queued', 'submitted', 'running'])(
    'rejects an idle Session with a %s Compute Job through the real IPC activity adapter',
    async (status) => {
      const job = { session_id: 'session-1', project_id: 'project-1', status }
      const jobs = {
        countNonTerminalBySession: vi.fn(async (id: string) => (id === job.session_id ? 1 : 0)),
        findNonTerminal: vi.fn(async () => [job])
      }
      const { coordinator, repository } = createArchiveHarness(archiveRuntime(jobs))
      await expect(
        coordinator.updateProjectArchive({
          id: 'project-1',
          archived: true,
          expectedArchiveRevision: 0
        })
      ).rejects.toThrow('Finish or stop active sessions')
      await expect(
        coordinator.updateSessionArchive(sessionArchiveRequest(true, 1))
      ).rejects.toThrow('Finish or stop')
      expect(repository.saveSession).not.toHaveBeenCalled()
      expect(jobs.countNonTerminalBySession).toHaveBeenCalledWith('session-1')
    }
  )

  it('fails closed when the Session Compute Job query rejects', async () => {
    const jobs = {
      countNonTerminalBySession: vi.fn().mockRejectedValue(new Error('Job database unavailable')),
      findNonTerminal: vi.fn().mockResolvedValue([])
    }
    const { coordinator, repository } = createArchiveHarness(archiveRuntime(jobs))
    await expect(coordinator.updateSessionArchive(sessionArchiveRequest(true, 1))).rejects.toThrow(
      'Job database unavailable'
    )
    expect(repository.saveSession).not.toHaveBeenCalled()
  })

  it('waits for the Session Compute Job query before persisting archive state', async () => {
    const gate = createDeferred<number>()
    const jobs = {
      countNonTerminalBySession: vi.fn(() => gate.promise),
      findNonTerminal: vi.fn().mockResolvedValue([])
    }
    const { coordinator, repository } = createArchiveHarness(archiveRuntime(jobs))
    const outcome = coordinator.updateSessionArchive(sessionArchiveRequest(true, 1)).then(
      () => 'archived',
      () => 'rejected'
    )
    // Drain local I/O/microtasks without depending on a wall-clock timeout or a sleep duration.
    await setImmediate()
    const writesBeforeQueryCompleted = vi.mocked(repository.saveSession).mock.calls.length
    gate.resolve(1)
    const result = await outcome
    expect(writesBeforeQueryCompleted).toBe(0)
    expect(result).toBe('rejected')
    expect(jobs.countNonTerminalBySession).toHaveBeenCalledWith('session-1')
  })

  it('rechecks runtime activity after the asynchronous Compute Job query', async () => {
    const gate = createDeferred<number>()
    let running = false
    const jobs = {
      countNonTerminalBySession: vi.fn(() => gate.promise),
      findNonTerminal: vi.fn().mockResolvedValue([])
    }
    const { coordinator, repository } = createArchiveHarness(
      archiveRuntime(jobs, () =>
        running ? [{ projectId: 'project-1', sessionId: 'session-1' }] : []
      )
    )
    const result = coordinator.updateSessionArchive(sessionArchiveRequest(true, 1))
    const rejected = expect(result).rejects.toThrow('Finish or stop')
    await setImmediate()
    running = true
    gate.resolve(0)
    await rejected
    expect(repository.saveSession).not.toHaveBeenCalled()
  })

  it.each(['success', 'failed', 'timeout', 'error', 'another Session'])(
    'allows Session archive when the only Compute Job is %s',
    async (status) => {
      const jobs = {
        countNonTerminalBySession: vi.fn(async (id: string) =>
          status === 'another Session' && id === 'session-2' ? 1 : 0
        ),
        findNonTerminal: vi.fn(async () =>
          status === 'another Session' ? [{ project_id: 'project-1' }] : []
        )
      }
      const { coordinator } = createArchiveHarness(archiveRuntime(jobs))
      await expect(
        coordinator.updateSessionArchive(sessionArchiveRequest(true, 1))
      ).resolves.toMatchObject({ archivedAt: expect.any(Number), updatedAt: 2 })
    }
  )

  it.each(['Project', 'Session'] as const)(
    'rejects a delayed %s archive created before another window archives and restores',
    async (target) => {
      const { coordinator, sessions, projects } = createArchiveHarness()
      const update = (
        archived: boolean,
        expectedRevision: number
      ): Promise<Project | PersistedChatSession> =>
        target === 'Project'
          ? coordinator.updateProjectArchive({
              id: 'project-1',
              archived,
              expectedArchiveRevision: expectedRevision
            })
          : coordinator.updateSessionArchive(sessionArchiveRequest(archived, expectedRevision))
      // Window A captures its command now but sends it only after Window B's round trip.
      const initialRevision = target === 'Project' ? 0 : 1
      const delayed = (): Promise<Project | PersistedChatSession> => update(true, initialRevision)
      await update(true, initialRevision)
      await update(false, initialRevision + 1)
      expect((await projects.get()).updatedAt).toBe(2)
      expect(sessions.get('session-1')?.updatedAt).toBe(2)
      if (target === 'Session') expect(sessions.get('session-1')?.revision).toBe(3)
      await expect(delayed()).rejects.toThrow(/changed elsewhere|revision/i)
    }
  )

  it.each(['Project', 'Session'] as const)(
    'rejects an old %s Undo when two archives use the same millisecond',
    async (target) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
      try {
        const { coordinator } = createArchiveHarness()
        const update = (
          archived: boolean,
          expectedRevision: number
        ): Promise<Project | PersistedChatSession> =>
          target === 'Project'
            ? coordinator.updateProjectArchive({
                id: 'project-1',
                archived,
                expectedArchiveRevision: expectedRevision
              })
            : coordinator.updateSessionArchive(sessionArchiveRequest(archived, expectedRevision))
        const initialRevision = target === 'Project' ? 0 : 1
        const first = await update(true, initialRevision)
        await update(false, initialRevision + 1)
        const second = await update(true, initialRevision + 2)
        expect(second.archivedAt).toBe(first.archivedAt)
        await expect(update(false, initialRevision + 1)).rejects.toThrow(
          /changed elsewhere|revision/i
        )
      } finally {
        clock.mockRestore()
      }
    }
  )
})
