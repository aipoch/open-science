import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { Logger } from '../logger'
import type { ReviewRepository } from '../reviewer/repository'

const { broadcastLifecycleEvent, getLifecycleClientId, ipcHandlers, registrationFailure } =
  vi.hoisted(() => ({
    broadcastLifecycleEvent: vi.fn(),
    getLifecycleClientId: vi.fn(
      (event: { sender: { id: number } }) => `electron:${event.sender.id}`
    ),
    ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    registrationFailure: {
      channel: undefined as string | undefined,
      error: undefined as Error | undefined
    }
  }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      if (registrationFailure.channel === channel) throw registrationFailure.error
      ipcHandlers.set(channel, handler)
    }
  }
}))
vi.mock('../lifecycle-broadcast', () => ({
  broadcastLifecycleEvent,
  getLifecycleClientId
}))

import {
  createSessionPersistenceHandlers,
  loadSessionMetadataAfterProjectRecovery,
  loadSessionsAfterProjectRecovery,
  registerSessionPersistenceIpcHandlers,
  type SessionPersistenceBackend,
  type SessionPersistenceHandlers
} from './ipc'
import { beginMigration, clearMigrationPending } from '../storage/migration-state'

beforeEach(() => {
  ipcHandlers.clear()
  broadcastLifecycleEvent.mockClear()
  getLifecycleClientId.mockClear()
  registrationFailure.channel = undefined
  registrationFailure.error = undefined
})
afterEach(() => clearMigrationPending())

const createSession = (): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Session',
  cwd: '/workspace/project',
  status: 'idle',
  messages: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000
})

// Minimal mock review repository that satisfies the cascade contract.
const createMockReviewRepository = (): ReviewRepository =>
  ({
    deleteReviewsForSession: vi.fn().mockResolvedValue(undefined),
    deleteReviewsForProject: vi.fn().mockResolvedValue(undefined)
  }) as unknown as ReviewRepository

describe('session persistence IPC handlers', () => {
  it('reads cached Session metadata only after Project deletion recovery', async () => {
    const order: string[] = []
    const projectRecovery = {
      recoverPendingDeletions: vi.fn(async () => {
        order.push('recovery')
      })
    }
    const snapshot = {
      sessions: [{ id: 'session-1', projectId: 'project-a', title: 'Session' }],
      isComplete: true
    }
    const sessionLoader = {
      sessionMetadataSnapshot: vi.fn(async () => {
        order.push('snapshot')
        return snapshot
      })
    }

    await expect(
      loadSessionMetadataAfterProjectRecovery(projectRecovery, sessionLoader)
    ).resolves.toBe(snapshot)
    expect(order).toEqual(['recovery', 'snapshot'])
  })

  it('does not expose cached Session metadata when Project deletion recovery fails', async () => {
    const failure = new Error('Project deletion recovery failed')
    const projectRecovery = {
      recoverPendingDeletions: vi.fn().mockRejectedValue(failure)
    }
    const sessionLoader = { sessionMetadataSnapshot: vi.fn() }

    await expect(
      loadSessionMetadataAfterProjectRecovery(projectRecovery, sessionLoader)
    ).rejects.toBe(failure)
    expect(sessionLoader.sessionMetadataSnapshot).not.toHaveBeenCalled()
  })

  it('hydrates a read-only Session snapshot when Project deletion recovery fails', async () => {
    const failure = new Error('Project deletion journal is locked at /private/sessions')
    const warn = vi.fn<Logger['warn']>()
    const degraded = {
      sessions: [createSession()],
      manifest: { version: 1 as const },
      diagnostics: {
        isComplete: false,
        warnings: [],
        failure: 'startup-reconciliation-failed' as const
      }
    }
    const projectRecovery = {
      recoverPendingDeletions: vi.fn().mockRejectedValue(failure)
    }
    const sessionLoader = {
      loadAll: vi.fn(),
      loadAllReadOnly: vi.fn().mockResolvedValue(degraded)
    }

    await expect(
      loadSessionsAfterProjectRecovery(projectRecovery, sessionLoader, { warn })
    ).resolves.toEqual({
      ...degraded,
      diagnostics: {
        ...degraded.diagnostics,
        isProjectDeletionRecoveryComplete: false
      }
    })

    expect(sessionLoader.loadAll).not.toHaveBeenCalled()
    expect(sessionLoader.loadAllReadOnly).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('project deletion recovery failed', {
      operation: 'session-hydration',
      phase: 'recover-project-deletions',
      outcome: 'degraded',
      errorCategory: 'error'
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('journal is locked')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/sessions')
  })

  it('runs ordinary startup loading after Project deletion recovery succeeds', async () => {
    const loaded = { sessions: [createSession()], manifest: { version: 1 as const } }
    const projectRecovery = {
      recoverPendingDeletions: vi.fn().mockResolvedValue(undefined)
    }
    const sessionLoader = {
      loadAll: vi.fn().mockResolvedValue(loaded),
      loadAllReadOnly: vi.fn()
    }

    await expect(loadSessionsAfterProjectRecovery(projectRecovery, sessionLoader)).resolves.toEqual(
      {
        ...loaded,
        diagnostics: {
          isComplete: true,
          warnings: [],
          isProjectDeletionRecoveryComplete: true
        }
      }
    )

    expect(projectRecovery.recoverPendingDeletions).toHaveBeenCalledOnce()
    expect(sessionLoader.loadAll).toHaveBeenCalledOnce()
    expect(sessionLoader.loadAllReadOnly).not.toHaveBeenCalled()
  })

  it('does not accept a physical managed-file cleanup hook', () => {
    // Session persistence owns authoritative JSON and index visibility only. Keeping the factory at
    // two parameters prevents deletion flows from acquiring a dependency that can remove file bytes.
    expectTypeOf<Parameters<typeof createSessionPersistenceHandlers>>().toEqualTypeOf<
      [repository: SessionPersistenceBackend, reviewRepository: ReviewRepository]
    >()
  })

  it('routes each command to the repository', async () => {
    const session = createSession()
    const loadResult = { sessions: [session], manifest: { version: 1 as const } }
    const repository = {
      loadAll: vi.fn().mockResolvedValue(loadResult),
      loadOne: vi.fn().mockResolvedValue(session),
      saveSession: vi.fn().mockResolvedValue({ created: false, session }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = createMockReviewRepository()
    const handlers = createSessionPersistenceHandlers(repository, reviewRepository)

    expect(handlers).not.toHaveProperty('deleteProjectSessions')

    await expect(handlers.loadAll()).resolves.toBe(loadResult)
    await expect(
      handlers.loadOne({ projectId: 'project-a', sessionId: 'session-1' })
    ).resolves.toBe(session)
    expect(repository.loadOne).toHaveBeenCalledWith({
      projectId: 'project-a',
      sessionId: 'session-1'
    })

    await handlers.saveSession(session)
    expect(repository.saveSession).toHaveBeenCalledWith(session)

    const saveOptions = { conflictRebaseFields: ['title' as const] }
    await handlers.saveSession(session, saveOptions)
    expect(repository.saveSession).toHaveBeenLastCalledWith(session, saveOptions)

    await handlers.deleteSession({ projectId: 'project-a', sessionId: 'session-1' })
    expect(repository.deleteSession).toHaveBeenCalledWith('project-a', 'session-1')
    // Reviews are retained for Artifact Provenance after the session transcript is deleted.
    expect(reviewRepository.deleteReviewsForSession).not.toHaveBeenCalled()

    await handlers.saveManifest({ lastProjectId: 'project-a', lastSessionId: 'session-1' })
    expect(repository.saveManifest).toHaveBeenCalledWith({
      lastProjectId: 'project-a',
      lastSessionId: 'session-1'
    })
  })

  it('does not report a successful session deletion when the repository fails', async () => {
    const repository = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      loadOne: vi.fn(),
      saveSession: vi.fn().mockResolvedValue({ created: false, session: createSession() }),
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('repository failed')),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const handlers = createSessionPersistenceHandlers(repository, createMockReviewRepository())

    await expect(
      handlers.deleteSession({ projectId: 'project-a', sessionId: 'session-1' })
    ).rejects.toThrow('repository failed')

    repository.deleteSession.mockResolvedValueOnce(undefined)
    await expect(
      handlers.deleteSession({ projectId: 'project-a', sessionId: 'session-1' })
    ).resolves.toBeUndefined()
  })

  it('retains session review rows after the authoritative session deletion succeeds', async () => {
    const order: string[] = []
    const repository = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      loadOne: vi.fn(),
      saveSession: vi.fn().mockResolvedValue({ created: false, session: createSession() }),
      deleteSession: vi.fn(async () => {
        order.push('session')
      }),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = createMockReviewRepository()
    vi.mocked(reviewRepository.deleteReviewsForSession).mockImplementation(async () => {
      order.push('reviews')
    })
    const handlers = createSessionPersistenceHandlers(repository, reviewRepository)

    await handlers.deleteSession({ projectId: 'project-a', sessionId: 'session-1' })

    expect(order).toEqual(['session'])
  })

  it('registers each persistence channel and forwards renderer requests', async () => {
    const session = createSession()
    const durableSession = {
      ...session,
      title: 'Durable projection',
      messages: [
        {
          id: 'message-1',
          role: 'user' as const,
          content: 'Legacy upload',
          status: 'complete' as const,
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              versionId: 'upload-version-1',
              versionNumber: 1,
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              size: 11,
              sha256: 'a'.repeat(64)
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
    const loadResult = { sessions: [session], manifest: { version: 1 as const } }
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn().mockResolvedValue(loadResult),
      loadOne: vi.fn().mockResolvedValue(durableSession),
      saveSession: vi
        .fn()
        .mockResolvedValueOnce({ created: true, session: durableSession })
        .mockResolvedValueOnce({ created: false, session: durableSession }),
      updateArchive: vi.fn().mockResolvedValue({ ...durableSession, archivedAt: 3 }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = createMockReviewRepository()
    registerSessionPersistenceIpcHandlers(repository, reviewRepository)

    expect([...ipcHandlers.keys()]).toEqual([
      'sessions:load-all',
      'sessions:load-one',
      'sessions:save-session',
      'sessions:update-archive',
      'sessions:delete-session',
      'sessions:save-manifest'
    ])

    const deleteRequest = { projectId: 'project-a', sessionId: 'session-1' }
    const archiveRequest = {
      projectId: 'project-a',
      sessionId: 'session-1',
      archived: true,
      expectedArchivedAt: null
    }
    const manifestRequest = { lastProjectId: 'project-a', lastSessionId: 'session-1' }
    const event = { sender: { id: 2 } }
    await expect(ipcHandlers.get('sessions:load-all')?.()).resolves.toBe(loadResult)
    await expect(ipcHandlers.get('sessions:load-one')?.(event, deleteRequest)).resolves.toBe(
      durableSession
    )
    await expect(ipcHandlers.get('sessions:save-session')?.(event, session)).resolves.toBe(
      durableSession
    )
    const updatedSession = { ...session, title: 'Updated session', updatedAt: 1710000000001 }
    await ipcHandlers.get('sessions:save-session')?.(event, updatedSession)
    await ipcHandlers.get('sessions:update-archive')?.(event, archiveRequest)
    await ipcHandlers.get('sessions:delete-session')?.(event, deleteRequest)
    await ipcHandlers.get('sessions:save-manifest')?.(undefined, manifestRequest)

    expect(repository.saveSession).toHaveBeenCalledWith(session)
    expect(repository.loadOne).toHaveBeenCalledWith(deleteRequest)
    expect(repository.updateArchive).toHaveBeenCalledWith(archiveRequest)
    expect(repository.deleteSession).toHaveBeenCalledWith('project-a', 'session-1')
    expect(reviewRepository.deleteReviewsForSession).not.toHaveBeenCalled()
    expect(repository.saveManifest).toHaveBeenCalledWith(manifestRequest)
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('session:created', {
      session: durableSession,
      originClientId: 'electron:2'
    })
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('session:updated', {
      session: durableSession,
      originClientId: 'electron:2'
    })
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('session:updated', {
      session: { ...durableSession, archivedAt: 3 },
      originClientId: 'electron:2'
    })
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('session:deleted', deleteRequest)
  })

  it('dispatches through the injected application handler identity', async () => {
    const loadResult = { sessions: [createSession()], manifest: { version: 1 as const } }
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn(),
      loadOne: vi.fn(),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      saveManifest: vi.fn()
    }
    const injected: SessionPersistenceHandlers = {
      loadAll: vi.fn().mockResolvedValue(loadResult),
      loadOne: vi.fn(),
      saveSession: vi.fn(),
      updateArchive: vi.fn(),
      deleteSession: vi.fn(),
      saveManifest: vi.fn()
    }

    registerSessionPersistenceIpcHandlers(repository, createMockReviewRepository(), injected)

    await expect(ipcHandlers.get('sessions:load-all')?.()).resolves.toBe(loadResult)
    expect(injected.loadAll).toHaveBeenCalledOnce()
    expect(repository.loadAll).not.toHaveBeenCalled()
  })

  it('wakes Session-owned work only after the durable save boundary completes', async () => {
    const session = createSession()
    const order: string[] = []
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn(),
      loadOne: vi.fn(),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      saveManifest: vi.fn()
    }
    const injected: SessionPersistenceHandlers = {
      loadAll: vi.fn(),
      loadOne: vi.fn(),
      saveSession: vi.fn(async () => {
        order.push('saved')
        return { created: false, session }
      }),
      updateArchive: vi.fn(),
      deleteSession: vi.fn(),
      saveManifest: vi.fn()
    }
    const wake = vi.fn(async () => {
      order.push('woken')
    })
    registerSessionPersistenceIpcHandlers(repository, createMockReviewRepository(), injected, wake)

    await ipcHandlers.get('sessions:save-session')?.({ sender: { id: 1 } }, session)

    await vi.waitFor(() => expect(order).toEqual(['saved', 'woken']))
    expect(wake).toHaveBeenCalledWith(session)
  })

  it('preserves an injected handler identity when registration fails', async () => {
    const failure = new Error('registration failed')
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn(),
      loadOne: vi.fn(),
      saveSession: vi.fn(),
      deleteSession: vi.fn(),
      saveManifest: vi.fn()
    }
    const injected: SessionPersistenceHandlers = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      loadOne: vi.fn(),
      saveSession: vi.fn(),
      updateArchive: vi.fn(),
      deleteSession: vi.fn(),
      saveManifest: vi.fn()
    }
    registrationFailure.channel = 'sessions:load-all'
    registrationFailure.error = failure

    expect(() =>
      registerSessionPersistenceIpcHandlers(repository, createMockReviewRepository(), injected)
    ).toThrow(failure)

    registrationFailure.channel = undefined
    registrationFailure.error = undefined
    registerSessionPersistenceIpcHandlers(repository, createMockReviewRepository(), injected)
    await ipcHandlers.get('sessions:load-all')?.()
    expect(injected.loadAll).toHaveBeenCalledOnce()
  })

  it('rejects session persistence while a data-root migration is pending', async () => {
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      loadOne: vi.fn(),
      saveSession: vi.fn().mockResolvedValue({ created: false, session: createSession() }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    registerSessionPersistenceIpcHandlers(repository, createMockReviewRepository())
    beginMigration()

    await expect(
      ipcHandlers.get('sessions:delete-session')?.(undefined, {
        projectId: 'project-a',
        sessionId: 'session-1'
      })
    ).rejects.toThrow(/moving your data/i)
    expect(repository.deleteSession).not.toHaveBeenCalled()
  })

  it('does not broadcast a stale projection when durable save propagation fails', async () => {
    const failure = new Error('durable projection unavailable')
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      loadOne: vi.fn(),
      saveSession: vi.fn().mockRejectedValue(failure),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    registerSessionPersistenceIpcHandlers(repository, createMockReviewRepository())

    await expect(
      ipcHandlers.get('sessions:save-session')?.({ sender: { id: 1 } }, createSession())
    ).rejects.toBe(failure)
    expect(broadcastLifecycleEvent).not.toHaveBeenCalled()
  })

  it('captures the lifecycle origin before awaiting a durable save', async () => {
    const session = createSession()
    let completeSave!: () => void
    const savePending = new Promise<void>((resolve) => {
      completeSave = resolve
    })
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      loadOne: vi.fn(),
      saveSession: vi.fn(async () => {
        await savePending
        return { created: false, session }
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    registerSessionPersistenceIpcHandlers(repository, createMockReviewRepository())

    const save = ipcHandlers.get('sessions:save-session')?.({ sender: { id: 1 } }, session)

    expect(getLifecycleClientId).toHaveBeenCalledOnce()
    expect(getLifecycleClientId).toHaveReturnedWith('electron:1')
    completeSave()
    await expect(save).resolves.toBe(session)
  })

  it('publishes a lifecycle event only after the durable Session transition is readable', async () => {
    const session = createSession()
    let durableReadable = false
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      loadOne: vi.fn(),
      saveSession: vi.fn(async () => {
        durableReadable = true
        return { created: true, session }
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    broadcastLifecycleEvent.mockImplementationOnce(() => {
      expect(durableReadable).toBe(true)
    })
    registerSessionPersistenceIpcHandlers(repository, createMockReviewRepository())

    await ipcHandlers.get('sessions:save-session')?.({ sender: { id: 1 } }, session)

    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(broadcastLifecycleEvent).toHaveBeenCalledOnce()
  })
})
