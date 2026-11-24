import { createLogger, diagnosticErrorFields, errorLogFields } from '@aipoch/diagnostics/node'
import { MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID } from '../../shared/lifecycle-events'
import { SandboxNetworkApprovalOwner } from '../acp/sandbox-network-approval-owner'
import { broadcastToRenderers } from '../renderer-broadcast'
import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  SessionSummary,
  SessionLoadWarning
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
import {
  DeferredSessionRecovery,
  type RecoveredSessionReference
} from '../session-persistence/deferred-recovery'
import { SessionProjectionDiagnostics } from '../session-persistence/projection-diagnostics'
import { selectSessionDetailsStartupCandidates } from '../session-details/startup-catalog'
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
    | 'readSessionRuntimeContext'
    | 'patchSessionRuntimeContext'
    | 'loadSessionForContinuation'
    | 'containsMessageOnActiveBranch'
    | 'deleteSession'
    | 'recoverStartupSession'
    | 'prepareSessionRecovery'
    | 'commitSessionRecovery'
    | 'recoveryCatalogGeneration'
    | 'reconcileRecoveryCatalog'
    | 'cleanupRecoveredSession'
    | 'runSessionMutation'
    | 'loadAll'
    | 'loadAllReadOnly'
    | 'replaceSessionMetadata'
    | 'saveManifest'
    | 'saveSession'
    | 'saveSessionSpecialistBinding'
    | 'setSessionDelegationPolicy'
    | 'projectRuntimeSession'
    | 'listRuntimeTerminalFailures'
    | 'recordSessionRecordProblem'
    | 'retryRuntimeTerminalCommit'
    | 'projectRuntimeSessionSummaries'
  >
  projectDeletionCoordinator: ProjectDeletionCoordinator
  archiveCoordinator: ArchiveCoordinator
  sessionEnabledComputeHostsOwnerRef: { current?: SessionEnabledComputeHostsOwner }
}): {
  sandboxNetworkApprovalOwner: SandboxNetworkApprovalOwner
  pendingSpecialistBindings: PendingSessionSpecialistBindings
  loadAllSessions: () => Promise<LoadAllSessionsResult>
  loadStartupSessions: () => Promise<PersistedChatSession[]>
  beginStartupProjection: () => Promise<unknown>
  createDeferredRecovery: (
    recoverDetails: (session: PersistedChatSession) => Promise<void>,
    complete?: (
      sessions: readonly RecoveredSessionReference[],
      cancelled: () => boolean
    ) => Promise<void>
  ) => DeferredSessionRecovery
  ensureSessionProjection: () => Promise<{
    result?: LoadAllSessionsResult
    recoveredSessions?: PersistedChatSession[]
    sessions: SessionSummary[]
  }>
  sessionPersistenceBackend: ReturnType<typeof coordinateSessionPersistenceWithProjectDeletions>
} {
  const log = createLogger('session-network-approval')
  const recoveryStartupCutoff = Date.now()
  // One host owner is shared by hydration and every provider runtime. Recovery must not
  // mistake another runtime's in-flight Settings transaction for an abandoned decision.
  const sandboxNetworkApprovalOwner = new SandboxNetworkApprovalOwner(
    sessionPersistenceCoordinator,
    (session) => {
      try {
        broadcastToRenderers('session:updated', {
          session,
          originClientId: MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID
        })
      } catch (error) {
        log.warn('network approval Session publication failed', errorLogFields(error))
      }
    },
    settingsService.allowNotebookNetworkDomain.bind(settingsService),
    settingsService.allowNotebookNetworkDestination.bind(settingsService)
  )
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
  const recordSizeProblems = (warnings: readonly SessionLoadWarning[] | undefined): void => {
    for (const warning of warnings ?? []) {
      if (warning.kind !== 'too-large' || !warning.fileName.endsWith('.json')) continue
      const sessionId = warning.fileName.slice(0, -'.json'.length)
      if (sessionId)
        sessionPersistenceCoordinator.recordSessionRecordProblem(
          warning.projectId,
          sessionId,
          'size-limit'
        )
    }
  }
  const loadAllSessions = async (): Promise<LoadAllSessionsResult> => {
    const result = await sessionCatalogHydration.loadAll()
    // Hydration has released the catalog scheduler before recovery patches individual Sessions.
    if (canReconcileSessionAbsences(result)) {
      for (let index = 0; index < result.sessions.length; index++) {
        try {
          const candidate = result.sessions[index]
          if (candidate.projectId)
            result.sessions[index] = await sandboxNetworkApprovalOwner.recoverSession(
              result.sessions[index]
            )
        } catch (error) {
          // Keep healthy transcripts navigable and the saved decision available for a later retry.
          log.warn('saved network approval recovery failed', errorLogFields(error))
          result.diagnostics = {
            ...result.diagnostics,
            warnings: result.diagnostics?.warnings ?? [],
            isComplete: false,
            failure: 'startup-reconciliation-failed'
          }
        }
      }
    }
    recordSizeProblems(result.diagnostics?.warnings)
    // Startup and non-renderer readers can recover historical files before the first list call.
    // Retain their warnings in the same cache used by subsequent projection-only reads.
    sessionProjectionDiagnostics.resolve(result.diagnostics)
    return result
  }
  type SessionProjectionLoad = Awaited<ReturnType<typeof sessionRepository.ensureSessionProjection>>
  let startupProjection: Promise<SessionProjectionLoad> | undefined
  let startupProjectionSettled = false
  let metadataCompleteGeneration: number | undefined
  let metadataWriteTail = Promise.resolve()
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
    recoveredSessions?: PersistedChatSession[]
    sessions: SessionSummary[]
  }> => {
    const metadataGeneration = sessionPersistenceCoordinator.recoveryCatalogGeneration()
    // Reconcile a JSON write from a committed Project tombstone before deletion recovery removes
    // that temporary authority. Its SQLite facts remain part of retained Project history.
    await sessionRepository.reconcilePendingSessionProjection()
    const recovery = await sessionCatalogHydration.recoverProjectDeletions()
    if (!recovery.isComplete) {
      const result = recovery.result
      const sessions = await sessionRepository.summarizeReadOnlyAuthority(result)
      await replaceSessionMetadata(sessions, false, metadataGeneration)
      return { result, sessions: await wslSetupSessions.projectSessionSummaries(sessions) }
    }
    const projection = await sessionRepository.ensureSessionProjection(loadAllSessions)
    const result = projection.result
    const catalogComplete = result ? canReconcileSessionAbsences(result) : true
    await replaceSessionMetadata(projection.sessions, catalogComplete, metadataGeneration)
    if (catalogComplete) await reconcileWslSetupSessions(projection.sessions)
    return {
      ...projection,
      result,
      sessions: await wslSetupSessions.projectSessionSummaries(projection.sessions)
    }
  }
  const replaceSessionMetadata = (
    sessions: readonly SessionSummary[],
    isComplete: boolean,
    expectedGeneration: number
  ): Promise<void> => {
    const write = metadataWriteTail.then(async () => {
      if (!isComplete && metadataCompleteGeneration === expectedGeneration) return
      const generationMatches =
        sessionPersistenceCoordinator.recoveryCatalogGeneration() === expectedGeneration
      await sessionPersistenceCoordinator.replaceSessionMetadata(
        sessions,
        isComplete,
        expectedGeneration
      )
      if (
        isComplete &&
        generationMatches &&
        sessionPersistenceCoordinator.recoveryCatalogGeneration() === expectedGeneration
      )
        metadataCompleteGeneration = expectedGeneration
    })
    metadataWriteTail = write.catch(() => undefined)
    return write
  }
  const beginStartupProjection = (): Promise<SessionProjectionLoad> => {
    if (startupProjection) return startupProjection
    startupProjectionSettled = false
    startupProjection = ensureSessionProjection()
    void startupProjection.then(
      () => {
        startupProjectionSettled = true
        broadcastToRenderers('sessions:catalog-changed', undefined)
      },
      () => {
        startupProjectionSettled = true
        broadcastToRenderers('sessions:catalog-changed', undefined)
      }
    )
    return startupProjection
  }
  const listSessionProjection = async (): Promise<{
    projection: SessionProjectionLoad
    catalogHydrationPending: boolean
  }> => {
    const startup = startupProjection ?? beginStartupProjection()
    if (startupProjectionSettled) {
      const projection = await ensureSessionProjection()
      return { projection, catalogHydrationPending: false }
    }
    const sessions = await sessionRepository.listProjectionSummaries()
    if (startup !== startupProjection || startupProjectionSettled) {
      const projection = await ensureSessionProjection()
      return { projection, catalogHydrationPending: false }
    }
    await replaceSessionMetadata(
      sessions,
      false,
      sessionPersistenceCoordinator.recoveryCatalogGeneration()
    )
    return { projection: { sessions }, catalogHydrationPending: true }
  }
  const uncoordinatedSessionPersistenceBackend: SessionPersistenceBackend = {
    listRuntimeTerminalFailures: () => sessionPersistenceCoordinator.listRuntimeTerminalFailures(),
    retryRuntimeTerminalCommit: (request) =>
      sessionPersistenceCoordinator.retryRuntimeTerminalCommit(request),
    loadAll: async () => {
      const result = await loadAllSessions()
      return {
        ...result,
        sessions: result.sessions.map((session) =>
          sessionPersistenceCoordinator.projectRuntimeSession(session)
        )
      }
    },
    list: async () => {
      const { projection, catalogHydrationPending } = await listSessionProjection()
      const diagnostics = sessionProjectionDiagnostics.resolve(projection.result?.diagnostics)
      return {
        sessions: await sessionPersistenceCoordinator.projectRuntimeSessionSummaries(
          projection.sessions
        ),
        manifest: projection.result?.manifest ?? (await sessionRepository.loadManifest()),
        diagnostics: catalogHydrationPending
          ? { ...diagnostics, catalogHydrationPending: true }
          : diagnostics
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
        const session = recovery.result.sessions.find(
          (session) =>
            session.id === sessionId && (projectId === undefined || session.projectId === projectId)
        )
        return session && sessionPersistenceCoordinator.projectRuntimeSession(session)
      }
      const resolvedProjectId =
        projectId ?? (await sessionRepository.locateSession(sessionId))?.projectId
      if (!resolvedProjectId) return undefined
      const session = await sessionRepository.loadSession(resolvedProjectId, sessionId)
      if (!session || (projectId !== undefined && session.projectId !== projectId)) return undefined
      const reconciled =
        session && sessionEnabledComputeHostsOwnerRef.current
          ? await sessionEnabledComputeHostsOwnerRef.current.reconcileSession(session)
          : session
      return (
        reconciled &&
        sessionPersistenceCoordinator.projectRuntimeSession(
          await sandboxNetworkApprovalOwner.recoverSession(reconciled)
        )
      )
    },
    loadHistoryPage: async (request) => {
      const recovery = await recoverProjectDeletionsForSessionRead(
        projectDeletionCoordinator,
        sessionPersistenceCoordinator
      )
      if (!recovery.isComplete) return undefined
      return sessionRepository.loadSessionHistoryPage(request)
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
  // Retained for recovery integration tests and explicit maintenance flows. Production startup
  // does not call this path because Session Details recovery is local to an opened Session.
  const loadStartupSessions = async (): Promise<PersistedChatSession[]> => {
    const startedAt = performance.now()
    const projection = await beginStartupProjection()
    // An exceptional complete rebuild has already performed recovery. Never reinterpret a
    // failed/incomplete catalog as a complete candidate set for mutating details recovery.
    if (projection.result && !canReconcileSessionAbsences(projection.result)) return []
    const candidates =
      projection.recoveredSessions ??
      (projection.result ? selectSessionDetailsStartupCandidates(projection.result) : undefined) ??
      []
    const manifest = projection.result?.manifest ?? (await sessionRepository.loadManifest())
    const selected = projection.sessions.find((summary) => summary.id === manifest.lastSessionId)
    if (selected && !candidates.some((session) => session.id === selected.id)) {
      const session = selected.needsStartupRecovery
        ? await sessionPersistenceCoordinator.recoverStartupSession(selected.projectId, selected.id)
        : await uncoordinatedSessionPersistenceBackend.loadOne({
            projectId: selected.projectId,
            sessionId: selected.id
          })
      if (session) candidates.push(session)
    }
    createLogger('session-persistence').info('startup Session catalog hydrated', {
      mode: 'startup',
      durationMs: performance.now() - startedAt,
      summaryCount: projection.sessions.length,
      hydratedCount: candidates.length,
      rebuiltCatalog: projection.result !== undefined
    })
    return candidates
  }
  const completeRecoveryCatalog = async (
    references: readonly RecoveredSessionReference[],
    cancelled: () => boolean
  ): Promise<void> => {
    const recoveryLog = createLogger('session-persistence')
    const skipped = (reason: string, sessionId?: string): void => {
      recoveryLog.info('deferred Session catalog cleanup skipped', {
        mode: 'background',
        reason,
        sessionId,
        sessionCount: references.length
      })
    }
    await projectDeletionCoordinator.recoverPendingDeletions()
    if (cancelled()) return
    const generation = sessionPersistenceCoordinator.recoveryCatalogGeneration()
    const snapshot = await sessionRepository.scanSessionIdentities()
    if (cancelled()) return
    if (!snapshot.isComplete) {
      skipped('incomplete-catalog')
      return
    }
    const summaries = await sessionRepository.loadSessionSummaries()
    const refs = new Map(references.map((session) => [session.id, session]))
    // Earlier sweep entries may already be stale. Completeness alone is insufficient for cwd
    // cleanup; every reference must still describe the latest durable revision and identity.
    if (
      snapshot.sessions.length !== refs.size ||
      summaries.length !== refs.size ||
      !snapshot.sessions.every(({ projectId, id }) => refs.get(id)?.projectId === projectId) ||
      !summaries.every((summary) => refs.get(summary.id)?.revision === summary.revision)
    ) {
      skipped('stale-references')
      return
    }
    const guard = (operation: () => Promise<void>): Promise<boolean> =>
      sessionRepository.runWithSessionCatalogSnapshot(snapshot, operation)
    const failures: unknown[] = []
    for (const reference of references) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (cancelled()) return
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (cancelled()) return
          const prepared = await sessionPersistenceCoordinator.prepareSessionRecovery(
            reference.projectId,
            reference.id
          )
          if (prepared?.status !== 'prepared' || prepared.expectedRevision !== reference.revision) {
            skipped('session-authority-changed', reference.id)
            return
          }
          const result = await sessionPersistenceCoordinator.cleanupRecoveredSession(
            prepared,
            generation,
            guard,
            recoveryStartupCutoff,
            cancelled
          )
          if (result === 'stale') {
            skipped('catalog-or-session-changed', reference.id)
            return
          }
          if (result === 'complete') break
          if (attempt === 2) throw new Error('Deferred Session source cleanup remains busy.')
          await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 1000))
        }
      } catch (error) {
        recoveryLog.warn('deferred Session source cleanup failed', {
          ...diagnosticErrorFields(error),
          mode: 'background',
          projectId: reference.projectId,
          sessionId: reference.id
        })
        failures.push(error)
      }
    }
    const reconciled = await sessionPersistenceCoordinator.reconcileRecoveryCatalog(
      references,
      generation,
      guard,
      cancelled
    )
    if (reconciled && !cancelled()) broadcastToRenderers('sessions:catalog-changed', undefined)
    if (!reconciled && !cancelled()) skipped('catalog-changed')
    if (failures.length)
      throw new AggregateError(failures, 'Deferred Session source cleanup is incomplete.')
  }

  const createDeferredRecovery = (
    recoverDetails: (session: PersistedChatSession) => Promise<void>,
    complete: (
      sessions: readonly RecoveredSessionReference[],
      cancelled: () => boolean
    ) => Promise<void> = completeRecoveryCatalog
  ): DeferredSessionRecovery =>
    new DeferredSessionRecovery({
      list: async () => (await ensureSessionProjection()).sessions,
      prepare: (projectId, sessionId) =>
        sessionPersistenceCoordinator.prepareSessionRecovery(projectId, sessionId),
      missing: (projectId, sessionId) =>
        sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, () =>
          sessionRepository.reconcileMissingSessionProjection(projectId, sessionId)
        ),
      commit: (prepared) => sessionPersistenceCoordinator.commitSessionRecovery(prepared),
      recovered: async (session) => {
        const reconciled = sessionEnabledComputeHostsOwnerRef.current
          ? await sessionEnabledComputeHostsOwnerRef.current.reconcileSession(session)
          : session
        const recovered = await sandboxNetworkApprovalOwner.recoverSession(reconciled)
        await recoverDetails(recovered)
        return recovered
      },
      complete
    })
  const sessionPersistenceBackend = coordinateSessionPersistenceWithProjectDeletions(
    uncoordinatedSessionPersistenceBackend,
    projectDeletionCoordinator
  )
  return {
    sandboxNetworkApprovalOwner,
    pendingSpecialistBindings,
    loadAllSessions,
    loadStartupSessions,
    beginStartupProjection,
    createDeferredRecovery,
    ensureSessionProjection,
    sessionPersistenceBackend
  }
}
