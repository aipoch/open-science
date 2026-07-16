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
  repository: SessionPersistenceRepository
): SessionPersistenceHandlers => ({
  loadAll: () => repository.loadAll(),
  saveSession: (session) => repository.saveSession(session),
  deleteSession: (request) => repository.deleteSession(request.projectId, request.sessionId),
  deleteProjectSessions: (request) => repository.deleteProjectSessions(request.projectId),
  saveManifest: (request) => repository.saveManifest(request)
})

// Creates the production repository rooted at the (dev-aware) storage root.
const createDefaultSessionRepository = (): SessionRepository =>
  new SessionRepository(resolveStorageRoot())

// Registers renderer-callable persistence commands without coupling them to ACP runtime IPC.
const registerSessionPersistenceIpcHandlers = (
  repository = createDefaultSessionRepository()
): void => {
  const handlers = createSessionPersistenceHandlers(repository)

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
