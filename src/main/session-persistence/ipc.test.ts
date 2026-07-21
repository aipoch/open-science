import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ReviewRepository } from '../reviewer/repository'
import { createSessionPersistenceHandlers, type SessionPersistenceBackend } from './ipc'

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
      saveSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
      saveManifest: vi.fn().mockResolvedValue(undefined)
    }
    const reviewRepository = createMockReviewRepository()
    const handlers = createSessionPersistenceHandlers(repository, reviewRepository)

    await expect(handlers.loadAll()).resolves.toBe(loadResult)

    await handlers.saveSession(session)
    expect(repository.saveSession).toHaveBeenCalledWith(session)

    await handlers.deleteSession({ projectId: 'project-a', sessionId: 'session-1' })
    expect(repository.deleteSession).toHaveBeenCalledWith('project-a', 'session-1')
    // Cascade: review cleanup is attempted after the session delete commits.
    expect(reviewRepository.deleteReviewsForSession).toHaveBeenCalledWith('session-1')

    await handlers.deleteProjectSessions({ projectId: 'project-a' })
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-a')

    await handlers.saveManifest({ lastProjectId: 'project-a', lastSessionId: 'session-1' })
    expect(repository.saveManifest).toHaveBeenCalledWith({
      lastProjectId: 'project-a',
      lastSessionId: 'session-1'
    })
  })

  it('does not report a successful session deletion when the repository fails', async () => {
    const repository = {
      loadAll: vi.fn().mockResolvedValue({ sessions: [], manifest: { version: 1 as const } }),
      saveSession: vi.fn().mockResolvedValue(undefined),
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
      saveSession: vi.fn().mockResolvedValue(undefined),
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
})
