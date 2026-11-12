import { assertLiteratureAttachmentsUnreferenced } from './literature-attachment-removal'
import { ProjectFilesReconciliationError } from '../project-files/repository'
import type { ProjectFileSource, ProjectFilesChangedEvent } from '../../shared/project-files'
import type { ReconcilePendingArtifactsRequest } from '../../shared/artifacts'
import {
  SessionDeletionCommittedError,
  SessionRevisionConflictError,
  isSessionRevisionConflictError,
  sessionRevision,
  deleteSessionRecoveryFileRequestSchema,
  type DeleteSessionRecoveryFileRequest,
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
  type BindTaskSessionRequest,
  type AdmitTaskSessionTurnRequest,
  type StageTaskSessionCompletionRequest,
  type UpdateSessionArchiveRequest,
  type SessionRuntimeContext,
  type SessionLoadFailure,
  type SessionLoadWarning,
  type SessionSummary
} from '../../shared/session-persistence'
import { deriveSessionAttention, type SessionRecordProblem } from '../../shared/session-persistence'
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
import type { ProjectSessionDeletionState, SessionRecoverySnapshot } from './repository'
import { createLogger, diagnosticErrorFields, type Logger } from '@aipoch/diagnostics/node'
import { startDiagnosticOperation } from '@aipoch/diagnostics/node'
import type { AcpRuntimeEvent } from '../../shared/acp'
import { saveSessionWithRevision } from './save-session'
import { observeSessionRecordWrites } from './record-facts'
import {
  SessionPersistenceStateOwner,
  SessionRuntimeContextRevisionConflictError,
  type AppendUserMessageToInteractionCommand,
  type PatchSessionRuntimeContextCommand,
  type SessionMetadata,
  type SessionMetadataSnapshot,
  type SessionSaveAuthority,
  type RuntimeTerminalCommitRequest
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

// Main-process package publisher supplies only a successfully persisted Session. The optional
// context certifies that this operation's new Project is still hidden by its staging barrier.
export type PublishedSessionHandoff = {
  projectId: string
  sessionId: string
  session: PersistedChatSession
  pendingProjectImport?: { operationId: string }
}

const SESSION_CPU_TRACE_ENABLED = process.env.OPEN_SCIENCE_PERF_SESSION_TRACE === '1'
type SessionMutationRepository = {
  hasLiveRuntimeSession?(projectId: string, sessionId: string): boolean
  deleteRecoveryFile?(request: DeleteSessionRecoveryFileRequest): Promise<void>
  loadAllWithDiagnostics(options?: {
    mode?: 'repair' | 'read-only'
    quarantinedIsIncomplete?: boolean
  }): Promise<{
    result: LoadAllSessionsResult
    isComplete: boolean
    warnings?: SessionLoadWarning[]
    scanMetrics?: {
      projectDirectoryCount: number
      sessionFileCount: number
      sessionBytes: number
      authorityReadMs?: number
      jsonParseMs?: number
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
    sessionId: string,
    options?: { mode?: 'repair' | 'read-only'; preserveRuntimeState?: boolean }
  ): Promise<
    | { status: 'found'; session: PersistedChatSession }
    | { status: 'missing' }
    | { status: 'unreadable' }
  >
  loadSessionRecoverySnapshot?(
    projectId: string,
    sessionId: string
  ): Promise<SessionRecoverySnapshot>
  assertSessionIdentityOwnership(sessionId: string, expectedProjectId: string): Promise<void>
  saveRecoveredSession?(
    session: PersistedChatSession,
    expectedRevision: number
  ): Promise<PersistedChatSession>
  saveSession(
    session: PersistedChatSession,
    expectedRevision?: number,
    onJsonCommitted?: (session: PersistedChatSession) => void
  ): Promise<PersistedChatSession>
  saveSessionWithBindingRepair?(
    session: PersistedChatSession,
    expectedRevision: number
  ): Promise<PersistedChatSession>
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
  reconcileActiveSessions(
    sessions: readonly Pick<PersistedChatSession, 'projectId' | 'id'>[]
  ): Promise<void>
  markReconciliationIncomplete(projectId?: string): void
}

type SessionProvenancePersistence = {
  recoverLegacySessionGraph?(
    session: PersistedChatSession
  ): Promise<PersistedChatSession | undefined>
  validateFinalizedMessageBindings(session: PersistedChatSession): Promise<void>
  captureFinalizedMessages(session: PersistedChatSession): Promise<void>
  reconcileSessionDeletions(activeSessions: PersistedChatSession[]): Promise<void>
  prepareSessionDeletion(session: PersistedChatSession): Promise<SessionDeletionReceipt>
  completeSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
  abortSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
}

type SessionNativeCleanup = { projectId: string; sessionId: string; apply(): Promise<void> }

// commit must settle every started cleanup before resolving or rejecting: ID reservations last
// until this promise settles, including failures in parallel projection owners.
type SessionDeletionHandlers = {
  planReconciliation?(existingSessionIds: string[]): Promise<SessionNativeCleanup[]>
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

type SessionAuthorityScan = Awaited<ReturnType<SessionMutationRepository['loadAllWithDiagnostics']>>

type RecoveredSessionReference = Pick<
  PersistedChatSession,
  'id' | 'projectId' | 'cwd' | 'revision' | 'updatedAt' | 'archivedAt'
>

type PreparedSessionRecovery = Readonly<
  { projectId: string; sessionId: string; metrics?: SessionRecoverySnapshot['metrics'] } & (
    | { status: 'prepared'; session: PersistedChatSession; expectedRevision: number }
    | { status: 'repair-required' }
  )
>

const HYDRATION_CACHE_IDLE_MS = 30_000
const HYDRATION_CACHE_MAX_SESSIONS = 32
const HYDRATION_CACHE_MAX_ESTIMATED_BYTES = 32 * 1024 * 1024

// Estimate retained JS values without serializing a second copy of the transcript. The estimate
// deliberately overcounts shared strings; it is a retention budget, not a heap measurement.
const estimateHydrationBytes = (value: unknown): number => {
  const pending = [value]
  const seen = new Set<object>()
  let bytes = 0
  while (pending.length > 0 && bytes <= HYDRATION_CACHE_MAX_ESTIMATED_BYTES) {
    const current = pending.pop()
    if (typeof current === 'string') bytes += 24 + current.length * 2
    else if (current && typeof current === 'object' && !seen.has(current)) {
      seen.add(current)
      bytes += 64
      for (const key of Object.keys(current)) {
        bytes += 16 + key.length * 2
        if (bytes > HYDRATION_CACHE_MAX_ESTIMATED_BYTES) return bytes
        pending.push((current as Record<string, unknown>)[key])
      }
    } else bytes += 8
  }
  return bytes
}

// Reuse only the expensive authority scan. Derived reconciliation still runs on every load so a
// second window/renderer cannot miss files or artifacts written after the first was cached.
class SessionHydrationCache {
  private generation = 0
  private cached:
    { generation: number; scan: SessionAuthorityScan; estimatedBytes: number } | undefined
  private retention = 'empty'
  private expiry: ReturnType<typeof setTimeout> | undefined

  generationForLoad(): number {
    return this.generation
  }

  get(): SessionAuthorityScan | undefined {
    const cached = this.cached
    return cached && cached.generation === this.generation ? cached.scan : undefined
  }

  diagnostics(): Record<string, string | number> {
    return {
      retainedSessionCount: this.cached?.scan.result.sessions.length ?? 0,
      retainedEstimatedBytes: this.cached?.estimatedBytes ?? 0,
      cacheRetention: this.retention,
      cacheMaxSessionCount: HYDRATION_CACHE_MAX_SESSIONS,
      cacheMaxEstimatedBytes: HYDRATION_CACHE_MAX_ESTIMATED_BYTES
    }
  }

  set(scan: SessionAuthorityScan, generation: number): void {
    if (generation !== this.generation || scan.isComplete !== true) return
    clearTimeout(this.expiry)
    this.expiry = undefined
    this.cached = undefined
    if (scan.result.sessions.length > HYDRATION_CACHE_MAX_SESSIONS) {
      this.retention = 'count-limit'
      return
    }
    const estimatedBytes = estimateHydrationBytes(scan)
    if (estimatedBytes > HYDRATION_CACHE_MAX_ESTIMATED_BYTES) {
      this.retention = 'byte-limit'
      return
    }
    this.cached = { generation, scan, estimatedBytes }
    this.retention = 'admitted'
    this.expiry = setTimeout(() => {
      this.cached = undefined
      this.expiry = undefined
      this.retention = 'expired'
    }, HYDRATION_CACHE_IDLE_MS)
    this.expiry.unref()
  }

  invalidate(): void {
    clearTimeout(this.expiry)
    this.expiry = undefined
    this.generation += 1
    this.cached = undefined
    this.retention = 'invalidated'
  }
}

// Serializes authoritative Session JSON and derived file-index mutations at their owning Project and
// Session scopes. Catalog-wide reconciliation uses an exclusive barrier so unrelated Projects overlap
// without allowing a late save to race or revive durable deletion authority.
class SessionPersistenceCoordinator implements DelegatedWorkRecordCommands {
  private readonly notifySessionRecordProblems: SessionUpdatePublisher
  private readonly sessionRecordProblems = new Map<string, Set<SessionRecordProblem>>()
  private recordProblemKey(projectId: string, sessionId: string): string {
    return `${projectId}\0${sessionId}`
  }
  recordSessionRecordProblem(
    projectId: string,
    sessionId: string,
    problem: SessionRecordProblem
  ): void {
    const key = this.recordProblemKey(projectId, sessionId)
    const problems = this.sessionRecordProblems.get(key) ?? new Set<SessionRecordProblem>()
    problems.add(problem)
    this.sessionRecordProblems.set(key, problems)
  }
  clearSessionRecordProblem(
    projectId: string,
    sessionId: string,
    problem?: SessionRecordProblem
  ): void {
    const key = this.recordProblemKey(projectId, sessionId)
    if (!problem) {
      this.sessionRecordProblems.delete(key)
      return
    }
    const problems = this.sessionRecordProblems.get(key)
    if (!problems) return
    problems.delete(problem)
    if (problems.size === 0) this.sessionRecordProblems.delete(key)
  }
  listSessionRecordProblems(projectId: string, sessionId: string): readonly SessionRecordProblem[] {
    return [...(this.sessionRecordProblems.get(this.recordProblemKey(projectId, sessionId)) ?? [])]
  }
  recordRuntimeTerminalFailure(
    event: AcpRuntimeEvent,
    retry: () => Promise<void>,
    waitForWriteRelease?: () => Promise<void>
  ): void {
    this.stateOwner.recordRuntimeTerminalFailure(event, retry, waitForWriteRelease)
    const sessionId = event.sessionId
    if (event.terminalCommitFailure === 'missing-record' && event.terminalScope && sessionId)
      this.recordSessionRecordProblem(event.terminalScope.projectId, sessionId, 'missing-record')
  }
  listRuntimeTerminalFailures(): AcpRuntimeEvent[] {
    return this.stateOwner.listRuntimeTerminalFailures()
  }
  projectRuntimeSession(session: PersistedChatSession): PersistedChatSession {
    return {
      ...this.stateOwner.projectRuntimeSession(session),
      recordProblems: this.listSessionRecordProblems(session.projectId, session.id)
    }
  }
  async projectRuntimeSessionSummaries(
    summaries: readonly SessionSummary[]
  ): Promise<SessionSummary[]> {
    const failures = this.listRuntimeTerminalFailures()
    return Promise.all(
      summaries.map(async (summary) => {
        const problems = this.listSessionRecordProblems(summary.projectId, summary.id)
        const withProblems = (candidate: SessionSummary): SessionSummary => ({
          ...candidate,
          recordProblems: problems,
          ...(problems.length > 0 &&
          candidate.presentedStatus !== 'running' &&
          !candidate.presentedStatus.startsWith('waiting-')
            ? { presentedStatus: 'error' as const }
            : {})
        })
        const failure = failures.find(
          ({ sessionId, terminalScope }) =>
            sessionId === summary.id && terminalScope?.projectId === summary.projectId
        )
        if (!failure) return withProblems(summary)
        const loaded = await this.repository.loadSessionWithDiagnostics(
          summary.projectId,
          summary.id,
          {
            mode: 'read-only',
            preserveRuntimeState: true
          }
        )
        if (loaded.status === 'missing' && failure.terminalCommitFailure === 'missing-record')
          return withProblems({
            ...summary,
            status: 'error',
            presentedStatus: 'error',
            needsStartupRecovery: false
          })
        if (loaded.status !== 'found') return withProblems(summary)
        const projected = this.projectRuntimeSession(loaded.session)
        if (projected === loaded.session) return withProblems(summary)
        return withProblems({
          ...summary,
          status: projected.status,
          presentedStatus:
            projected.status === 'running' || projected.status.startsWith('waiting-')
              ? projected.status
              : deriveSessionAttention(projected)
                ? 'error'
                : 'idle',
          needsStartupRecovery: false
        })
      })
    )
  }
  retryRuntimeTerminalCommit(request: RuntimeTerminalCommitRequest): Promise<void> {
    return this.stateOwner.retryRuntimeTerminalCommit(request)
  }
  private readonly exportingSessions = new Map<
    string,
    { projectId: string; released: Promise<void> }
  >()
  private readonly operationScheduler = new SessionPersistenceOperationScheduler()
  private readonly hydrationCache = new SessionHydrationCache()
  private readonly pendingDeletionCleanups = new Map<string, number>()
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
    private readonly workspaceOwnership?: SessionWorkspaceOwnership,
    preparePackageDeletion?: (session: PersistedChatSession) => Promise<void>,
    private readonly deletionWork?: {
      withSessionStopped<T>(
        projectId: string,
        sessionId: string,
        operation: () => Promise<T>
      ): Promise<T>
      withProjectStopped<T>(projectId: string, operation: () => Promise<T>): Promise<T>
    }
  ) {
    const publishSessionUpdate = safeSessionUpdates(onDelegatedWorkSessionUpdated, log)
    this.notifySessionRecordProblems = publishSessionUpdate
    repository = observeSessionRecordWrites(repository, {
      failedSizeLimit: async (session) => {
        this.recordSessionRecordProblem(session.projectId, session.id, 'size-limit')
        try {
          const loaded = await repository.loadSessionWithDiagnostics(
            session.projectId,
            session.id,
            {
              mode: 'read-only',
              preserveRuntimeState: true
            }
          )
          if (loaded.status === 'found')
            this.notifySessionRecordProblems(
              this.projectRuntimeSession(loaded.session),
              'runtime-transcript'
            )
        } catch {
          // A read/publication failure cannot replace the original operation error.
        }
      },
      committed: (session) => {
        this.hydrationCache.invalidate()
        const hadProblems = this.listSessionRecordProblems(session.projectId, session.id).length > 0
        this.clearSessionRecordProblem(session.projectId, session.id)
        if (hadProblems)
          this.notifySessionRecordProblems(
            this.projectRuntimeSession(session),
            'runtime-transcript'
          )
      }
    })
    this.repository = repository
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
      notifyRuntimeTranscriptSessionUpdated: (session) =>
        publishSessionUpdate(session, 'runtime-transcript'),
      notifyDelegationPolicyUpdated: (session) => onDelegationPolicyUpdated?.(session),
      onSessionStateChanged: () => this.hydrationCache.invalidate(),
      releaseAbandonedPreparation: ({ projectId, sessionId }) => {
        void this.operationScheduler
          .runSession(projectId, sessionId, () =>
            this.stateOwner.releaseAbandonedPreparation({ projectId, sessionId })
          )
          .catch((error: unknown) => {
            try {
              log.warn('abandoned prompt preparation release failed', {
                operation: 'prompt-preparation-release',
                outcome: 'degraded',
                ...diagnosticErrorFields(error)
              })
            } catch {
              // Diagnostics cannot change recovery; the next Session operation retries lazily.
            }
          })
      }
    })
    this.sideChatOwner = new SessionSideChatPersistenceOwner({
      repository,
      assertMutable: (projectId, sessionId, projectionOnly) =>
        this.assertMutable(projectId, sessionId, 'mutate', projectionOnly),
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
      preparePackageDeletion,
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
      notifyDiscussionDetached: (session) => publishSessionUpdate(session, 'runtime-context')
    })
    this.reconciliationOwner = new SessionPersistenceReconciliationOwner({
      ownsPromptPreparation: (session) => this.stateOwner.ownsPromptPreparation(session),
      onSessionCommitted: (session) => {
        this.stateOwner.recordSession(session)
        publishSessionUpdate(session, 'runtime-transcript')
      },
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

  // Non-owning read for consumers that observe transcripts but must never repair them (reviewer's
  // stale-verdict check and fix-loop refresh). `mode: 'read-only'` is required, not cosmetic:
  // `readSessionFile` quarantines unless `quarantineInvalidFiles === false`, so a plain read would
  // let a non-owner rename a corrupt live session file outside this coordinator's write lane.
  // Returns undefined for missing/unreadable instead of throwing, so callers can degrade.
  readSessionSnapshot(
    projectId: string,
    sessionId: string
  ): Promise<PersistedChatSession | undefined> {
    return this.operationScheduler.runSession(projectId, sessionId, async () => {
      const loaded = await this.repository.loadSessionWithDiagnostics(projectId, sessionId, {
        mode: 'read-only'
      })
      return loaded.status === 'found' ? structuredClone(loaded.session) : undefined
    })
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

  // Package publication commits through its own recovery journal. Adopt only durable authority
  // into this live catalog before the new Session is exposed to runtime admission or renderers.
  adoptPublishedSession(publication: PublishedSessionHandoff): Promise<void> {
    // Capture before enqueueing: the publisher and this owner have independent schedulers.
    const { projectId, sessionId, session, pendingProjectImport } = structuredClone(publication)
    this.hydrationCache.invalidate()
    return this.operationScheduler.runSession(projectId, sessionId, async () => {
      this.assertMutable(projectId, sessionId, 'mutate')
      if (session.id !== sessionId || session.projectId !== projectId)
        throw new Error('Import publication Session identity mismatch.')
      const loaded = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
      const pendingOperation = pendingProjectImport?.operationId
      const hiddenByImport =
        pendingOperation !== undefined &&
        projectId === `import-${pendingOperation}` &&
        session.packageOrigin?.importId === pendingOperation
      if (loaded.status !== 'found' && !(loaded.status === 'missing' && hiddenByImport)) {
        throw new Error(`Cannot adopt a published ${loaded.status} Session.`)
      }
      // Ordinary reads remain authoritative whenever they can see the Session.
      const durable = loaded.status === 'found' ? loaded.session : session
      await assertSessionIdentityOwnership(this.repository, this.stateOwner, durable)
      this.stateOwner.invalidateBindingTopology(projectId, sessionId)
      this.stateOwner.recordSession(durable)
    })
  }

  setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void {
    this.sessionDeletionHandlers = handlers
  }

  sessionMetadataSnapshot(): Promise<SessionMetadataSnapshot> {
    return this.operationScheduler.runGlobal(async () => this.stateOwner.metadataSnapshot())
  }

  replaceSessionMetadata(
    sessions: readonly SessionMetadata[],
    isComplete: boolean,
    expectedGeneration?: number
  ): Promise<void> {
    if (expectedGeneration !== undefined) {
      if (this.recoveryCatalogGeneration() === expectedGeneration)
        this.stateOwner.replaceMetadata(sessions, isComplete)
      else this.stateOwner.replaceMetadata(this.stateOwner.metadataSnapshot().sessions, false)
      return Promise.resolve()
    }
    return this.operationScheduler.runGlobal(async () => {
      this.stateOwner.replaceMetadata(sessions, isComplete)
    })
  }

  // Degraded authority read: keeps healthy transcripts navigable while writes remain blocked.
  loadAllReadOnly(): Promise<LoadAllSessionsResult> {
    const queuedAt = performance.now()
    return this.operationScheduler.runGlobal(async () => {
      this.hydrationCache.invalidate()
      this.stateOwner.beginHydration()
      // Once any renderer has observed a degraded snapshot, later loads are no longer allowed to
      // treat the process as an untouched startup boundary for destructive cleanup.
      this.destructiveStartupWindowOpen = false
      this.fileIndex.markReconciliationIncomplete()
      const operation = startDiagnosticOperation(this.log, {
        operation: 'session-hydration',
        cpuUsage: SESSION_CPU_TRACE_ENABLED ? process.cpuUsage : undefined,
        fields: {
          mode: 'read-only',
          startupCleanupEligible: false,
          queueWaitMs: performance.now() - queuedAt
        }
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

  recoveryCatalogGeneration(): number {
    return this.hydrationCache.generationForLoad()
  }

  async cleanupRecoveredSession(
    prepared: PreparedSessionRecovery,
    expectedGeneration: number,
    commit: (operation: () => Promise<void>) => Promise<boolean>,
    startupCutoff: number,
    cancelled: () => boolean
  ): Promise<'complete' | 'busy' | 'stale'> {
    if (prepared.status !== 'prepared') return 'stale'
    const { projectId, sessionId, session } = prepared
    const actions = await this.reconciliationOwner.planOrphanStagingCleanup(session, startupCutoff)
    const guarded = (
      operation: () => Promise<'complete' | 'busy' | 'stale'>
    ): Promise<'complete' | 'busy' | 'stale'> =>
      this.operationScheduler.runSessionRecovery(projectId, sessionId, async () => {
        if (cancelled() || this.recoveryCatalogGeneration() !== expectedGeneration) return 'stale'
        this.assertMutable(projectId, sessionId, 'mutate')
        if (
          session.activeRun ||
          this.stateOwner.ownsPromptPreparation(session) ||
          this.repository.hasLiveRuntimeSession?.(projectId, sessionId)
        )
          return 'busy'
        return operation()
      })
    for (const apply of actions) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Try Artifact ownership before the catalog fence; a busy writer never queues here.
      let applying: Promise<'complete' | 'stale' | 'busy'> | undefined
      let detached!: (outcome: 'complete' | 'stale') => void
      const detachedPromise = new Promise<'complete' | 'stale'>((resolve) => {
        detached = resolve
      })
      const outcome = await guarded(() => {
        applying = apply(async (operation) => {
          const accepted = await commit(operation)
          // The private directory no longer belongs to live Session authority. Release the Session
          // reservation at this handoff; recursive physical removal may continue independently.
          detached(accepted ? 'complete' : 'stale')
          return accepted
        })
        return Promise.race([applying, detachedPromise])
      })
      await applying
      if (outcome !== 'complete') return outcome
    }
    const uploads = await guarded(async () => {
      if (!(await commit(async () => undefined))) return 'stale'
      // Verified legacy-source cleanup hashes files under the Session lane, never globally.
      await this.reconciliationOwner.cleanupVersionedUploadSources(session)
      return 'complete'
    })
    if (uploads !== 'complete') return uploads
    return 'complete'
  }

  async reconcileRecoveryCatalog(
    sessions: readonly RecoveredSessionReference[],
    expectedGeneration: number,
    commit: (operation: () => Promise<void>) => Promise<boolean>,
    cancelled: () => boolean = () => false
  ): Promise<boolean> {
    // Directory enumeration and receipt planning run before any catalog commit reservation.
    const workspaceActions = (await this.workspaceOwnership?.planProvisional?.(sessions)) ?? []
    const nativeActions = [
      ...(await this.reconciliationOwner.planNativeCleanup(sessions)),
      ...((await this.sessionDeletionHandlers?.planReconciliation?.(
        sessions.map(({ id }) => id)
      )) ?? [])
    ]
    const failures: unknown[] = []
    // Native owner plans contain identities, never permission to delete. Revalidate immediately
    // before each effect while excluding Session mutation and Project publication/deletion.
    for (const action of nativeActions) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      const accepted = await this.operationScheduler.runSessionRecovery(
        action.projectId,
        action.sessionId,
        async () => {
          if (cancelled() || this.recoveryCatalogGeneration() !== expectedGeneration) return false
          if (!(await commit(async () => undefined))) return false
          try {
            await action.apply()
          } catch (error) {
            failures.push(error)
          }
          return true
        }
      )
      if (!accepted) return false
    }
    const guarded = (operation: () => Promise<void>): Promise<boolean> =>
      this.operationScheduler.runGlobal(async () => {
        if (cancelled() || this.recoveryCatalogGeneration() !== expectedGeneration) return false
        return commit(async () => {
          try {
            await operation()
          } catch (error) {
            failures.push(error)
          }
        })
      })
    if (
      !(await guarded(async () => {
        await this.reconciliationOwner.reconcileCatalogIdentities(sessions)
        await this.sessionDeletionHandlers?.reconcile(
          sessions.map(({ id }) => id),
          sessions.filter(({ archivedAt }) => archivedAt !== undefined).map(({ id }) => id)
        )
      }))
    )
      return false
    for (const apply of workspaceActions) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      let removeDetached: (() => Promise<void>) | undefined
      if (
        !(await guarded(async () => {
          removeDetached = await apply()
        }))
      )
        return false
      try {
        await removeDetached?.()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Session catalog cleanup is incomplete.')
    return true
  }

  // The primary snapshot reader never repairs files and does not reserve the Project lane while
  // reading/parsing history. Temporary or uncertain authority is deferred to guarded commit.
  async prepareSessionRecovery(
    projectId: string,
    sessionId: string
  ): Promise<PreparedSessionRecovery | undefined> {
    const operation = startDiagnosticOperation(this.log, {
      operation: 'session-recovery',
      fields: { mode: 'prepare' }
    })
    operation.phase('read-snapshot')
    try {
      this.assertMutable(projectId, sessionId, 'mutate')
      const loaded: SessionRecoverySnapshot = this.repository.loadSessionRecoverySnapshot
        ? await this.repository.loadSessionRecoverySnapshot(projectId, sessionId)
        : await this.operationScheduler.runSession(projectId, sessionId, () => {
            this.assertMutable(projectId, sessionId, 'mutate')
            return this.repository.loadSessionWithDiagnostics(projectId, sessionId)
          })
      this.assertMutable(projectId, sessionId, 'mutate')
      if (loaded.status === 'unreadable')
        throw new Error('Cannot recover a Session whose durable JSON is unreadable.')
      operation.complete({ status: loaded.status, ...('metrics' in loaded ? loaded.metrics : {}) })
      if (loaded.status === 'repair-required')
        return { status: loaded.status, projectId, sessionId }
      if (loaded.status !== 'found') return undefined
      return {
        status: 'prepared',
        projectId,
        sessionId,
        session: structuredClone(loaded.session),
        expectedRevision: sessionRevision(loaded.session),
        ...('metrics' in loaded ? { metrics: loaded.metrics } : {})
      }
    } catch (error) {
      operation.fail(error, { status: 'failed' })
      throw error
    }
  }

  // A candidate is not authority. Revalidate before any upload/artifact/index side effects, then
  // keep explicit repository CAS at each JSON save to cover writers outside this coordinator.
  async commitSessionRecovery(
    prepared: PreparedSessionRecovery
  ): Promise<PersistedChatSession | undefined> {
    const { projectId, sessionId } = prepared
    const preparedRevision = prepared.status === 'prepared' ? prepared.expectedRevision : undefined
    const queuedAt = Date.now()
    const operation = startDiagnosticOperation(this.log, {
      operation: 'session-recovery',
      fields: { mode: 'commit' }
    })
    operation.phase('wait-for-session')
    try {
      const result = await this.operationScheduler.runSessionRecovery(
        projectId,
        sessionId,
        async () => {
          operation.phase('revalidate-authority', {
            queueWaitMs: Math.max(0, Date.now() - queuedAt)
          })
          this.assertMutable(projectId, sessionId, 'mutate')
          const loaded = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
          if (loaded.status === 'unreadable')
            throw new Error('Cannot recover a Session whose durable JSON is unreadable.')
          if (loaded.status !== 'found') return undefined
          const actualRevision = sessionRevision(loaded.session)
          const expectedRevision = preparedRevision ?? actualRevision
          if (actualRevision !== expectedRevision)
            throw new SessionRevisionConflictError(expectedRevision, actualRevision)
          // Normal reads preserve active runtime state. Never restart an owned run or preparation.
          if (loaded.session.activeRun || this.stateOwner.ownsPromptPreparation(loaded.session))
            return loaded.session
          // Runtime ownership can change without a JSON revision. Replan from the validated read so
          // stale restore normalization cannot resurrect a released run or disturb a new owner.
          const recovered = recoverInterruptedDelegatedWorkSession(loaded.session)
          const session = recovered.interrupted.length
            ? await (this.repository.saveRecoveredSession
                ? this.repository.saveRecoveredSession(recovered.session, expectedRevision)
                : saveSessionWithRevision(this.repository, recovered.session, expectedRevision))
            : loaded.session
          const outcome = await this.reconciliationOwner.reconcileLoadedSessions({
            result: { sessions: [session], manifest: { version: 1 } },
            allowDestructiveCleanup: false,
            scope: 'session',
            phase: (phase) => operation.phase(phase),
            onPermissionFailure: () => undefined
          })
          if (outcome.status === 'degraded') throw outcome.failure
          const persisted = outcome.result.sessions[0]
          this.stateOwner.recordSession(persisted)
          return persisted
        }
      )
      operation.complete({ status: result ? 'ready' : 'unavailable', revisionConflicts: 0 })
      return result
    } catch (error) {
      const conflict = isSessionRevisionConflictError(error)
      operation.fail(error, {
        status: conflict ? 'conflict' : 'failed',
        revisionConflicts: conflict ? 1 : 0
      })
      throw error
    }
  }

  // Targeted startup recovery never authorizes catalog absence cleanup or consumes the full-scan
  // startup cleanup boundary. Background callers may also separate preparation from commit.
  async recoverStartupSession(
    projectId: string,
    sessionId: string
  ): Promise<PersistedChatSession | undefined> {
    let revisionConflicts = 0
    const operation = startDiagnosticOperation(this.log, {
      operation: 'session-recovery',
      fields: { mode: 'startup' }
    })
    try {
      for (;;) {
        operation.phase('prepare', { revisionConflicts })
        const prepared = await this.prepareSessionRecovery(projectId, sessionId)
        try {
          const result = prepared ? await this.commitSessionRecovery(prepared) : undefined
          operation.complete({ status: result ? 'ready' : 'unavailable', revisionConflicts })
          return result
        } catch (error) {
          if (!isSessionRevisionConflictError(error)) throw error
          revisionConflicts += 1
          if (revisionConflicts >= 2) throw error
        }
      }
    } catch (error) {
      operation.fail(error, {
        status: 'deferred',
        revisionConflicts,
        retryable: isSessionRevisionConflictError(error)
      })
      throw error
    }
  }

  /**
   * Loads durable sessions, reconciles Upload storage, and backfills the file projection only after a
   * complete scan has restored active ownership. Chat hydration remains available on any failure.
   */
  loadAll(): Promise<LoadAllSessionsResult> {
    const queuedAt = performance.now()
    return this.operationScheduler.runGlobal(async () => {
      const hydrationGeneration = this.hydrationCache.generationForLoad()
      const cachedScan = this.hydrationCache.get()
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
          queueWaitMs: performance.now() - queuedAt,
          startupCleanupEligible: mayRunDestructiveStartupCleanup,
          authorityReused: cachedScan !== undefined
        }
      })
      let scan = cachedScan
      if (scan) {
        operation.phase('authority-reused', {
          sessionCount: scan.result.sessions.length,
          warningCount: scan.warnings?.length ?? 0
        })
      } else {
        operation.phase('load-authority')
        try {
          scan = await this.repository.loadAllWithDiagnostics()
        } catch (error) {
          operation.fail(error, { status: 'failed', hydrationAvailable: false })
          throw error
        }
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
      }
      const hasAuthoritativeSessionCatalog = isSessionCatalogAuthoritative(scan)
      this.stateOwner.replaceMetadata(scan.result.sessions, hasAuthoritativeSessionCatalog)
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

      if (degradedReconciliationCount === 0) {
        this.hydrationCache.set({ ...scan, result: reconciliation.result }, hydrationGeneration)
      }
      operation.complete({
        status: degradedReconciliationCount > 0 ? 'degraded' : 'ready',
        sessionCount: reconciliation.result.sessions.length,
        warningCount: scan.warnings?.length ?? 0,
        degradedReconciliationCount,
        ...this.hydrationCache.diagnostics()
      })
      return reconciliation.result
    })
  }

  withUnreferencedLiteratureAttachment<Result>(
    attachmentId: string,
    remove: () => Promise<Result>
  ): Promise<Result> {
    return this.operationScheduler.runGlobal(async () => {
      const scan = await this.repository.loadAllWithDiagnostics({
        mode: 'read-only',
        quarantinedIsIncomplete: true
      })
      assertLiteratureAttachmentsUnreferenced(scan, [attachmentId])
      return remove()
    })
  }

  withLiteratureAttachmentRemoval<Result>(
    remove: (assertUnreferenced: (attachmentIds: readonly string[]) => void) => Promise<Result>
  ): Promise<Result> {
    return this.operationScheduler.runGlobal(async () => {
      const scan = await this.repository.loadAllWithDiagnostics({
        mode: 'read-only',
        quarantinedIsIncomplete: true
      })
      return remove((attachmentIds) => assertLiteratureAttachmentsUnreferenced(scan, attachmentIds))
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

  bindTaskSession(command: BindTaskSessionRequest): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(command.session.projectId, command.session.id, () =>
      this.stateOwner.bindTaskSession(command)
    )
  }

  prepareRuntimeResume(projectId: string, sessionId: string): Promise<void> {
    return this.operationScheduler.runSession(projectId, sessionId, () =>
      this.stateOwner.prepareRuntimeResume({ projectId, sessionId })
    )
  }

  admitTaskTurn(command: AdmitTaskSessionTurnRequest): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(command.session.projectId, command.session.id, () =>
      this.stateOwner.admitTaskTurn(command)
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
    isRuntimeBusy: (sessionId: string) => boolean | Promise<boolean> = () => false
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
    isRuntimeBusy: () => boolean | Promise<boolean> = () => false
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(request.projectId, request.sessionId, () =>
      this.deletionOwner.updateArchive(request, isRuntimeBusy)
    )
  }

  // Persists authoritative JSON before updating the derived index. If indexing fails, the save stays
  // durable, the caller receives the error for its normal retry path, and Files is reset to show its
  // incomplete state rather than silently presenting stale metadata as complete.
  async saveSession(
    session: PersistedChatSession,
    options: SaveSessionOptions = {},
    authority: SessionSaveAuthority = { taskRunCommit: false }
  ): Promise<PersistedChatSession> {
    // A renderer may already have a delayed projection save when another client reserves export.
    // Wait outside the scheduler lane so browsing/global reads and unrelated Sessions stay usable.
    const terminalWriteRelease = this.stateOwner.assertRuntimeTerminalWriteAvailable(session.id)
    if (terminalWriteRelease) await terminalWriteRelease
    if (options.conversationCommands?.some(({ kind }) => kind === 'prepare-prompt')) {
      const failure = this.stateOwner
        .listRuntimeTerminalFailures()
        .find(
          (event) =>
            event.sessionId === session.id && event.terminalScope?.projectId === session.projectId
        )
      if (failure?.promptMessageId && failure.terminalScope)
        await this.stateOwner.retryRuntimeTerminalCommit({
          projectId: session.projectId,
          sessionId: session.id,
          promptMessageId: failure.promptMessageId,
          executionId: failure.terminalScope.executionId
        })
    }
    for (;;) {
      const result = await this.operationScheduler.runSession(
        session.projectId,
        session.id,
        async () => {
          const reservation = this.exportingSessions.get(sessionKey(session.projectId, session.id))
          if (reservation) return { released: reservation.released }
          await assertSessionIdentityOwnership(this.repository, this.stateOwner, session)
          return {
            saved: await this.stateOwner.saveSession(
              session,
              sanitizeRendererSaveSessionOptions(options, session),
              authority
            )
          }
        }
      )
      if (result.saved) {
        return this.projectRuntimeSession(result.saved)
      }
      await result.released
    }
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

  // Drain earlier writes in the existing persistence lane before freezing this Session.
  async reserveSessionExport(projectId: string, sessionId: string): Promise<() => void> {
    const failure = this.listRuntimeTerminalFailures().find(
      (event) => event.sessionId === sessionId && event.terminalScope?.projectId === projectId
    )
    if (failure?.promptMessageId && failure.terminalScope) {
      await this.retryRuntimeTerminalCommit({
        projectId,
        sessionId,
        promptMessageId: failure.promptMessageId,
        executionId: failure.terminalScope.executionId
      })
      if (
        this.listRuntimeTerminalFailures().some(
          (event) => event.sessionId === sessionId && event.terminalScope?.projectId === projectId
        )
      )
        throw new Error('Wait for the Session to finish before exporting it.')
    }
    return this.operationScheduler.runSession(projectId, sessionId, async () => {
      this.assertMutable(projectId, sessionId, 'mutate')
      const key = sessionKey(projectId, sessionId)
      let release!: () => void
      const reservation = {
        projectId,
        released: new Promise<void>((resolve) => {
          release = resolve
        })
      }
      this.exportingSessions.set(key, reservation)
      return () => {
        if (this.exportingSessions.get(key) === reservation) this.exportingSessions.delete(key)
        release()
      }
    })
  }

  runSessionMutation<Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ): Promise<Result> {
    return this.operationScheduler.runSessionProjectExclusive(projectId, sessionId, async () => {
      this.assertMutable(projectId, sessionId, 'mutate')
      try {
        return await mutation()
      } finally {
        // Force the next save to validate Artifact finalization's binding before reusing topology.
        this.stateOwner.invalidateBindingTopology(projectId, sessionId)
        // External package publishers may commit through another repository instance.
        this.hydrationCache.invalidate()
      }
    })
  }

  mutateRuntimeSession(
    scope: { projectId: string; sessionId: string },
    mutate: (session: PersistedChatSession) => PersistedChatSession,
    onJsonCommitted?: () => void
  ): Promise<PersistedChatSession> {
    return this.operationScheduler.runSession(scope.projectId, scope.sessionId, () =>
      this.stateOwner.mutateRuntimeSession(scope, mutate, onJsonCommitted)
    )
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

  commitRecoveredArtifactReferences(
    request: ReconcilePendingArtifactsRequest,
    artifacts: import('../../shared/artifacts').ArtifactFile[]
  ): Promise<void> {
    return this.operationScheduler.runSession(request.projectId, request.sessionId, async () => {
      this.assertMutable(request.projectId, request.sessionId, 'mutate')
      const authority = await this.repository.loadSessionWithDiagnostics(
        request.projectId,
        request.sessionId,
        { preserveRuntimeState: true }
      )
      if (authority.status !== 'found')
        throw new Error('Cannot retry Artifact finalization without a readable Session.')
      await this.reconciliationOwner.commitRecoveredArtifacts(
        authority.session,
        request.messageId,
        artifacts,
        request.pendingPaths
      )
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
    const operation = (): Promise<ProjectSessionDeletionResult> =>
      this.withDeletionCleanup((onDeleted) =>
        this.operationScheduler.runProject(projectId, async (scope) => {
          if (
            [...this.exportingSessions.values()].some(
              (reservation) => reservation.projectId === projectId
            )
          )
            throw new Error('This Project contains a Session locked for export.')
          // Whole-Project deletion can complete from a durable intent without re-entering
          // stateOwner.removeProject (for example an already-absent Project with a legacy tombstone).
          // Invalidate here so the next catalog load cannot reuse a pre-deletion authority scan.
          this.hydrationCache.invalidate()
          this.deletedProjects.add(projectId)
          try {
            const deleted = await this.deletionOwner.deleteProjectSessions(
              projectId,
              (sessionIds, operation) => scope.runSessionIdentities(sessionIds, operation),
              onDeleted,
              options
            )
            for (const key of this.sessionRecordProblems.keys()) {
              if (key.startsWith(`${projectId}\0`)) this.sessionRecordProblems.delete(key)
            }
            return deleted
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
      )
    return this.deletionWork
      ? this.deletionWork.withProjectStopped(projectId, operation)
      : operation()
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
    return this.operationScheduler.runManifest(() => {
      this.hydrationCache.invalidate()
      return this.repository.saveManifest(request)
    })
  }

  /**
   * Deletes one session with reversible index-first ordering.
   *
   * After JSON deletion succeeds, surviving sessions in the project are retried because legacy
   * duplicates may now claim canonical file rows. Their changed sources are broadcast before the
   * deleted-owner event so already loaded renderer pages invalidate in the same operation.
   */
  deleteSession(projectId: string, sessionId: string): Promise<void> {
    const operation = (): Promise<void> =>
      this.withDeletionCleanup((onDeleted) =>
        this.operationScheduler.runSessionThenGlobalIfNeeded(
          projectId,
          sessionId,
          async () => {
            const key = sessionKey(projectId, sessionId)
            // A committed deletion may need to retry its remaining cleanup. Only an active export
            // blocks deletion; the mutation tombstone must continue to block saves, not these retries.
            if (this.exportingSessions.has(key))
              throw new Error(
                'This Session is locked while its research package is being exported.'
              )
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
                .reconcileProjectSessionDeletion(
                  projectId,
                  sessionId,
                  deletion.receiptKind,
                  onDeleted
                )
                .catch((error: unknown) => {
                  throw new SessionDeletionCommittedError(error)
                }))
            if (reconciled) {
              this.clearSessionRecordProblem(projectId, sessionId)
              if (deletion.cleanupError) throw deletion.cleanupError
              return undefined
            }
            return deletion
          },
          async ({ receiptKind, cleanupError }) => {
            await this.deletionOwner
              .reconcileSessionDeletion(projectId, sessionId, receiptKind, onDeleted)
              .catch((error: unknown) => {
                throw new SessionDeletionCommittedError(error)
              })
            this.clearSessionRecordProblem(projectId, sessionId)
            if (cleanupError) throw cleanupError
          }
        )
      )
    return this.deletionWork
      ? this.deletionWork.withSessionStopped(projectId, sessionId, operation)
      : operation()
  }

  deleteRecoveryFile(request: DeleteSessionRecoveryFileRequest): Promise<void> {
    const validated = deleteSessionRecoveryFileRequestSchema.parse(request)
    return this.operationScheduler.runSession(
      validated.projectId,
      validated.fileName.slice(0, -5),
      async () => {
        if (!this.repository.deleteRecoveryFile)
          throw new Error('Session recovery deletion is unavailable.')
        this.assertMutable(validated.projectId, validated.fileName.slice(0, -5), 'mutate')
        try {
          await this.repository.deleteRecoveryFile(validated)
        } finally {
          // A partial removal must also force the next catalog read to inspect disk again.
          this.hydrationCache.invalidate()
        }
      }
    )
  }

  private assertMutable(
    projectId: string,
    sessionId: string,
    operation: 'save' | 'mutate',
    projectionOnly = false
  ): void {
    if (!projectionOnly && this.exportingSessions.has(sessionKey(projectId, sessionId)))
      throw new Error('This Session is locked while its research package is being exported.')
    if (this.pendingDeletionCleanups.has(sessionId)) {
      throw new Error('Session deletion cleanup is still pending. Retry after deletion completes.')
    }
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

  // Reserve ID-only projections before releasing persistence scopes, but never await external
  // owners while holding those scopes: their queues may already be waiting for a Session save.
  private async withDeletionCleanup<Result>(
    operation: (onDeleted: (sessionIds: string[]) => void) => Promise<Result>
  ): Promise<Result> {
    const deletedIds = new Set<string>()
    try {
      return await operation((sessionIds) => {
        if (!this.sessionDeletionHandlers) return
        for (const sessionId of sessionIds) {
          if (deletedIds.has(sessionId)) continue
          deletedIds.add(sessionId)
          this.pendingDeletionCleanups.set(
            sessionId,
            (this.pendingDeletionCleanups.get(sessionId) ?? 0) + 1
          )
        }
      })
    } finally {
      if (deletedIds.size > 0) {
        try {
          await this.notifySessionsDeleted([...deletedIds])
        } finally {
          for (const sessionId of deletedIds) {
            const remaining = this.pendingDeletionCleanups.get(sessionId)! - 1
            if (remaining === 0) this.pendingDeletionCleanups.delete(sessionId)
            else this.pendingDeletionCleanups.set(sessionId, remaining)
          }
        }
      }
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

// Public command surface for composition ports; internal owner fields never cross this boundary.
type SessionPersistenceCommands = Pick<
  SessionPersistenceCoordinator,
  keyof SessionPersistenceCoordinator
>

type SessionCatalog = Pick<
  SessionPersistenceCoordinator,
  'containsMessageOnActiveBranch' | 'loadSessionForContinuation' | 'sessionProjectId'
>
type SessionMutation = Pick<
  SessionPersistenceCoordinator,
  'appendUserMessageToInteraction' | 'mutateRuntimeSession'
>
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
  PreparedSessionRecovery,
  RecoveredSessionReference,
  SessionPersistenceCommands,
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
