import { ProjectFilesReconciliationError } from '../project-files/repository'
import type { ProjectFileSource, ProjectFilesChangedEvent } from '../../shared/project-files'
import type { ReconcilePendingArtifactsRequest } from '../../shared/artifacts'
import {
  SessionDeletionCommittedError,
  type DelegationPolicy,
  type LoadAllSessionsResult,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedSideChat,
  type PersistedSideChatRelay,
  type SaveSessionOptions,
  type SaveSessionManifestRequest,
  type FailTaskSessionRunRequest,
  type SettleTaskSessionCompletionRequest,
  type StageTaskSessionCompletionRequest,
  type UpdateSessionArchiveRequest,
  type SessionRuntimeContext,
  type SessionLoadFailure,
  type SessionLoadWarning
} from '../../shared/session-persistence'
import type {
  AttachDelegatedMessageArtifactsInput,
  AttemptAgentEventInput,
  ChildRecord,
  CompleteChildTurnInput,
  CreateChildrenInput,
  CreatedChild,
  CreatedNamedChild,
  DelegatedWorkRecordCommands,
  AdmitMessageCommandInput,
  SettleMessageInput,
  StartMessageDispatchInput,
  SessionKey,
  StartContinuationAttemptInput,
  StartAttemptRuntimeInput,
  StartPendingMessageTurnInput,
  TransitionAttemptInput,
  AdmitQuestionInput,
  UpdateQuestionDraftInput,
  ConfirmQuestionInput
} from '../delegation/session-records'
import type { SessionDeletionReceipt } from '../artifacts/provenance-message-snapshot'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'
import * as computeHostAccess from '../compute/session-compute-host-access'
import type { ProjectSessionDeletionState } from './repository'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import { saveSessionWithRevision } from './save-session'
import {
  SessionPersistenceStateOwner,
  SessionRuntimeContextRevisionConflictError,
  type AppendUserMessageToInteractionCommand,
  type PatchSessionRuntimeContextCommand,
  type SessionMetadata,
  type SessionMetadataSnapshot,
  type SessionSaveAuthority
} from './state-owner'
import {
  SessionSideChatPersistenceOwner,
  type AppendSideChatRelayCommand,
  type ClearSideChatCommand,
  type CommitSideChatRelaysCommand,
  type SaveSideChatProjectionCommand
} from './side-chat-owner'
import {
  SessionPersistenceDeletionOwner,
  type ComputeJobDeletionParticipant,
  type ProjectSessionDeletionResult,
  type SessionWorkspaceOwnership
} from './deletion-owner'
import {
  SessionPersistenceReconciliationOwner,
  type ArtifactStorageReconciler,
  type PendingArtifactFinalizationRecovery,
  type SessionPermissionGrantReconciliation,
  type SessionUploadPersistence
} from './reconciliation-owner'
import {
  recoverInterruptedDelegatedWorkSession,
  SessionDelegatedWorkPersistenceOwner
} from './delegated-work-owner'
import { SessionPersistenceOperationScheduler } from './operation-scheduler'
import { assertSessionIdentityOwnership, isSessionCatalogAuthoritative } from './catalog-authority'
import {
  createSafeSessionUpdatePublisher as safeSessionUpdates,
  type SessionUpdatePublisher
} from './session-update-publication'
import { sanitizeRendererSaveSessionOptions } from './renderer-save-options'
import { mutateSessionDetailsAuthority } from './session-details-authority'
const SESSION_CPU_TRACE_ENABLED = process.env.OPEN_SCIENCE_PERF_SESSION_TRACE === '1'
type SessionMutationRepository = {
  loadAllWithDiagnostics(options?: { mode?: 'repair' | 'read-only' }): Promise<{
    result: LoadAllSessionsResult
    isComplete: boolean
    warnings?: SessionLoadWarning[]
    scanMetrics?: {
      projectDirectoryCount: number
      sessionFileCount: number
      sessionBytes: number
    }
    failure?: SessionLoadFailure
  }>
  loadProjectWithDiagnostics(projectId: string): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }>
  loadCommittedProjectWithDiagnostics(projectId: string): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }>
  loadSessionWithDiagnostics(
    projectId: string,
    sessionId: string
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  assertSessionIdentityOwnership(sessionId: string, expectedProjectId: string): Promise<void>
  saveSession(
    session: PersistedChatSession,
    expectedRevision?: number
  ): Promise<PersistedChatSession | void>
  saveCommittedProjectSession(session: PersistedChatSession): Promise<void>
  deleteSession(projectId: string, sessionId: string): Promise<void>
  deleteProjectSessions(projectId: string): Promise<void>
  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState>
  markCommittedProjectSessionsPrepared(projectId: string): Promise<void>
  completeProjectSessionDeletion(projectId: string): Promise<void>
  listLegacyProjectSessionTombstones(): Promise<string[]>
  saveManifest(request: SaveSessionManifestRequest): Promise<void>
}
type SessionFileIndex = {
  syncSession(
    session: PersistedChatSession,
    options?: { force?: boolean }
  ): Promise<ProjectFileSource[]>
  softDeleteSession(projectId: string, sessionId: string): Promise<ManagedFileSoftDeleteToken>
  restoreSession(
    projectId: string,
    sessionId: string,
    token: ManagedFileSoftDeleteToken
  ): Promise<void>
  softDeleteProject(projectId: string): Promise<ManagedFileSoftDeleteToken>
  reconcileProjectSessions(projectId: string, sessions: PersistedChatSession[]): Promise<void>
  reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void>
  markReconciliationIncomplete(projectId?: string): void
}

type SessionProvenancePersistence = {
  validateFinalizedMessageBindings(session: PersistedChatSession): Promise<void>
  captureFinalizedMessages(session: PersistedChatSession): Promise<void>
  reconcileSessionDeletions(activeSessions: PersistedChatSession[]): Promise<void>
  prepareSessionDeletion(session: PersistedChatSession): Promise<SessionDeletionReceipt>
  completeSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
  abortSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
}

type SessionDeletionHandlers = {
  commit(sessionIds: string[]): Promise<void>
  reconcile(existingSessionIds: string[], archivedSessionIds: string[]): Promise<void>
}

const emitRecoverableDiagnostic = (
  log: Logger,
  message: string,
  fields: Record<string, string | number | boolean | null | undefined>
): void => {
  try {
    log.warn(message, fields)
  } catch {
    // Diagnostics must never change Session durability or recovery behavior.
  }
}

// Serializes authoritative Session JSON and derived file-index mutations at their owning Project and
// Session scopes. Catalog-wide reconciliation uses an exclusive barrier so unrelated Projects overlap
// without allowing a late save to race or revive durable deletion authority.
class SessionPersistenceCoordinator implements DelegatedWorkRecordCommands {
  private readonly operationScheduler = new SessionPersistenceOperationScheduler()
  private readonly deletedSessions = new Set<string>()
  private readonly deletedProjects = new Set<string>()
  private readonly stateOwner: SessionPersistenceStateOwner
  private readonly sideChatOwner: SessionSideChatPersistenceOwner
  private readonly deletionOwner: SessionPersistenceDeletionOwner
  private readonly reconciliationOwner: SessionPersistenceReconciliationOwner
  private readonly delegatedWorkOwner: SessionDelegatedWorkPersistenceOwner
  private destructiveStartupWindowOpen = true
  private delegatedStartupRecoveryComplete = false
  private sessionDeletionHandlers: SessionDeletionHandlers | undefined

  constructor(
    private readonly repository: SessionMutationRepository,
    private readonly fileIndex: SessionFileIndex,
    private readonly onFilesChanged?: (event: ProjectFilesChangedEvent) => void,
    provenance?: SessionProvenancePersistence,
    uploads?: SessionUploadPersistence,
    artifactStorage?: ArtifactStorageReconciler,
    permissionGrants?: SessionPermissionGrantReconciliation,
    private readonly log: Logger = createLogger('session-persistence'),
    private readonly computeJobs?: ComputeJobDeletionParticipant,
    onDelegatedWorkSessionUpdated?: SessionUpdatePublisher,
    onDelegationPolicyUpdated?: (session: PersistedChatSession) => void,
    private readonly workspaceOwnership?: SessionWorkspaceOwnership
  ) {
    const publishSessionUpdate = safeSessionUpdates(onDelegatedWorkSessionUpdated, log)
    this.stateOwner = new SessionPersistenceStateOwner({
      repository,
      fileIndex,
      provenance,
      uploads,
      log,
      assertMutable: (projectId, sessionId, operation) =>
        this.assertMutable(projectId, sessionId, operation),
      notifyFilesChanged: (event) => this.notifyFilesChanged(event),
      notifyRuntimeContextSessionUpdated: (session) =>
        publishSessionUpdate(session, 'runtime-context'),
      notifyDelegationPolicyUpdated: (session) => onDelegationPolicyUpdated?.(session)
    })
    this.sideChatOwner = new SessionSideChatPersistenceOwner({
      repository,
      assertMutable: (projectId, sessionId) => this.assertMutable(projectId, sessionId, 'mutate'),
      recordSession: (session) => this.stateOwner.recordSession(session),
      notifySessionUpdated: (session) => publishSessionUpdate(session, 'runtime-context')
    })
    this.deletionOwner = new SessionPersistenceDeletionOwner({
      repository,
      fileIndex,
      stateOwner: this.stateOwner,
      provenance,
      uploads,
      computeJobs,
      workspaceOwnership,
      log,
      assertArchiveMutable: (projectId, sessionId) => {
        if (this.deletedProjects.has(projectId)) {
          throw new Error('Cannot archive a Session whose project has been deleted.')
        }
        if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
          throw new Error('Cannot archive a Session that has been deleted.')
        }
      },
      notifyFilesChanged: (event) => this.notifyFilesChanged(event),
      notifySessionsDeleted: (sessionIds) => this.notifySessionsDeleted(sessionIds)
    })
    this.reconciliationOwner = new SessionPersistenceReconciliationOwner({
      repository,
      fileIndex,
      provenance,
      uploads,
      artifactStorage,
      permissionGrants
    })
    this.delegatedWorkOwner = new SessionDelegatedWorkPersistenceOwner({
      repository,
      runExclusive: (key, work) =>
        key
          ? this.operationScheduler.runSession(key.projectId, key.sessionId, work)
          : this.operationScheduler.runGlobal(work),
      assertMutable: (projectId, sessionId) => this.assertMutable(projectId, sessionId, 'mutate'),
      markStartupRecoveryComplete: () => {
        this.delegatedStartupRecoveryComplete = true
      },
      notifySessionUpdated: (session) => publishSessionUpdate(session, 'delegated-work')
    })
  }

  containsMessageOnActiveBranch(
    projectId: string,
    sessionId: string,
    messageId: string
  ): Promise<boolean> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.stateOwner.containsMessageOnActiveBranch(projectId, sessionId, messageId)
    )
  }

  loadSessionForContinuation(projectId: string, sessionId: string): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(projectId, sessionId, async () => {
      const loaded = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
      if (loaded.status !== 'found') {
        throw new Error(`Cannot prepare a durable continuation for a ${loaded.status} Session.`)
      }
      return structuredClone(loaded.session)
    })
  }

  setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void {
    this.sessionDeletionHandlers = handlers
  }

  sessionMetadataSnapshot(): Promise<SessionMetadataSnapshot> {
    return this.operationScheduler.runGlobal(async () => this.stateOwner.metadataSnapshot())
  }

  replaceSessionMetadata(sessions: readonly SessionMetadata[], isComplete: boolean): Promise<void> {
    return this.operationScheduler.runGlobal(async () => {
      this.stateOwner.replaceMetadata(sessions, isComplete)
    })
  }

  // Degraded authority read: keeps healthy transcripts navigable while writes remain blocked.
  loadAllReadOnly(): Promise<LoadAllSessionsResult> {
    return this.operationScheduler.runGlobal(async () => {
      this.stateOwner.beginHydration()
      // Once any renderer has observed a degraded snapshot, later loads are no longer allowed to
      // treat the process as an untouched startup boundary for destructive cleanup.
      this.destructiveStartupWindowOpen = false
      this.fileIndex.markReconciliationIncomplete()
      const operation = startDiagnosticOperation(this.log, {
        operation: 'session-hydration',
        cpuUsage: SESSION_CPU_TRACE_ENABLED ? process.cpuUsage : undefined,
        fields: { mode: 'read-only', startupCleanupEligible: false }
      })
      operation.phase('load-authority')
      let scan: Awaited<ReturnType<SessionMutationRepository['loadAllWithDiagnostics']>>
      try {
        scan = await this.repository.loadAllWithDiagnostics({ mode: 'read-only' })
      } catch (error) {
        operation.fail(error, { status: 'failed', hydrationAvailable: false })
        throw error
      }
      this.stateOwner.replaceMetadata(scan.result.sessions, false)
      operation.phase('authority-loaded', {
        sessionCount: scan.result.sessions.length,
        warningCount: scan.warnings?.length ?? 0,
        ...scan.scanMetrics
      })
      operation.complete({
        status: 'degraded',
        sessionCount: scan.result.sessions.length,
        warningCount: scan.warnings?.length ?? 0
      })

      return {
        ...scan.result,
        diagnostics: {
          isComplete: false,
          warnings: scan.warnings ?? [],
          failure: 'startup-reconciliation-failed'
        }
      }
    })
  }

  /**
   * Loads durable sessions, reconciles Upload storage, and backfills the file projection only after a
   * complete scan has restored active ownership. Chat hydration remains available on any failure.
   */
  loadAll(): Promise<LoadAllSessionsResult> {
    return this.operationScheduler.runGlobal(async () => {
      this.stateOwner.beginHydration()
      // Public loadAll can be called by multiple renderers/tasks. Only the first invocation in this
      // process is a startup boundary; consume it before any await so failures and partial scans cannot
      // reopen destructive cleanup while live clients may already hold the legacy projection.
      const mayRunDestructiveStartupCleanup = this.destructiveStartupWindowOpen
      this.destructiveStartupWindowOpen = false
      const operation = startDiagnosticOperation(this.log, {
        operation: 'session-hydration',
        cpuUsage: SESSION_CPU_TRACE_ENABLED ? process.cpuUsage : undefined,
        fields: {
          mode: 'reconcile',
          startupCleanupEligible: mayRunDestructiveStartupCleanup
        }
      })
      operation.phase('load-authority')
      let scan: Awaited<ReturnType<SessionMutationRepository['loadAllWithDiagnostics']>>
      try {
        scan = await this.repository.loadAllWithDiagnostics()
      } catch (error) {
        operation.fail(error, { status: 'failed', hydrationAvailable: false })
        throw error
      }
      const hasAuthoritativeSessionCatalog = isSessionCatalogAuthoritative(scan)
      this.stateOwner.replaceMetadata(scan.result.sessions, hasAuthoritativeSessionCatalog)
      operation.phase('authority-loaded', {
        sessionCount: scan.result.sessions.length,
        warningCount: scan.warnings?.length ?? 0,
        ...scan.scanMetrics
      })
      scan.result.diagnostics = {
        isComplete: scan.isComplete,
        warnings: scan.warnings ?? [],
        failure: scan.failure
      }
      let result = scan.result
      let sessions = scan.result.sessions

      if (!hasAuthoritativeSessionCatalog) {
        // Without the full active-session set, absent rows may still be owned by unreadable or
        // quarantined JSON, so every derived owner must remain incomplete and untouched.
        this.fileIndex.markReconciliationIncomplete()
        operation.complete({
          status: 'partial',
          sessionCount: sessions.length,
          warningCount: scan.warnings?.length ?? 0
        })
        return result
      }

      if (mayRunDestructiveStartupCleanup && this.workspaceOwnership) {
        operation.phase('reconcile-provisional-managed-workspaces')
        try {
          await this.workspaceOwnership.reconcileProvisional(sessions)
        } catch (error) {
          emitRecoverableDiagnostic(this.log, 'managed workspace reconciliation failed', {
            operation: 'session-hydration',
            phase: 'reconcile-provisional-managed-workspaces',
            outcome: 'degraded',
            ...diagnosticErrorFields(error)
          })
        }
      }

      if (!this.delegatedStartupRecoveryComplete) {
        operation.phase('recover-delegation')
        let recoveryFailure: unknown
        let recoveryFailureCount = 0
        for (let index = 0; index < sessions.length; index += 1) {
          try {
            const recovery = recoverInterruptedDelegatedWorkSession(sessions[index])
            if (recovery.interrupted.length === 0) continue
            const persistedRecovery = await saveSessionWithRevision(
              this.repository,
              recovery.session
            )
            sessions = sessions.map((candidate, candidateIndex) =>
              candidateIndex === index ? persistedRecovery : candidate
            )
            result = { ...result, sessions }
          } catch (error) {
            recoveryFailure ??= error
            recoveryFailureCount += 1
            this.fileIndex.markReconciliationIncomplete(sessions[index].projectId)
            const sessionRecovery = startDiagnosticOperation(this.log, {
              operation: 'delegation-recovery',
              fields: { mode: 'startup' }
            })
            sessionRecovery.phase('recover-session')
            sessionRecovery.fail(error, { status: 'degraded', retryable: true })
          }
        }
        if (recoveryFailureCount > 0) {
          this.stateOwner.replaceMetadata(sessions, false)
          result = {
            ...result,
            sessions,
            diagnostics: {
              isComplete: false,
              warnings: scan.warnings ?? [],
              failure: 'startup-reconciliation-failed'
            }
          }
          operation.fail(recoveryFailure, {
            status: 'degraded',
            hydrationAvailable: true,
            sessionCount: sessions.length,
            warningCount: scan.warnings?.length ?? 0,
            recoveryFailureCount
          })
          return result
        }
        this.delegatedStartupRecoveryComplete = true
      }

      let degradedReconciliationCount = 0
      operation.phase('reconcile-unread-sessions')
      try {
        await this.sessionDeletionHandlers?.reconcile(
          sessions.map((session) => session.id),
          sessions
            .filter((session) => session.archivedAt !== undefined)
            .map((session) => session.id)
        )
      } catch (error) {
        degradedReconciliationCount += 1
        // Unread metadata is a recoverable projection and must not block Session hydration.
        emitRecoverableDiagnostic(this.log, 'unread Session reconciliation failed', {
          operation: 'session-hydration',
          phase: 'reconcile-unread-sessions',
          outcome: 'degraded',
          ...diagnosticErrorFields(error)
        })
      }

      const reconciliation = await this.reconciliationOwner.reconcileLoadedSessions({
        result,
        allowDestructiveCleanup: mayRunDestructiveStartupCleanup,
        phase: (name) => operation.phase(name),
        onPermissionFailure: (error) => {
          degradedReconciliationCount += 1
          // Chat hydration remains available. The Registry is still fail-closed by exact live scope
          // matching, and the complete scan will retry cleanup on the next process startup.
          emitRecoverableDiagnostic(this.log, 'permission grant reconciliation failed', {
            operation: 'session-hydration',
            phase: 'reconcile-permission-grants',
            outcome: 'degraded',
            ...diagnosticErrorFields(error)
          })
        }
      })

      if (reconciliation.status === 'degraded') {
        this.stateOwner.markMetadataIncomplete()
        if (!(reconciliation.failure instanceof ProjectFilesReconciliationError)) {
          this.fileIndex.markReconciliationIncomplete()
        }
        operation.fail(reconciliation.failure, {
          status: 'degraded',
          hydrationAvailable: true,
          sessionCount: reconciliation.result.sessions.length,
          warningCount: scan.warnings?.length ?? 0,
          degradedReconciliationCount
        })
        // Keep chat hydration available while Files remains explicitly incomplete and retryable.
        reconciliation.result.diagnostics = {
          isComplete: false,
          warnings: scan.warnings ?? [],
          failure: 'startup-reconciliation-failed'
        }
        return reconciliation.result
      }

      operation.complete({
        status: degradedReconciliationCount > 0 ? 'degraded' : 'ready',
        sessionCount: reconciliation.result.sessions.length,
        warningCount: scan.warnings?.length ?? 0,
        degradedReconciliationCount
      })
      return reconciliation.result
    })
  }

  readSessionRuntimeContext(projectId: string, sessionId: string): Promise<SessionRuntimeContext> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.stateOwner.readRuntimeContext(projectId, sessionId)
    )
  }

  loadPersistedSideChats(): Promise<{
    sideChats: Array<{
      projectId: string
      parentSessionId: string
      sideChat: PersistedSideChat
    }>
    relays: Array<{
      projectId: string
      parentSessionId: string
      relays: readonly PersistedSideChatRelay[]
    }>
    isComplete: boolean
  }> {
    return this.operationScheduler.runGlobal(() => this.sideChatOwner.loadCatalog())
  }

  saveSideChatProjection(command: SaveSideChatProjectionCommand): Promise<PersistedSideChat> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.sideChatOwner.saveProjection(command)
    )
  }

  appendSideChatRelay(command: AppendSideChatRelayCommand): Promise<void> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.sideChatOwner.appendRelay(command)
    )
  }

  commitSideChatRelays(
    command: CommitSideChatRelaysCommand
  ): Promise<readonly PersistedChatMessage[]> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.sideChatOwner.commitRelays(command)
    )
  }

  clearSideChat(command: ClearSideChatCommand): Promise<boolean> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.sideChatOwner.clear(command)
    )
  }

  patchSessionRuntimeContext(
    command: PatchSessionRuntimeContextCommand
  ): Promise<SessionRuntimeContext> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.stateOwner.patchRuntimeContext(command)
    )
  }

  stageTaskCompletion(command: StageTaskSessionCompletionRequest): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.stateOwner.stageTaskCompletion(command)
    )
  }

  settleTaskCompletion(command: SettleTaskSessionCompletionRequest): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.stateOwner.settleTaskCompletion(command)
    )
  }

  failTaskRun(command: FailTaskSessionRunRequest): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.stateOwner.failTaskRun(command)
    )
  }

  createChildren(
    key: SessionKey,
    input: CreateChildrenInput
  ): Promise<readonly CreatedNamedChild[]> {
    return this.delegatedWorkOwner.createChildren(key, input)
  }

  startContinuationAttempt(
    key: SessionKey,
    input: StartContinuationAttemptInput
  ): Promise<CreatedChild> {
    return this.delegatedWorkOwner.startContinuationAttempt(key, input)
  }

  admitQuestion(key: SessionKey, input: AdmitQuestionInput): Promise<'admitted' | 'idempotent'> {
    return this.delegatedWorkOwner.admitQuestion(key, input)
  }

  updateQuestionDraft(key: SessionKey, input: UpdateQuestionDraftInput): Promise<void> {
    return this.delegatedWorkOwner.updateQuestionDraft(key, input)
  }

  confirmQuestion(key: SessionKey, input: ConfirmQuestionInput): Promise<CreatedChild> {
    return this.delegatedWorkOwner.confirmQuestion(key, input)
  }

  cancelQuestions(
    key: SessionKey,
    input: Readonly<{ expectedRevision: number; frameId: string; endedAt: number; reason: string }>
  ): Promise<void> {
    return this.delegatedWorkOwner.cancelQuestions(key, input)
  }

  startAttemptRuntime(key: SessionKey, input: StartAttemptRuntimeInput): Promise<void> {
    return this.delegatedWorkOwner.startAttemptRuntime(key, input)
  }

  applyAgentEvent(key: SessionKey, input: AttemptAgentEventInput): Promise<void> {
    return this.delegatedWorkOwner.applyAgentEvent(key, input)
  }

  transitionAttempt(key: SessionKey, input: TransitionAttemptInput): Promise<void> {
    return this.delegatedWorkOwner.transitionAttempt(key, input)
  }

  submitStructuredOutput(
    key: SessionKey,
    input: import('../delegation/session-records').SubmitStructuredOutputInput
  ): Promise<'accepted' | 'idempotent'> {
    return this.delegatedWorkOwner.submitStructuredOutput(key, input)
  }

  admitMessageCommand(
    key: SessionKey,
    input: AdmitMessageCommandInput
  ): Promise<'admitted' | 'idempotent'> {
    return this.delegatedWorkOwner.admitMessageCommand(key, input)
  }

  startMessageDispatch(
    key: SessionKey,
    input: StartMessageDispatchInput
  ): Promise<'started' | 'terminal' | 'blocked'> {
    return this.delegatedWorkOwner.startMessageDispatch(key, input)
  }

  settleMessage(key: SessionKey, input: SettleMessageInput): Promise<'settled' | 'terminal'> {
    return this.delegatedWorkOwner.settleMessage(key, input)
  }

  acknowledgeUncertainMessage(
    key: SessionKey,
    input: Readonly<{ expectedRevision: number; messageId: string }>
  ): Promise<'acknowledged' | 'terminal'> {
    return this.delegatedWorkOwner.acknowledgeUncertainMessage(key, input)
  }

  startPendingMessageTurn(key: SessionKey, input: StartPendingMessageTurnInput): Promise<void> {
    return this.delegatedWorkOwner.startPendingMessageTurn(key, input)
  }

  completeChildTurn(key: SessionKey, input: CompleteChildTurnInput): Promise<void> {
    return this.delegatedWorkOwner.completeChildTurn(key, input)
  }

  attachDelegatedMessageArtifacts(
    key: SessionKey,
    input: AttachDelegatedMessageArtifactsInput
  ): Promise<void> {
    return this.delegatedWorkOwner.attachDelegatedMessageArtifacts(key, input)
  }

  readChildren(key: SessionKey, parentFrameId: string): Promise<readonly ChildRecord[]> {
    return this.delegatedWorkOwner.readChildren(key, parentFrameId)
  }

  recoverInterruptedDelegatedWork(): Promise<readonly { frameId: string; attemptId: string }[]> {
    return this.delegatedWorkOwner.recoverInterruptedDelegatedWork()
  }

  appendUserMessageToInteraction(
    command: AppendUserMessageToInteractionCommand
  ): Promise<PersistedChatMessage> {
    return this.operationScheduler.runSession(command.projectId, command.sessionId, () =>
      this.stateOwner.appendUserMessage(command)
    )
  }

  // Project archive must fail closed when even one child Session cannot be read. A partial catalog
  // cannot prove that an omitted Session is idle, so it is unsafe to hide the whole Project.
  assertProjectArchivable(
    projectId: string,
    isRuntimeBusy: (sessionId: string) => boolean = () => false
  ): Promise<string[]> {
    return this.operationScheduler.runProject(projectId, () =>
      this.deletionOwner.assertProjectArchivable(projectId, isRuntimeBusy)
    )
  }

  // Used by runtime admission checks after resolving a known project/session pair. It is intentionally
  // read-only: restoring an item never attaches or resumes an agent session by itself.
  assertSessionAvailable(projectId: string, sessionId: string): Promise<void> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.deletionOwner.assertSessionAvailable(projectId, sessionId)
    )
  }

  // Finds a persisted Session's owner for runtime admission. Fresh, unsaved sessions have no durable
  // archive state and deliberately return undefined.
  sessionProjectId(sessionId: string): Promise<string | undefined> {
    return this.operationScheduler.runSessionIdentity(sessionId, async () =>
      this.stateOwner.sessionProjectId(sessionId)
    )
  }

  // Dedicated main-owned archive mutation. Unlike full renderer saves it preserves updatedAt and
  // never allows a stale renderer projection to alter archive state.
  updateArchive(
    request: UpdateSessionArchiveRequest,
    isRuntimeBusy: () => boolean = () => false
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(request.projectId, request.sessionId, () =>
      this.deletionOwner.updateArchive(request, isRuntimeBusy)
    )
  }

  // Persists authoritative JSON before updating the derived index. If indexing fails, the save stays
  // durable, the caller receives the error for its normal retry path, and Files is reset to show its
  // incomplete state rather than silently presenting stale metadata as complete.
  saveSession(
    session: PersistedChatSession,
    options: SaveSessionOptions = {},
    authority: SessionSaveAuthority = { taskRunCommit: false }
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(session.projectId, session.id, async () => {
      await assertSessionIdentityOwnership(this.repository, this.stateOwner, session)
      return this.stateOwner.saveSession(
        session,
        sanitizeRendererSaveSessionOptions(options),
        authority
      )
    })
  }

  saveSessionSpecialistBinding(
    session: PersistedChatSession,
    specialistId: string | undefined,
    specialistBindingPending = false
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(session.projectId, session.id, async () => {
      await assertSessionIdentityOwnership(this.repository, this.stateOwner, session)
      return this.stateOwner.saveSessionSpecialistBinding(
        session,
        specialistId,
        specialistBindingPending
      )
    })
  }

  setSessionDelegationPolicy(
    projectId: string,
    sessionId: string,
    policy: DelegationPolicy
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.stateOwner.setDelegationPolicy(projectId, sessionId, policy)
    )
  }

  updateSessionConfiguration(
    session: PersistedChatSession,
    expectedRevision: number
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(session.projectId, session.id, async () => {
      await assertSessionIdentityOwnership(this.repository, this.stateOwner, session)
      return this.stateOwner.updateSessionConfiguration(session, expectedRevision)
    })
  }

  setSessionComputeConcurrencyLimit(
    projectId: string,
    sessionId: string,
    limit: number
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.stateOwner.setComputeConcurrencyLimit(projectId, sessionId, limit)
    )
  }

  setSessionEnabledComputeHosts(
    projectId: string,
    sessionId: string,
    providerIds: readonly string[]
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.stateOwner.setEnabledComputeHosts(projectId, sessionId, providerIds)
    )
  }

  mutateSessionComputeHostAccess(
    projectId: string,
    sessionId: string,
    mutation: computeHostAccess.SessionComputeHostAccessMutation
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.stateOwner.setEnabledComputeHosts(projectId, sessionId, mutation)
    )
  }

  pruneSessionEnabledComputeHosts(validProviderIds: readonly string[]): Promise<{
    sessions: PersistedChatSession[]
    previousSelections: computeHostAccess.SessionComputeHostAccessPruneSnapshot[]
  }> {
    return this.operationScheduler.runGlobal(async () => {
      const scan = await this.repository.loadAllWithDiagnostics()
      if (!scan.isComplete) {
        throw new Error('Cannot prune Compute Hosts without a complete Session catalog.')
      }
      const validProviderIdSet = new Set(validProviderIds)
      const previousSelections = computeHostAccess.computeHostAccessPruneSnapshots(
        scan.result.sessions,
        validProviderIdSet
      )
      const sessions = await this.stateOwner.pruneEnabledComputeHosts(
        scan.result.sessions,
        validProviderIdSet
      )
      return { sessions, previousSelections }
    })
  }

  runSessionMutation<Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ): Promise<Result> {
    return this.operationScheduler.runSession(projectId, sessionId, async () => {
      this.assertMutable(projectId, sessionId, 'mutate')
      try {
        return await mutation()
      } finally {
        // Force the next save to validate Artifact finalization's binding before reusing topology.
        this.stateOwner.invalidateBindingTopology(projectId, sessionId)
      }
    })
  }

  retryArtifactFinalization(
    request: ReconcilePendingArtifactsRequest
  ): Promise<PendingArtifactFinalizationRecovery | undefined> {
    return this.operationScheduler.runSession(request.projectId, request.sessionId, async () => {
      this.assertMutable(request.projectId, request.sessionId, 'mutate')
      const authority = await this.repository.loadSessionWithDiagnostics(
        request.projectId,
        request.sessionId
      )
      if (authority.status !== 'found') {
        throw new Error('Cannot retry Artifact finalization without a readable Session.')
      }

      return this.reconciliationOwner.retryArtifactFinalization(authority.session, request)
    })
  }

  // Session details is Main-owned metadata: its background lifecycle and the manual edit command
  // must compare and replace one authoritative Session inside the same lane as every other Session
  // mutation. It does not change transcript/file bindings, so the normal file-index and provenance
  // reconciliation performed by a whole renderer save would be unnecessary work here.
  mutateSessionDetailsAuthority(
    projectId: string,
    sessionId: string,
    mutation: (session: PersistedChatSession) => PersistedChatSession | undefined
  ): Promise<PersistedChatSession | undefined> {
    return this.operationScheduler.runSession(projectId, sessionId, () => {
      this.assertMutable(projectId, sessionId, 'mutate')
      return mutateSessionDetailsAuthority(
        this.repository,
        projectId,
        sessionId,
        mutation,
        (session) => this.stateOwner.recordSession(session)
      )
    })
  }

  /**
   * Completes the Session/index phase of an intent-authorized whole-Project deletion.
   *
   * This is deliberately not a general batch-Session delete. A durable Project deletion intent owns
   * eventual cleanup of Project-scoped Versions and provenance after this method atomically removes
   * Session authority. Per-Session deletion retains its stricter fail-closed contract.
   */
  deleteProjectSessions(
    projectId: string,
    options: { requireExistingUploadAuthority?: boolean } = {}
  ): Promise<ProjectSessionDeletionResult> {
    return this.operationScheduler.runProject(projectId, async (scope) => {
      this.deletedProjects.add(projectId)
      try {
        return await this.deletionOwner.deleteProjectSessions(
          projectId,
          (sessionIds, operation) => scope.runSessionIdentities(sessionIds, operation),
          options
        )
      } catch (error) {
        try {
          const state = await this.deletionOwner.getProjectSessionDeletionState(projectId)
          if (state === 'live' || state === 'absent') {
            this.deletedProjects.delete(projectId)
            await this.computeJobs?.abortProjectJobDeletion?.(projectId)
          }
        } catch {
          // Unknown durable state is treated as committed: retain the in-memory tombstone and intent.
          this.fileIndex.markReconciliationIncomplete(projectId)
        }
        throw error
      }
    })
  }

  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState> {
    return this.operationScheduler.runProject(projectId, () =>
      this.deletionOwner.getProjectSessionDeletionState(projectId)
    )
  }

  markCommittedProjectSessionsPrepared(projectId: string): Promise<void> {
    return this.operationScheduler.runProject(projectId, () =>
      this.deletionOwner.markCommittedProjectSessionsPrepared(projectId)
    )
  }

  completeProjectSessionDeletion(projectId: string): Promise<void> {
    return this.operationScheduler.runProject(projectId, () =>
      this.deletionOwner.completeProjectSessionDeletion(projectId)
    )
  }

  listLegacyProjectSessionTombstones(): Promise<string[]> {
    return this.operationScheduler.runGlobal(() =>
      this.deletionOwner.listLegacyProjectSessionTombstones()
    )
  }

  /**
   * Explicitly repairs the global file projection from a complete session scan.
   *
   * Every project is synchronized before the global reconciliation marker can be cleared. A second
   * pass handles rows released by reconciliation. Errors are tracked per session so a transient first
   * failure that succeeds on the final pass does not make the repair IPC report a false failure.
   */
  repairProjectFiles(projectId: string): Promise<void> {
    return this.operationScheduler.runGlobal(async () => {
      const scan = await this.repository.loadAllWithDiagnostics()
      if (!scan.isComplete) {
        this.fileIndex.markReconciliationIncomplete()
        this.notifyFilesChanged({
          projectId,
          sources: ['artifact', 'upload'],
          kind: 'reset'
        })
        throw new Error(
          'Project files cannot be repaired until the sessions directory is readable.'
        )
      }

      let repairError: unknown
      try {
        await this.reconciliationOwner.repairFileProjection(scan.result.sessions)
      } catch (error) {
        repairError = error
      }

      // One reset refreshes overview and all cursor layers after the explicit repair attempt.
      this.notifyFilesChanged({
        projectId,
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })

      if (repairError) throw repairError
    })
  }

  saveManifest(request: SaveSessionManifestRequest): Promise<void> {
    return this.operationScheduler.runManifest(() => this.repository.saveManifest(request))
  }

  /**
   * Deletes one session with reversible index-first ordering.
   *
   * After JSON deletion succeeds, surviving sessions in the project are retried because legacy
   * duplicates may now claim canonical file rows. Their changed sources are broadcast before the
   * deleted-owner event so already loaded renderer pages invalidate in the same operation.
   */
  deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.operationScheduler.runSessionThenGlobalIfNeeded(
      projectId,
      sessionId,
      async () => {
        const key = sessionKey(projectId, sessionId)
        this.deletedSessions.add(key)
        const deletion = await this.deletionOwner
          .deleteSession(projectId, sessionId)
          .catch(async (error: unknown) => {
            try {
              const authority = await this.repository.loadSessionWithDiagnostics(
                projectId,
                sessionId
              )
              if (authority.status === 'found') this.deletedSessions.delete(key)
            } catch {
              // Authority cannot be proven live, so retain the tombstone fail-closed.
            }
            throw error
          })
        const reconciled =
          this.stateOwner.metadataSnapshot().isComplete &&
          (await this.deletionOwner
            .reconcileProjectSessionDeletion(projectId, sessionId, deletion.receiptKind)
            .catch((error: unknown) => {
              throw new SessionDeletionCommittedError(error)
            }))
        if (reconciled) {
          if (deletion.cleanupError) throw deletion.cleanupError
          return undefined
        }
        return deletion
      },
      async ({ receiptKind, cleanupError }) => {
        await this.deletionOwner
          .reconcileSessionDeletion(projectId, sessionId, receiptKind)
          .catch((error: unknown) => {
            throw new SessionDeletionCommittedError(error)
          })
        if (cleanupError) throw cleanupError
      }
    )
  }

  private assertMutable(projectId: string, sessionId: string, operation: 'save' | 'mutate'): void {
    if (this.deletedProjects.has(projectId)) {
      throw new Error(`Cannot ${operation} a session whose project has been deleted.`)
    }
    if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
      throw new Error(`Cannot ${operation} a session that has been deleted.`)
    }
  }

  // Renderer notifications are derived state. They must never change the result of an authoritative
  // JSON/index mutation that has already committed; the next Files request can refresh if delivery fails.
  private notifyFilesChanged(event: ProjectFilesChangedEvent): void {
    try {
      this.onFilesChanged?.(event)
    } catch {
      // A closed window or test sink may reject synchronously after the durable mutation succeeds.
    }
  }

  // Runs only after authoritative Session deletion commits. Cleanup failures are repaired by the next
  // complete catalog reconciliation and never roll back the user-visible deletion.
  private async notifySessionsDeleted(sessionIds: string[]): Promise<void> {
    try {
      await this.sessionDeletionHandlers?.commit(sessionIds)
    } catch {
      // A later complete Session scan retries the projection cleanup from authoritative JSON state.
    }
  }
}
const sessionKey = (projectId: string, sessionId: string): string => `${projectId}:${sessionId}`

type SessionCatalog = Pick<
  SessionPersistenceCoordinator,
  'containsMessageOnActiveBranch' | 'loadSessionForContinuation' | 'sessionProjectId'
>
type SessionMutation = Pick<SessionPersistenceCoordinator, 'appendUserMessageToInteraction'>
type SessionRuntimeContextCommands = Pick<
  SessionPersistenceCoordinator,
  'readSessionRuntimeContext' | 'patchSessionRuntimeContext'
>
type SessionDeletion = Pick<
  SessionPersistenceCoordinator,
  | 'assertProjectArchivable'
  | 'assertSessionAvailable'
  | 'completeProjectSessionDeletion'
  | 'deleteProjectSessions'
  | 'deleteSession'
  | 'getProjectSessionDeletionState'
  | 'listLegacyProjectSessionTombstones'
  | 'markCommittedProjectSessionsPrepared'
  | 'setSessionDeletionHandlers'
  | 'updateArchive'
>

export { SessionPersistenceCoordinator, SessionRuntimeContextRevisionConflictError }
export type {
  ComputeJobDeletionParticipant,
  DelegatedWorkRecordCommands,
  PatchSessionRuntimeContextCommand,
  ProjectSessionDeletionResult,
  SessionCatalog,
  SessionDeletion,
  SessionDeletionHandlers,
  SessionFileIndex,
  SessionMetadata,
  SessionMetadataSnapshot,
  SessionMutation,
  SessionMutationRepository,
  SessionProvenancePersistence,
  SessionRuntimeContextCommands
}
