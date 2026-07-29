import { ipcMain } from 'electron'

import type {
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../../shared/session-persistence'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import { broadcastLifecycleEvent, getLifecycleClientId } from '../lifecycle-broadcast'
import { resolveStorageRoot } from '../storage-root'
import { SessionRepository } from './repository'
import { ReviewRepository } from '../reviewer/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { withDataRootWrite } from '../storage/migration-state'

type SessionPersistenceBackend = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (
    session: PersistedChatSession
  ) => Promise<{ created: boolean; session: PersistedChatSession }>
  deleteSession: (projectId: string, sessionId: string) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type SessionPersistenceHandlers = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (
    session: PersistedChatSession
  ) => Promise<{ created: boolean; session: PersistedChatSession }>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

// Adapts the coordinator into small handlers that are easy to unit test.
const createSessionPersistenceHandlers = (
  repository: SessionPersistenceBackend,
  reviewRepository: ReviewRepository
): SessionPersistenceHandlers => {
  // Kept as an injected boundary for project-level cleanup compatibility; session deletion must not
  // call it because Reviews belong to retained provenance.
  void reviewRepository
  return {
    loadAll: () => repository.loadAll(),
    saveSession: (session) => repository.saveSession(session),
    // A session delete tombstones its origin graph but deliberately retains Review rows, findings and
    // scope snapshots. Provenance remains readable from Files; project deletion owns final cleanup.
    deleteSession: (request) => repository.deleteSession(request.projectId, request.sessionId),
    saveManifest: (request) => repository.saveManifest(request)
  }
}

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
  // loadAll can replay pending deletions and every mutation can materialize provenance/upload bytes.
  // Hold the shared data-root lease at the IPC boundary so migration drains the complete operation.
  ipcMain.handle('sessions:load-all', () => withDataRootWrite(() => handlers.loadAll()))
  ipcMain.handle('sessions:save-session', async (event, session: PersistedChatSession) => {
    return withDataRootWrite(async () => {
      const result = await handlers.saveSession(session)
      broadcastLifecycleEvent(
        result.created ? LIFECYCLE_CHANNELS.sessionCreated : LIFECYCLE_CHANNELS.sessionUpdated,
        {
          session: result.session,
          originClientId: getLifecycleClientId(event)
        }
      )
      return result.session
    })
  })
  ipcMain.handle('sessions:delete-session', async (_event, request: DeleteSessionRequest) => {
    await withDataRootWrite(async () => {
      await handlers.deleteSession(request)
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionDeleted, request)
    })
  })
  ipcMain.handle('sessions:save-manifest', (_event, request: SaveSessionManifestRequest) =>
    withDataRootWrite(() => handlers.saveManifest(request))
  )
}

export {
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlers,
  registerSessionPersistenceIpcHandlers
}
export type { SessionPersistenceBackend }
