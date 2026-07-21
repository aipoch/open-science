import { describe, expect, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
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

describe('SessionPersistenceCoordinator', () => {
  it('serializes a pending save before deletion and rejects saves after the tombstone', async () => {
    const order: string[] = []
    const saveGate = createDeferred<void>()
    const repository = createSessionRepository({
      saveSession: vi.fn(async () => {
        order.push('json-save:start')
        await saveGate.promise
        order.push('json-save:end')
      }),
      deleteSession: vi.fn(async () => {
        order.push('json-delete')
      })
    })
    const fileIndex = createFileIndex({
      syncSession: vi.fn(async () => {
        order.push('index-sync')
        return ['artifact' as const]
      }),
      softDeleteSession: vi.fn(async () => {
        order.push('index-soft-delete')
        return 'delete-session-operation'
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    const save = coordinator.saveSession(createSession())
    const deletion = coordinator.deleteSession('project-1', 'session-1')
    await flushMicrotasks()
    expect(order).toEqual(['json-save:start'])

    saveGate.resolve()
    await Promise.all([save, deletion])
    expect(order).toEqual([
      'json-save:start',
      'json-save:end',
      'index-sync',
      'index-soft-delete',
      'json-delete'
    ])

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/deleted/)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('restores DB visibility and clears the tombstone when JSON deletion fails', async () => {
    const repository = createSessionRepository({
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('disk locked'))
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')
    expect(fileIndex.softDeleteSession).toHaveBeenCalledWith('project-1', 'session-1')
    expect(fileIndex.restoreSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      'delete-session-operation'
    )

    await expect(coordinator.saveSession(createSession())).resolves.toBeUndefined()
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('marks the index incomplete when deletion compensation cannot restore DB visibility', async () => {
    const repository = createSessionRepository({
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('disk locked'))
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({
      restoreSession: vi.fn().mockRejectedValueOnce(new Error('database unavailable')),
      markReconciliationIncomplete
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'database unavailable'
    )
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    await expect(coordinator.saveSession(createSession())).resolves.toBeUndefined()
  })

  it('hydrates sessions after indexing and reconciles only a complete scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.loadAll()).resolves.toBe(result)
    expect(fileIndex.syncSession).toHaveBeenCalledWith(session)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([session])
  })

  it('reconciles active owners before syncing sessions from a complete startup scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    let isReconciled = false
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const syncSession = vi.fn().mockResolvedValue([])
    const fileIndex = createFileIndex({
      syncSession,
      reconcileActiveSessions: vi.fn(async () => {
        isReconciled = true
      })
    })
    syncSession.mockImplementation(async () => {
      expect(isReconciled).toBe(true)
      return []
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.loadAll()

    expect(syncSession).toHaveBeenCalledOnce()
  })

  it('retries surviving project sessions after deleting a collision owner', async () => {
    const owner = createSession()
    const survivor = createSession({ id: 'session-2' })
    const result = { sessions: [owner, survivor], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi
        .fn()
        .mockResolvedValueOnce({ result, isComplete: true })
        .mockResolvedValueOnce({
          result: { sessions: [survivor], manifest: { version: 1 as const } },
          isComplete: true
        })
    })
    const fileIndex = createFileIndex()
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)
    await coordinator.loadAll()
    vi.mocked(fileIndex.syncSession).mockClear()
    vi.mocked(fileIndex.syncSession).mockResolvedValueOnce(['artifact'])

    await coordinator.deleteSession('project-1', 'session-1')

    expect(fileIndex.syncSession).toHaveBeenCalledTimes(1)
    expect(fileIndex.syncSession).toHaveBeenCalledWith(survivor)
    expect(onFilesChanged).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1',
      sessionId: 'session-2',
      sources: ['artifact'],
      kind: 'upsert'
    })
    expect(onFilesChanged).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1',
      sessionId: 'session-1',
      sources: ['artifact', 'upload'],
      kind: 'delete'
    })
  })

  it('marks the index incomplete when the sessions scan is partial', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: false })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.loadAll()).resolves.toBe(result)
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
  })

  it('keeps chat hydration available when one session cannot be indexed', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const fileIndex = createFileIndex({
      syncSession: vi.fn().mockRejectedValue(new Error('missing managed file'))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.loadAll()).resolves.toBe(result)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([session])
  })

  it('restores a project index when deleting its session directory fails', async () => {
    const repository = createSessionRepository({
      deleteProjectSessions: vi.fn().mockRejectedValueOnce(new Error('directory busy'))
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow('directory busy')
    expect(fileIndex.softDeleteProject).toHaveBeenCalledWith('project-1')
    expect(fileIndex.restoreProject).toHaveBeenCalledWith('project-1', 'delete-project-operation')
    await expect(coordinator.saveSession(createSession())).resolves.toBeUndefined()
  })

  it('rejects late session saves after a project session directory was deleted', async () => {
    const repository = createSessionRepository()
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.deleteProjectSessions('project-1')

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/project.*deleted/i)
  })

  it('does not turn a committed project-session deletion into a failure when notification throws', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex(), () => {
      throw new Error('renderer unavailable')
    })

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toBeUndefined()
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/project.*deleted/i)
  })

  it('does not turn a committed session deletion into a failure when notification throws', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex(), () => {
      throw new Error('renderer unavailable')
    })

    await expect(coordinator.deleteSession('project-1', 'session-1')).resolves.toBeUndefined()
    expect(repository.deleteSession).toHaveBeenCalledWith('project-1', 'session-1')
    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/deleted/)
  })

  it('reconciles surviving sessions after a successful session deletion', async () => {
    const survivor = createSession({ id: 'session-2' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [survivor], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.deleteSession('project-1', 'session-1')

    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([survivor])
  })

  it('routes manifest writes through the same mutation queue', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveManifest({ lastProjectId: 'project-1', lastSessionId: 'session-1' })

    expect(repository.saveManifest).toHaveBeenCalledWith({
      lastProjectId: 'project-1',
      lastSessionId: 'session-1'
    })
  })

  it('does not broadcast a files change when the files revision is already indexed', async () => {
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex({ syncSession: vi.fn().mockResolvedValue([]) }),
      onFilesChanged
    )

    await coordinator.saveSession(createSession())

    expect(onFilesChanged).not.toHaveBeenCalled()
  })

  it('broadcasts only the file sources changed by the index transaction', async () => {
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex({ syncSession: vi.fn().mockResolvedValue(['upload']) }),
      onFilesChanged
    )

    await coordinator.saveSession(createSession())

    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      sources: ['upload'],
      kind: 'upsert'
    })
  })

  it('broadcasts a reset when a saved session cannot be indexed', async () => {
    const onFilesChanged = vi.fn()
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({
        syncSession: vi.fn().mockRejectedValue(new Error('managed file is unreadable'))
      }),
      onFilesChanged
    )

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(
      'managed file is unreadable'
    )

    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })

  it('force-syncs the complete scan before repair clears the global reconciliation marker', async () => {
    const targetSession = createSession()
    const otherSession = createSession({ id: 'session-2', projectId: 'project-2' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [targetSession, otherSession], manifest: { version: 1 } },
        isComplete: true
      })
    })
    const fileIndex = createFileIndex({ syncSession: vi.fn().mockResolvedValue([]) })
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)
    const repairProjectFiles = (
      coordinator as unknown as { repairProjectFiles(projectId: string): Promise<void> }
    ).repairProjectFiles

    await repairProjectFiles.call(coordinator, 'project-1')

    expect(fileIndex.syncSession).toHaveBeenCalledTimes(4)
    expect(fileIndex.syncSession).toHaveBeenCalledWith(targetSession, { force: true })
    expect(fileIndex.syncSession).toHaveBeenCalledWith(otherSession, { force: true })
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([targetSession, otherSession])
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })

  it('resolves repair when a transient first-pass sync succeeds after reconciliation', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [session], manifest: { version: 1 } },
        isComplete: true
      })
    })
    const syncSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce([])
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ syncSession })
    )

    await expect(coordinator.repairProjectFiles('project-1')).resolves.toBeUndefined()
    expect(syncSession).toHaveBeenCalledTimes(2)
  })

  it('marks the index incomplete and broadcasts reset when repair sees a partial scan', async () => {
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [], manifest: { version: 1 } },
        isComplete: false
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)

    await expect(coordinator.repairProjectFiles('project-1')).rejects.toThrow(/sessions directory/i)

    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })
})

const createSessionRepository = (
  overrides: Partial<SessionMutationRepository> = {}
): SessionMutationRepository => ({
  loadAllWithDiagnostics: vi.fn().mockResolvedValue({
    result: { sessions: [], manifest: { version: 1 } },
    isComplete: true
  }),
  saveSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
  saveManifest: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

const createFileIndex = (overrides: Partial<SessionFileIndex> = {}): SessionFileIndex => ({
  syncSession: vi.fn().mockResolvedValue(['artifact', 'upload']),
  softDeleteSession: vi.fn().mockResolvedValue('delete-session-operation'),
  restoreSession: vi.fn().mockResolvedValue(undefined),
  softDeleteProject: vi.fn().mockResolvedValue('delete-project-operation'),
  restoreProject: vi.fn().mockResolvedValue(undefined),
  reconcileActiveSessions: vi.fn().mockResolvedValue(undefined),
  markReconciliationIncomplete: vi.fn(),
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
