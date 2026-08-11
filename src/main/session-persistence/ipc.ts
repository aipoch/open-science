import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionOptions,
  SaveSessionManifestRequest,
  UpdateSessionArchiveRequest
} from '../../shared/session-persistence'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import { broadcastLifecycleEvent, getLifecycleClientId } from '../lifecycle-broadcast'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { resolveStorageRoot } from '../storage-root'
import { SessionRepository } from './repository'
import { ReviewRepository } from '../reviewer/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { withDataRootWrite } from '../storage/migration-state'
import type { SessionMetadataSnapshot } from './coordinator'

type SessionPersistenceBackend = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ) => Promise<{ created: boolean; session: PersistedChatSession }>
  updateArchive?: (request: UpdateSessionArchiveRequest) => Promise<PersistedChatSession>
  deleteSession: (projectId: string, sessionId: string) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type SessionPersistenceHandlers = {
  loadAll: () => Promise<LoadAllSessionsResult>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions
  ) => Promise<{ created: boolean; session: PersistedChatSession }>
  updateArchive: (request: UpdateSessionArchiveRequest) => Promise<PersistedChatSession>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type ProjectDeletionRecoveryBackend = {
  recoverPendingDeletions: () => Promise<void>
}

type SessionStartupLoader = {
  loadAll: () => Promise<LoadAllSessionsResult>
  loadAllReadOnly: () => Promise<LoadAllSessionsResult>
}

type SessionMetadataLoader = {
  sessionMetadataSnapshot: () => Promise<SessionMetadataSnapshot>
}

const withProjectDeletionRecoveryStatus = (
  result: LoadAllSessionsResult,
  isProjectDeletionRecoveryComplete: boolean
): LoadAllSessionsResult => ({
  ...result,
  diagnostics: {
    isComplete: result.diagnostics?.isComplete ?? true,
    warnings: result.diagnostics?.warnings ?? [],
    ...result.diagnostics,
    isProjectDeletionRecoveryComplete
  }
})

// Cached metadata must not overtake queued Project deletion work. Let recovery failures reject so
// Permissions reports the Session store as incomplete instead of publishing stale navigation labels.
const loadSessionMetadataAfterProjectRecovery = async (
  projectRecovery: ProjectDeletionRecoveryBackend,
  sessionLoader: SessionMetadataLoader
): Promise<SessionMetadataSnapshot> => {
  await projectRecovery.recoverPendingDeletions()
  return sessionLoader.sessionMetadataSnapshot()
}

// Project deletion recovery is a prerequisite for mutating startup reconciliation. If it fails,
// expose only the coordinator's explicit read-only snapshot so healthy transcripts remain navigable
// without allowing partially recovered Project authority to drive cleanup or derived-state writes.
const loadSessionsAfterProjectRecovery = async (
  projectRecovery: ProjectDeletionRecoveryBackend,
  sessionLoader: SessionStartupLoader,
  log: Pick<Logger, 'warn'> = createLogger('session-persistence')
): Promise<LoadAllSessionsResult> => {
  try {
    await projectRecovery.recoverPendingDeletions()
  } catch (error) {
    try {
      log.warn('project deletion recovery failed', {
        operation: 'session-hydration',
        phase: 'recover-project-deletions',
        outcome: 'degraded',
        ...diagnosticErrorFields(error)
      })
    } catch {
      // Diagnostics must never prevent the explicit read-only recovery path.
    }
    return withProjectDeletionRecoveryStatus(await sessionLoader.loadAllReadOnly(), false)
  }

  return withProjectDeletionRecoveryStatus(await sessionLoader.loadAll(), true)
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
    saveSession: (session, options) =>
      options ? repository.saveSession(session, options) : repository.saveSession(session),
    updateArchive: (request) => {
      if (!repository.updateArchive) throw new Error('Session archive is unavailable.')
      return repository.updateArchive(request)
    },
    // A session delete tombstones its origin graph but deliberately retains Review rows, findings and
    // scope snapshots. Provenance remains readable from Files; project deletion owns final cleanup.
    deleteSession: (request) => repository.deleteSession(request.projectId, request.sessionId),
    saveManifest: (request) => repository.saveManifest(request)
  }
}

// Creates the production repository rooted at the (dev-aware) storage root.
const createDefaultSessionRepository = (
  hasActiveRuntimePrompt: (projectId: string, sessionId: string) => boolean = () => false
): SessionRepository => new SessionRepository(resolveStorageRoot(), { hasActiveRuntimePrompt })

const createDefaultReviewRepository = (): ReviewRepository =>
  new ReviewRepository(() => getProjectDbClient(resolveStorageRoot()))

// Registers renderer-callable persistence commands without coupling them to ACP runtime IPC.
const registerSessionPersistenceIpcHandlers = (
  repository: SessionPersistenceBackend,
  reviewRepository = createDefaultReviewRepository(),
  handlers: SessionPersistenceHandlers = createSessionPersistenceHandlers(
    repository,
    reviewRepository
  )
): void => {
  // Keep persistence IPC separate from ACP runtime commands; it owns durable UI state only.
  // loadAll can replay pending deletions and every mutation can materialize provenance/upload bytes.
  // Hold the shared data-root lease at the IPC boundary so migration drains the complete operation.
  ipcMainHandle('sessions:load-all', () => withDataRootWrite(() => handlers.loadAll()))
  ipcMainHandle(
    'sessions:save-session',
    async (event, session: PersistedChatSession, options?: SaveSessionOptions) => {
      const originClientId = getLifecycleClientId(event)
      return withDataRootWrite(async () => {
        const result = await handlers.saveSession(session, options)
        broadcastLifecycleEvent(
          result.created ? LIFECYCLE_CHANNELS.sessionCreated : LIFECYCLE_CHANNELS.sessionUpdated,
          {
            session: result.session,
            originClientId
          }
        )
        return result.session
      })
    }
  )
  ipcMainHandle('sessions:update-archive', async (event, request: UpdateSessionArchiveRequest) => {
    const originClientId = getLifecycleClientId(event)
    return withDataRootWrite(async () => {
      const session = await handlers.updateArchive(request)
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionUpdated, { session, originClientId })
      return session
    })
  })
  ipcMainHandle('sessions:delete-session', async (_event, request: DeleteSessionRequest) => {
    await withDataRootWrite(async () => {
      await handlers.deleteSession(request)
      broadcastLifecycleEvent(LIFECYCLE_CHANNELS.sessionDeleted, request)
    })
  })
  ipcMainHandle('sessions:save-manifest', (_event, request: SaveSessionManifestRequest) =>
    withDataRootWrite(() => handlers.saveManifest(request))
  )
}

export {
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlers,
  loadSessionMetadataAfterProjectRecovery,
  loadSessionsAfterProjectRecovery,
  registerSessionPersistenceIpcHandlers
}
export type { SessionPersistenceBackend, SessionPersistenceHandlers }
