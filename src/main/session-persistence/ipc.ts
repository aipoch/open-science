import { ipcMainHandle } from '../ipc-handler-registry'

import type { ApplicationCommandOutcome } from '../../shared/application-command-contract'
import { LIFECYCLE_CHANNELS } from '../../shared/lifecycle-events'
import {
  isSessionSizeLimitError,
  isSessionRevisionConflictError,
  SESSION_SIZE_LIMIT_ERROR_CODE,
  SessionDeletionCommittedError,
  SESSION_REVISION_CONFLICT_ERROR_CODE
} from '../../shared/session-persistence'
import type {
  DeleteSessionRequest,
  LoadAllSessionsResult,
  ListSessionSummariesResult,
  LoadSessionRequest,
  OpenSessionRecoveryFolderRequest,
  DelegationPolicy,
  PersistedChatSession,
  SessionUsageProjection,
  SaveSessionOptions,
  SaveSessionManifestRequest,
  UpdateSessionArchiveRequest
} from '../../shared/session-persistence'
import { broadcastLifecycleEvent, getLifecycleClientId } from '../lifecycle-broadcast'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { resolveConfigRoot } from '../storage-root'
import { SessionRepository } from './repository'
import { SessionProjectionRepository } from './projection'
import { ReviewRepository } from '../reviewer/repository'
import { getProjectDbClient } from '../projects/prisma-client'
import { withDataRootWrite } from '../storage/migration-state'
import type { SessionMetadataSnapshot } from './coordinator'
import type { SessionSaveAuthority } from './state-owner'
import { MainMessageAttributionAuthority } from './message-attribution-authority'
import { canReconcileSessionAbsences, withProjectDeletionRecoveryStatus } from './catalog-authority'
import { sanitizeRendererSaveSessionOptions } from './renderer-save-options'

type SessionPersistenceBackend = {
  loadAll: () => Promise<LoadAllSessionsResult>
  list?: () => Promise<ListSessionSummariesResult>
  loadUsage?: () => Promise<SessionUsageProjection>
  loadOne: (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions,
    authority?: SessionSaveAuthority
  ) => Promise<{ created: boolean; session: PersistedChatSession }>
  setDelegationPolicy?: (
    projectId: string,
    sessionId: string,
    policy: DelegationPolicy
  ) => Promise<PersistedChatSession>
  updateArchive?: (request: UpdateSessionArchiveRequest) => Promise<PersistedChatSession>
  deleteSession: (projectId: string, sessionId: string) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type SessionPersistenceHandlers = {
  loadAll: () => Promise<LoadAllSessionsResult>
  list: () => Promise<ListSessionSummariesResult>
  loadUsage: () => Promise<SessionUsageProjection>
  loadOne: (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
  saveSession: (
    session: PersistedChatSession,
    options?: SaveSessionOptions,
    authority?: SessionSaveAuthority
  ) => Promise<{ created: boolean; session: PersistedChatSession }>
  setDelegationPolicy: (
    projectId: string,
    sessionId: string,
    policy: DelegationPolicy
  ) => Promise<PersistedChatSession>
  updateArchive: (request: UpdateSessionArchiveRequest) => Promise<PersistedChatSession>
  deleteSession: (request: DeleteSessionRequest) => Promise<void>
  saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
}

type ProjectDeletionRecoveryBackend = {
  recoverPendingDeletions: () => Promise<void>
}

type ProjectDeletionMutationCoordinator = {
  waitForProjectOperations: (projectIds: readonly string[]) => Promise<void>
}

type SessionStartupLoader = {
  loadAll: () => Promise<LoadAllSessionsResult>
  loadAllReadOnly: () => Promise<LoadAllSessionsResult>
}

type SessionCatalogHydrator = (
  loadCatalog: () => Promise<LoadAllSessionsResult>
) => Promise<LoadAllSessionsResult>

const loadCatalogDirectly: SessionCatalogHydrator = (loadCatalog) => loadCatalog()

type SessionMetadataLoader = {
  sessionMetadataSnapshot: () => Promise<SessionMetadataSnapshot>
}

type ProjectDeletionRecoveryForSessionRead =
  { isComplete: true } | { isComplete: false; result: LoadAllSessionsResult }

const recoverProjectDeletionsForSessionRead = async (
  projectRecovery: ProjectDeletionRecoveryBackend,
  sessionLoader: Pick<SessionStartupLoader, 'loadAllReadOnly'>,
  log: Pick<Logger, 'warn'> = createLogger('session-persistence'),
  hydrateCatalog: SessionCatalogHydrator = loadCatalogDirectly
): Promise<ProjectDeletionRecoveryForSessionRead> => {
  try {
    await projectRecovery.recoverPendingDeletions()
    return { isComplete: true }
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
    return {
      isComplete: false,
      result: await hydrateCatalog(async () =>
        withProjectDeletionRecoveryStatus(await sessionLoader.loadAllReadOnly(), false)
      )
    }
  }
}

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
  log: Pick<Logger, 'warn'> = createLogger('session-persistence'),
  hydrateCatalog: SessionCatalogHydrator = loadCatalogDirectly
): Promise<LoadAllSessionsResult> => {
  const recovery = await recoverProjectDeletionsForSessionRead(
    projectRecovery,
    sessionLoader,
    log,
    hydrateCatalog
  )
  if (!recovery.isComplete) return recovery.result

  return hydrateCatalog(async () =>
    withProjectDeletionRecoveryStatus(await sessionLoader.loadAll(), true)
  )
}

// Adapts the coordinator into small handlers that are easy to unit test.
const createSessionPersistenceHandlersWithAttributionAuthority = (
  repository: SessionPersistenceBackend,
  reviewRepository: ReviewRepository,
  messageAttributionAuthority: MainMessageAttributionAuthority
): SessionPersistenceHandlers => {
  // Kept as an injected boundary for project-level cleanup compatibility; session deletion must not
  // call it because Reviews belong to retained provenance.
  void reviewRepository
  return {
    loadAll: () => repository.loadAll(),
    list: () => {
      if (!repository.list) throw new Error('Session summary projection is unavailable.')
      return repository.list()
    },
    loadUsage: () => {
      if (!repository.loadUsage) throw new Error('Session usage projection is unavailable.')
      return repository.loadUsage()
    },
    loadOne: (request) => repository.loadOne(request),
    saveSession: async (session, options, authority) => {
      const durable = await repository.loadOne({
        projectId: session.projectId,
        sessionId: session.id
      })
      const authorized = messageAttributionAuthority.authorizeSessionProjection(session, durable)
      if (authority) return repository.saveSession(authorized, options, authority)
      return options
        ? repository.saveSession(authorized, options)
        : repository.saveSession(authorized)
    },
    setDelegationPolicy: (projectId, sessionId, policy) => {
      if (!repository.setDelegationPolicy) {
        throw new Error('Session delegation policy mutation is unavailable.')
      }
      return repository.setDelegationPolicy(projectId, sessionId, policy)
    },
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

const createSessionPersistenceHandlers = (
  repository: SessionPersistenceBackend,
  reviewRepository: ReviewRepository
): SessionPersistenceHandlers =>
  createSessionPersistenceHandlersWithAttributionAuthority(
    repository,
    reviewRepository,
    new MainMessageAttributionAuthority()
  )

// Keeps production deletion finalizers testable without booting the Electron composition root.
const withSessionDeletionCleanup =
  (
    deleteSession: SessionPersistenceBackend['deleteSession'],
    cleanup: (projectId: string, sessionId: string) => unknown
  ): SessionPersistenceBackend['deleteSession'] =>
  async (projectId, sessionId) => {
    let committedError: SessionDeletionCommittedError | undefined
    try {
      await deleteSession(projectId, sessionId)
    } catch (error) {
      if (!(error instanceof SessionDeletionCommittedError)) throw error
      committedError = error
    }
    // A committed rejection must still run the next finalizer; an ordinary rejection must not.
    try {
      await cleanup(projectId, sessionId)
    } catch (error) {
      throw new SessionDeletionCommittedError(
        committedError
          ? new AggregateError([committedError, error], 'Session deletion cleanup failed.')
          : error
      )
    }
    if (committedError) throw committedError
  }

// Keeps the application-composition boundary injectable without exposing the rest of main-process
// startup to tests. The coordinator owns admission; the wrapped backend owns the durable mutation.
const coordinateSessionPersistenceWithProjectDeletions = (
  repository: SessionPersistenceBackend,
  projectDeletion: ProjectDeletionMutationCoordinator
): SessionPersistenceBackend => {
  const coordinated: SessionPersistenceBackend = {
    ...repository,
    saveSession: async (session, options, authority) => {
      await projectDeletion.waitForProjectOperations([session.projectId])
      if (authority) return repository.saveSession(session, options, authority)
      return options ? repository.saveSession(session, options) : repository.saveSession(session)
    },
    deleteSession: async (projectId, sessionId) => {
      await projectDeletion.waitForProjectOperations([projectId])
      return repository.deleteSession(projectId, sessionId)
    },
    saveManifest: async (request) => {
      await projectDeletion.waitForProjectOperations([])
      return repository.saveManifest(request)
    }
  }
  if (repository.setDelegationPolicy) {
    coordinated.setDelegationPolicy = async (projectId, sessionId, policy) => {
      await projectDeletion.waitForProjectOperations([projectId])
      return repository.setDelegationPolicy!(projectId, sessionId, policy)
    }
  }
  if (repository.updateArchive) {
    coordinated.updateArchive = async (request) => {
      await projectDeletion.waitForProjectOperations([request.projectId])
      return repository.updateArchive!(request)
    }
  }
  return coordinated
}

// Creates the production repository rooted at the (dev-aware) storage root.
const createDefaultSessionRepository = (
  hasActiveRuntimePrompt: (projectId: string, sessionId: string) => boolean = () => false,
  hasLiveRuntimeSession: (projectId: string, sessionId: string) => boolean = () => false
): SessionRepository =>
  new SessionRepository(
    resolveConfigRoot(),
    { hasActiveRuntimePrompt, hasLiveRuntimeSession },
    new SessionProjectionRepository(() => getProjectDbClient(resolveConfigRoot()))
  )

const createDefaultReviewRepository = (): ReviewRepository =>
  new ReviewRepository(() => getProjectDbClient(resolveConfigRoot()))

// Registers renderer-callable persistence commands without coupling them to ACP runtime IPC.
const registerSessionPersistenceIpcHandlers = (
  repository: SessionPersistenceBackend,
  reviewRepository = createDefaultReviewRepository(),
  handlers: SessionPersistenceHandlers = createSessionPersistenceHandlers(
    repository,
    reviewRepository
  ),
  onSessionSaved?: (session: PersistedChatSession) => Promise<void> | void,
  openRecoveryFolder?: (request: OpenSessionRecoveryFolderRequest) => Promise<void>
): void => {
  // Keep persistence IPC separate from ACP runtime commands; it owns durable UI state only.
  // loadAll can replay pending deletions and every mutation can materialize provenance/upload bytes.
  // Hold the shared data-root lease at the IPC boundary so migration drains the complete operation.
  ipcMainHandle('sessions:load-all', () => withDataRootWrite(() => handlers.loadAll()))
  ipcMainHandle('sessions:list', () =>
    withDataRootWrite(() => {
      if (!handlers.list) throw new Error('Session summary projection is unavailable.')
      return handlers.list()
    })
  )
  ipcMainHandle('sessions:load-usage', () =>
    withDataRootWrite(() => {
      if (!handlers.loadUsage) throw new Error('Session usage projection is unavailable.')
      return handlers.loadUsage()
    })
  )
  ipcMainHandle('sessions:load-one', (_event, request: LoadSessionRequest) =>
    withDataRootWrite(() => handlers.loadOne(request))
  )
  ipcMainHandle(
    'sessions:save-session',
    async (
      event,
      session: PersistedChatSession,
      options?: SaveSessionOptions
    ): Promise<ApplicationCommandOutcome<PersistedChatSession>> => {
      const originClientId = getLifecycleClientId(event)
      let durable: PersistedChatSession
      try {
        durable = await withDataRootWrite(async () => {
          const rendererOptions = sanitizeRendererSaveSessionOptions(options)
          const result = rendererOptions
            ? await handlers.saveSession(session, rendererOptions)
            : await handlers.saveSession(session)
          broadcastLifecycleEvent(
            result.created ? LIFECYCLE_CHANNELS.sessionCreated : LIFECYCLE_CHANNELS.sessionUpdated,
            {
              session: result.session,
              originClientId
            }
          )
          return result.session
        })
      } catch (error) {
        if (!isSessionRevisionConflictError(error) && !isSessionSizeLimitError(error)) throw error
        const sizeLimit = isSessionSizeLimitError(error)
        return Object.freeze({
          ok: false,
          error: Object.freeze({
            code: sizeLimit ? SESSION_SIZE_LIMIT_ERROR_CODE : SESSION_REVISION_CONFLICT_ERROR_CODE,
            message:
              error instanceof Error
                ? error.message
                : sizeLimit
                  ? 'Session exceeds the persistence limit.'
                  : 'Session revision conflict. Reload and retry.'
          })
        })
      }
      void Promise.resolve(onSessionSaved?.(durable)).catch(() => undefined)
      return Object.freeze({ ok: true, result: durable })
    }
  )
  ipcMainHandle('sessions:save-manifest', (_event, request: SaveSessionManifestRequest) =>
    withDataRootWrite(() => handlers.saveManifest(request))
  )
  if (openRecoveryFolder) {
    ipcMainHandle(
      'sessions:open-recovery-folder',
      (_event, request: OpenSessionRecoveryFolderRequest) => openRecoveryFolder(request)
    )
  }
}

export {
  canReconcileSessionAbsences,
  coordinateSessionPersistenceWithProjectDeletions,
  createDefaultReviewRepository,
  createDefaultSessionRepository,
  createSessionPersistenceHandlers,
  createSessionPersistenceHandlersWithAttributionAuthority,
  loadSessionMetadataAfterProjectRecovery,
  loadSessionsAfterProjectRecovery,
  recoverProjectDeletionsForSessionRead,
  registerSessionPersistenceIpcHandlers,
  withSessionDeletionCleanup
}
export type {
  ProjectDeletionMutationCoordinator,
  ProjectDeletionRecoveryForSessionRead,
  ProjectDeletionRecoveryBackend,
  SessionCatalogHydrator,
  SessionPersistenceBackend,
  SessionPersistenceHandlers
}
