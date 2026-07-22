import { ipcMain } from 'electron'

import type {
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../../shared/session-persistence'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import { broadcastLifecycleEvent } from '../lifecycle-broadcast'
import { resolveStorageRoot } from '../storage-root'
import { SessionRepository } from './repository'
import { ReviewRepository } from '../reviewer/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { createLogger } from '../logger'

const log = createLogger('session-persistence:ipc')

type SessionPersistenceBackend = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (session: PersistedChatSession) => Promise<boolean>
  deleteSession: (projectId: string, sessionId: string) => Promise<void>
  deleteProjectSessions: (projectId: string) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type SessionPersistenceHandlers = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (session: PersistedChatSession) => Promise<boolean>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

// Adapts the coordinator into small handlers that are easy to unit test.
const createSessionPersistenceHandlers = (
  repository: SessionPersistenceBackend,
  reviewRepository: ReviewRepository
): SessionPersistenceHandlers => ({
  loadAll: () => repository.loadAll(),
  saveSession: (session) => repository.saveSession(session),
  deleteSession: async (request) => {
    // Delete the authoritative session first. Review cleanup is derived and must not erase data when
    // the durable session deletion itself fails.
    await repository.deleteSession(request.projectId, request.sessionId)
    await reviewRepository.deleteReviewsForSession(request.sessionId).catch((error: unknown) => {
      log.warn('deleteReviewsForSession failed after session delete (non-fatal)', {
        sessionId: request.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
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
  repository: SessionPersistenceBackend,
  reviewRepository = createDefaultReviewRepository()
): void => {
  const handlers = createSessionPersistenceHandlers(repository, reviewRepository)

  // Keep persistence IPC separate from ACP runtime commands; it owns durable UI state only.
  ipcMain.handle('sessions:load-all', () => handlers.loadAll())
  ipcMain.handle('sessions:save-session', async (_event, session: PersistedChatSession) => {
    const created = await handlers.saveSession(session)
    broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionSaved, { session, created })
  })
  ipcMain.handle('sessions:delete-session', async (_event, request: DeleteSessionRequest) => {
    await handlers.deleteSession(request)
    broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionDeleted, request)
  })
  ipcMain.handle('sessions:save-manifest', (_event, request: SaveSessionManifestRequest) =>
    handlers.saveManifest(request)
  )
}

export {
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlers,
  registerSessionPersistenceIpcHandlers
}
export type { SessionPersistenceBackend }
