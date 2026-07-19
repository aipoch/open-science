import { ipcMain } from 'electron'

import type {
  DeleteProjectSessionsRequest,
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../../shared/session-persistence'
import { resolveStorageRoot } from '../storage-root'
import { SessionRepository } from './repository'
import { ReviewRepository } from '../reviewer/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { createLogger } from '../logger'

const log = createLogger('session-persistence:ipc')

type SessionPersistenceRepository = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (session: PersistedChatSession) => Promise<void>
  deleteSession: (projectId: string, sessionId: string) => Promise<void>
  deleteProjectSessions: (projectId: string) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type SessionPersistenceHandlers = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (session: PersistedChatSession) => Promise<void>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  deleteProjectSessions: (request: DeleteProjectSessionsRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

// Adapts the repository into small handlers that are easy to unit test.
const createSessionPersistenceHandlers = (
  repository: SessionPersistenceRepository,
  reviewRepository: ReviewRepository,
  deleteSessionUploads: (sessionId: string) => Promise<void> = async () => undefined
): SessionPersistenceHandlers => ({
  loadAll: () => repository.loadAll(),
  saveSession: (session) => repository.saveSession(session),
  deleteSession: async (request) => {
    // Delete cascade: remove reviewer rows first so no orphan reviews/findings remain.
    // A reviewer-cleanup failure must not block the underlying session delete (fire-and-forget).
    await reviewRepository.deleteReviewsForSession(request.sessionId).catch((error: unknown) => {
      log.warn('deleteReviewsForSession failed (non-fatal)', {
        sessionId: request.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    await repository.deleteSession(request.projectId, request.sessionId)
    await deleteSessionUploads(request.sessionId).catch((error: unknown) => {
      log.warn('deleteSessionUploads failed after session delete (non-fatal)', {
        sessionId: request.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  },
  deleteProjectSessions: async (request) => {
    // Delete cascade: remove reviewer rows first so no orphan reviews/findings remain.
    // Uses the project-level delete (more efficient than per-session iteration).
    // A reviewer-cleanup failure must not block the underlying session deletes.
    await reviewRepository.deleteReviewsForProject(request.projectId).catch((error: unknown) => {
      log.warn('deleteReviewsForProject failed during deleteProjectSessions (non-fatal)', {
        projectId: request.projectId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    const sessions = (await repository.loadAll()).sessions.filter(
      (session) => session.projectId === request.projectId
    )
    await repository.deleteProjectSessions(request.projectId)
    await Promise.all(
      sessions.map((session) =>
        deleteSessionUploads(session.id).catch((error: unknown) => {
          log.warn('deleteSessionUploads failed after project delete (non-fatal)', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error)
          })
        })
      )
    )
  },
  saveManifest: (request) => repository.saveManifest(request)
})

// Creates the production repository rooted at the (dev-aware) storage root.
const createDefaultSessionRepository = (): SessionRepository =>
  new SessionRepository(resolveStorageRoot())

const createDefaultReviewRepository = (): ReviewRepository =>
  new ReviewRepository(() => getProjectDbClient(resolveStorageRoot()))

// Registers renderer-callable persistence commands without coupling them to ACP runtime IPC.
const registerSessionPersistenceIpcHandlers = (
  repository = createDefaultSessionRepository(),
  reviewRepository = createDefaultReviewRepository(),
  deleteSessionUploads?: (sessionId: string) => Promise<void>
): void => {
  const handlers = createSessionPersistenceHandlers(
    repository,
    reviewRepository,
    deleteSessionUploads
  )

  // Keep persistence IPC separate from ACP runtime commands; it owns durable UI state only.
  ipcMain.handle('sessions:load-all', () => handlers.loadAll())
  ipcMain.handle('sessions:save-session', (_event, session: PersistedChatSession) =>
    handlers.saveSession(session)
  )
  ipcMain.handle('sessions:delete-session', (_event, request: DeleteSessionRequest) =>
    handlers.deleteSession(request)
  )
  ipcMain.handle(
    'sessions:delete-project-sessions',
    (_event, request: DeleteProjectSessionsRequest) => handlers.deleteProjectSessions(request)
  )
  ipcMain.handle('sessions:save-manifest', (_event, request: SaveSessionManifestRequest) =>
    handlers.saveManifest(request)
  )
}

export {
  createDefaultSessionRepository,
  createSessionPersistenceHandlers,
  registerSessionPersistenceIpcHandlers
}
export type { SessionPersistenceRepository }
