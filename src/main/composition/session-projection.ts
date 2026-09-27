import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  SessionSummary
} from '../../shared/session-persistence'
import { PendingSessionSpecialistBindings } from '../agents/pending-session-specialist-bindings'
import { ArchiveCoordinator } from '../archive/coordinator'
import { createSessionCatalogHydration } from '../compute/session-catalog-hydration'
import { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import { createPermissionGrantRegistry } from '../permission-grants/registry'
import { ProjectDeletionCoordinator } from '../projects/deletion-coordinator'
import { SessionAuxiliaryTurnUsageRecorder } from '../session-persistence/auxiliary-turn-usage'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import {
  canReconcileSessionAbsences,
  coordinateSessionPersistenceWithProjectDeletions,
  createDefaultSessionRepository,
  recoverProjectDeletionsForSessionRead,
  withSessionDeletionCleanup,
  type SessionPersistenceBackend
} from '../session-persistence/ipc'
import { SessionProjectionDiagnostics } from '../session-persistence/projection-diagnostics'
import { SettingsService } from '../settings/service'
import { WslSetupSessionOwner } from '../wsl/wsl-setup-session-owner'

export function composeSessionProjection({
  wslSetupSessions,
  settingsService,
  sessionRepository,
  auxiliaryUsageRecorder,
  permissionGrantRegistry,
  sessionPersistenceCoordinator,
  projectDeletionCoordinator,
  archiveCoordinator,
  sessionEnabledComputeHostsOwnerRef
}: {
  wslSetupSessions: WslSetupSessionOwner
  settingsService: SettingsService
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  auxiliaryUsageRecorder: SessionAuxiliaryTurnUsageRecorder
  permissionGrantRegistry: Awaited<ReturnType<typeof createPermissionGrantRegistry>>
  sessionPersistenceCoordinator: Pick<
    SessionPersistenceCommands,
    | 'deleteSession'
    | 'loadAll'
    | 'loadAllReadOnly'
    | 'replaceSessionMetadata'
    | 'saveManifest'
    | 'saveSession'
    | 'saveSessionSpecialistBinding'
    | 'setSessionDelegationPolicy'
  >
  projectDeletionCoordinator: ProjectDeletionCoordinator
  archiveCoordinator: ArchiveCoordinator
  sessionEnabledComputeHostsOwnerRef: { current?: SessionEnabledComputeHostsOwner }
}): {
  pendingSpecialistBindings: PendingSessionSpecialistBindings
  loadAllSessions: () => Promise<LoadAllSessionsResult>
  startupSessionDetails: { current: LoadAllSessionsResult['sessions'] | undefined }
  ensureSessionProjection: () => Promise<{
    result?: LoadAllSessionsResult
    sessions: SessionSummary[]
  }>
  sessionPersistenceBackend: ReturnType<typeof coordinateSessionPersistenceWithProjectDeletions>
} {
  // Stashed host.agents.switch bindings for sessions that are not yet durable (fresh unsent drafts),
  // flushed to disk on the session's first save so an approved switch survives an app restart before
  // the next message. Shared by persistSessionSpecialist (stash) and saveSession (flush).
  const pendingSpecialistBindings = new PendingSessionSpecialistBindings()
  const sessionCatalogHydration = createSessionCatalogHydration({
    owner: () => {
      if (!sessionEnabledComputeHostsOwnerRef.current) {
        throw new Error('Session enabled Compute Host ownership is not initialized.')
      }
      return sessionEnabledComputeHostsOwnerRef.current
    },
    projectRecovery: projectDeletionCoordinator,
    sessionLoader: sessionPersistenceCoordinator
  })
  const sessionProjectionDiagnostics = new SessionProjectionDiagnostics()
  const loadAllSessions = async (): Promise<LoadAllSessionsResult> => {
    const result = await sessionCatalogHydration.loadAll()
    // Startup and non-renderer readers can recover historical files before the first list call.
    // Retain their warnings in the same cache used by subsequent projection-only reads.
    sessionProjectionDiagnostics.resolve(result.diagnostics)
    return result
  }
  // Consume only during composition, before client adapters are installed. Keep just details
  // recovery candidates, not a long-lived cache of every historical transcript.
  const startupSessionDetails: { current: LoadAllSessionsResult['sessions'] | undefined } = {
    current: undefined
  }
  let wslSetupSessionsReconciliation: Promise<void> | undefined
  const reconcileWslSetupSessions = async (sessions: readonly SessionSummary[]): Promise<void> => {
    wslSetupSessionsReconciliation ??= wslSetupSessions.reconcileBoundSessions(
      new Set(sessions.map((session) => session.id))
    )
    try {
      await wslSetupSessionsReconciliation
    } catch (error) {
      wslSetupSessionsReconciliation = undefined
      throw error
    }
  }
  const ensureSessionProjection = async (): Promise<{
    result?: LoadAllSessionsResult
    sessions: SessionSummary[]
  }> => {
    // Reconcile a JSON write from a committed Project tombstone before deletion recovery removes
    // that temporary authority. Its SQLite facts remain part of retained Project history.
    await sessionRepository.reconcilePendingSessionProjection()
    const recovery = await sessionCatalogHydration.recoverProjectDeletions()
    if (!recovery.isComplete) {
      const result = recovery.result
      const sessions = await sessionRepository.summarizeReadOnlyAuthority(result)
      await sessionPersistenceCoordinator.replaceSessionMetadata(sessions, false)
      return { result, sessions: await wslSetupSessions.projectSessionSummaries(sessions) }
    }
    const projection = await sessionRepository.ensureSessionProjection(loadAllSessions)
    const result = projection.result
    const catalogComplete = result ? canReconcileSessionAbsences(result) : true
    await sessionPersistenceCoordinator.replaceSessionMetadata(projection.sessions, catalogComplete)
    if (catalogComplete) await reconcileWslSetupSessions(projection.sessions)
    return {
      ...projection,
      result,
      sessions: await wslSetupSessions.projectSessionSummaries(projection.sessions)
    }
  }
  const uncoordinatedSessionPersistenceBackend: SessionPersistenceBackend = {
    loadAll: loadAllSessions,
    list: async () => {
      const projection = await ensureSessionProjection()
      return {
        sessions: projection.sessions,
        manifest: projection.result?.manifest ?? (await sessionRepository.loadManifest()),
        diagnostics: sessionProjectionDiagnostics.resolve(projection.result?.diagnostics)
      }
    },
    loadUsage: async () => {
      await ensureSessionProjection()
      await auxiliaryUsageRecorder.flush()
      await settingsService.classification.flushUsage()
      return sessionRepository.loadSessionUsageProjection()
    },
    loadOne: async ({ projectId, sessionId }) => {
      const recovery = await recoverProjectDeletionsForSessionRead(
        projectDeletionCoordinator,
        sessionPersistenceCoordinator
      )
      if (!recovery.isComplete) {
        return recovery.result.sessions.find(
          (session) => session.projectId === projectId && session.id === sessionId
        )
      }
      const session = await sessionRepository.loadSession(projectId, sessionId)
      return session && sessionEnabledComputeHostsOwnerRef.current
        ? sessionEnabledComputeHostsOwnerRef.current.reconcileSession(session)
        : session
    },
    saveSession: async (session, options, authority) => {
      const created =
        (await sessionRepository.loadSession(session.projectId, session.id)) === undefined
      const save = (candidate: PersistedChatSession): Promise<PersistedChatSession> =>
        authority
          ? sessionPersistenceCoordinator.saveSession(candidate, options, authority)
          : sessionPersistenceCoordinator.saveSession(candidate, options)
      let durableSession = created
        ? await (() => {
            if (!sessionEnabledComputeHostsOwnerRef.current) {
              throw new Error('Session enabled Compute Host ownership is not initialized.')
            }
            return sessionEnabledComputeHostsOwnerRef.current.createSession(session, save)
          })()
        : await save(session)
      // Flush any approved host.agents.switch binding stashed while this session was not yet durable,
      // so the approved target survives a restart before the next message (the in-memory binding
      // alone does not persist across restart).
      durableSession = await pendingSpecialistBindings.flush(
        durableSession.id,
        durableSession,
        (binding) =>
          sessionPersistenceCoordinator.saveSessionSpecialistBinding(
            durableSession,
            binding.specialistId,
            binding.specialistBindingPending
          )
      )
      return { created, session: durableSession }
    },
    setDelegationPolicy: async (projectId, sessionId, policy) => {
      return sessionPersistenceCoordinator.setSessionDelegationPolicy(projectId, sessionId, policy)
    },
    updateArchive: async (request) => {
      return archiveCoordinator.updateSessionArchive(request)
    },
    deleteSession: withSessionDeletionCleanup(
      (projectId, sessionId) => sessionPersistenceCoordinator.deleteSession(projectId, sessionId),
      (projectId, sessionId) =>
        permissionGrantRegistry.prune({ kind: 'session', projectId, sessionId })
    ),
    saveManifest: async (request) => {
      return sessionPersistenceCoordinator.saveManifest(request)
    }
  }
  const sessionPersistenceBackend = coordinateSessionPersistenceWithProjectDeletions(
    uncoordinatedSessionPersistenceBackend,
    projectDeletionCoordinator
  )
  return {
    pendingSpecialistBindings,
    loadAllSessions,
    startupSessionDetails,
    ensureSessionProjection,
    sessionPersistenceBackend
  }
}
