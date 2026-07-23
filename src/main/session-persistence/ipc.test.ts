import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewRepository } from '../reviewer/repository'

const { broadcastLifecycleEvent, ipcHandlers } = vi.hoisted(() => ({
  broadcastLifecycleEvent: vi.fn(),
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandlers.set(channel, handler)
  }
}))
vi.mock('../lifecycle-broadcast', () => ({
  broadcastLifecycleEvent,
  getLifecycleClientId: (event: { sender: { id: number; lifecycleClientId?: string } }) =>
    event.sender.lifecycleClientId ?? `electron:${event.sender.id}`
}))

import {
  createSessionPersistenceHandlers,
  registerSessionPersistenceIpcHandlers,
  type SessionPersistenceBackend
} from './ipc'

beforeEach(() => {
  ipcHandlers.clear()
  broadcastLifecycleEvent.mockClear()
})

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
      saveSession: vi.fn().mockResolvedValue(false),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = createMockReviewRepository()
    const handlers = createSessionPersistenceHandlers(repository, reviewRepository)

    expect(handlers).not.toHaveProperty('deleteProjectSessions')

    await expect(handlers.loadAll()).resolves.toBe(loadResult)

    await handlers.saveSession(session)
    expect(repository.saveSession).toHaveBeenCalledWith(session)

    await handlers.deleteSession({ projectId: 'project-a', sessionId: 'session-1' })
    expect(repository.deleteSession).toHaveBeenCalledWith('project-a', 'session-1')
    // Cascade: review cleanup is attempted after the session delete commits.
    expect(reviewRepository.deleteReviewsForSession).toHaveBeenCalledWith('session-1')

    await handlers.saveManifest({ lastProjectId: 'project-a', lastSessionId: 'session-1' })
    expect(repository.saveManifest).toHaveBeenCalledWith({
      lastProjectId: 'project-a',
      lastSessionId: 'session-1'
    })
  })

  it('does not report a successful session deletion when the repository fails', async () => {
    const repository = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      saveSession: vi.fn().mockResolvedValue(false),
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('repository failed')),
      deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
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

  it('deletes session review rows only after the authoritative session deletion succeeds', async () => {
    const order: string[] = []
    const repository = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      saveSession: vi.fn().mockResolvedValue(false),
      deleteSession: vi.fn(async () => {
        order.push('session')
      }),
      deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = createMockReviewRepository()
    vi.mocked(reviewRepository.deleteReviewsForSession).mockImplementation(async () => {
      order.push('reviews')
    })
    const handlers = createSessionPersistenceHandlers(repository, reviewRepository)

    await handlers.deleteSession({ projectId: 'project-a', sessionId: 'session-1' })

    expect(order).toEqual(['session', 'reviews'])
  })

  it('registers each persistence channel and forwards renderer requests', async () => {
    const session = createSession()
    const loadResult = { sessions: [session], manifest: { version: 1 as const } }
    const repository: SessionPersistenceBackend = {
      loadAll: vi.fn().mockResolvedValue(loadResult),
      saveSession: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = createMockReviewRepository()
    registerSessionPersistenceIpcHandlers(repository, reviewRepository)

    expect([...ipcHandlers.keys()]).toEqual([
      'sessions:load-all',
      'sessions:save-session',
      'sessions:delete-session',
      'sessions:save-manifest'
    ])

    const deleteRequest = { projectId: 'project-a', sessionId: 'session-1' }
    const manifestRequest = { lastProjectId: 'project-a', lastSessionId: 'session-1' }
    const event = { sender: { id: -2, lifecycleClientId: 'web:browser-1' } }
    await expect(ipcHandlers.get('sessions:load-all')?.()).resolves.toBe(loadResult)
    await ipcHandlers.get('sessions:save-session')?.(event, session)
    const updatedSession = { ...session, title: 'Updated session', updatedAt: 1710000000001 }
    await ipcHandlers.get('sessions:save-session')?.(event, updatedSession)
    await ipcHandlers.get('sessions:delete-session')?.(event, deleteRequest)
    await ipcHandlers.get('sessions:save-manifest')?.(undefined, manifestRequest)

    expect(repository.saveSession).toHaveBeenCalledWith(session)
    expect(repository.deleteSession).toHaveBeenCalledWith('project-a', 'session-1')
    expect(reviewRepository.deleteReviewsForSession).toHaveBeenCalledWith('session-1')
    expect(repository.saveManifest).toHaveBeenCalledWith(manifestRequest)
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('session:created', {
      session,
      originClientId: 'web:browser-1'
    })
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('session:updated', {
      session: updatedSession,
      originClientId: 'web:browser-1'
    })
    expect(broadcastLifecycleEvent).toHaveBeenCalledWith('session:deleted', deleteRequest)
  })
})
