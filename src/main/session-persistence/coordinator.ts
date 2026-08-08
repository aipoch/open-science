import type { ProjectFilesChangedEvent } from '../../shared/project-files'
import type { ProjectFileSource } from '../../shared/project-files'
import type {
  LoadAllSessionsResult,
  PersistedChatMessage,
  PersistedChatSession,
  SaveSessionOptions,
  SaveSessionManifestRequest,
  UpdateSessionArchiveRequest,
  SessionRuntimeContext,
  SessionLoadFailure,
  SessionLoadWarning
} from '../../shared/session-persistence'
import type { SessionDeletionReceipt } from '../artifacts/provenance-message-snapshot'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'
import type { ProjectSessionDeletionState } from './repository'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import {
  SessionPersistenceStateOwner,
  SessionRuntimeContextRevisionConflictError,
  type AppendUserMessageToInteractionCommand,
  type PatchSessionRuntimeContextCommand,
  type SessionMetadata,
  type SessionMetadataSnapshot
} from './state-owner'
import {
  SessionPersistenceDeletionOwner,
  type ProjectSessionDeletionResult
} from './deletion-owner'
import {
  SessionPersistenceReconciliationOwner,
  type ArtifactStorageReconciler,
  type SessionPermissionGrantReconciliation,
  type SessionUploadPersistence
} from './reconciliation-owner'

type SessionMutationRepository = {
  loadAllWithDiagnostics(options?: { mode?: 'repair' | 'read-only' }): Promise<{
    result: LoadAllSessionsResult
    isComplete: boolean
    warnings?: SessionLoadWarning[]
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
  saveSession(session: PersistedChatSession): Promise<void>
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
  reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void>
  markReconciliationIncomplete(): void
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

// Serializes authoritative session JSON and derived file-index mutations through one queue. This is
// the consistency boundary that prevents a late save from racing or reviving a durable deletion.
class SessionPersistenceCoordinator {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly deletedSessions = new Set<string>()
  private readonly deletedProjects = new Set<string>()
  private readonly stateOwner: SessionPersistenceStateOwner
  private readonly deletionOwner: SessionPersistenceDeletionOwner
  private readonly reconciliationOwner: SessionPersistenceReconciliationOwner
  private destructiveStartupWindowOpen = true
  private sessionDeletionHandlers: SessionDeletionHandlers | undefined

  constructor(
    private readonly repository: SessionMutationRepository,
    private readonly fileIndex: SessionFileIndex,
    private readonly onFilesChanged?: (event: ProjectFilesChangedEvent) => void,
    provenance?: SessionProvenancePersistence,
    uploads?: SessionUploadPersistence,
    artifactStorage?: ArtifactStorageReconciler,
    permissionGrants?: SessionPermissionGrantReconciliation,
    private readonly log: Logger = createLogger('session-persistence')
  ) {
    this.stateOwner = new SessionPersistenceStateOwner({
      repository,
      fileIndex,
      provenance,
      uploads,
      log,
      assertMutable: (projectId, sessionId, operation) => {
        if (this.deletedProjects.has(projectId)) {
          throw new Error(`Cannot ${operation} a session whose project has been deleted.`)
        }
        if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
          throw new Error(`Cannot ${operation} a session that has been deleted.`)
        }
      },
      notifyFilesChanged: (event) => this.notifyFilesChanged(event)
    })
    this.deletionOwner = new SessionPersistenceDeletionOwner({
      repository,
      fileIndex,
      stateOwner: this.stateOwner,
      provenance,
      uploads,
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
  }

  containsMessageOnActiveBranch(
    projectId: string,
    sessionId: string,
    messageId: string
  ): Promise<boolean> {
    return this.enqueue(() =>
      this.stateOwner.containsMessageOnActiveBranch(projectId, sessionId, messageId)
    )
  }

  // Binds unread cleanup to authoritative Session mutations. Reconciliation is called only with a
  // complete live Session catalog, while commit runs only after deletion succeeds.
  setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void {
    this.sessionDeletionHandlers = handlers
  }

  sessionMetadataSnapshot(): Promise<SessionMetadataSnapshot> {
    return this.enqueue(async () => this.stateOwner.metadataSnapshot())
  }

  /**
   * Reads the Session authority without running recovery or derived-state reconciliation. This is
   * the degraded path used when an earlier startup prerequisite failed: healthy transcripts remain
   * navigable, while the incomplete marker keeps writes blocked until a full retry succeeds.
   */
  loadAllReadOnly(): Promise<LoadAllSessionsResult> {
    return this.enqueue(async () => {
      this.stateOwner.beginHydration()
      // Once any renderer has observed a degraded snapshot, later loads are no longer allowed to
      // treat the process as an untouched startup boundary for destructive cleanup.
      this.destructiveStartupWindowOpen = false
      this.fileIndex.markReconciliationIncomplete()
      const operation = startDiagnosticOperation(this.log, {
        operation: 'session-hydration',
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
    return this.enqueue(async () => {
      this.stateOwner.beginHydration()
      // Public loadAll can be called by multiple renderers/tasks. Only the first invocation in this
      // process is a startup boundary; consume it before any await so failures and partial scans cannot
      // reopen destructive cleanup while live clients may already hold the legacy projection.
      const mayRunDestructiveStartupCleanup = this.destructiveStartupWindowOpen
      this.destructiveStartupWindowOpen = false
      const operation = startDiagnosticOperation(this.log, {
        operation: 'session-hydration',
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
      this.stateOwner.replaceMetadata(scan.result.sessions, scan.isComplete)
      scan.result.diagnostics = {
        isComplete: scan.isComplete,
        warnings: scan.warnings ?? [],
        failure: scan.failure
      }
      const result = scan.result
      const sessions = scan.result.sessions

      if (!scan.isComplete) {
        // Without the full active-session set, syncing could let a readable duplicate steal a row from
        // a soft-deleted owner whose JSON was merely unreadable during this scan.
        this.fileIndex.markReconciliationIncomplete()
        operation.complete({
          status: 'partial',
          sessionCount: sessions.length,
          warningCount: scan.warnings?.length ?? 0
        })
        return result
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
        this.fileIndex.markReconciliationIncomplete()
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
    return this.enqueue(() => this.stateOwner.readRuntimeContext(projectId, sessionId))
  }

  patchSessionRuntimeContext(
    command: PatchSessionRuntimeContextCommand
  ): Promise<SessionRuntimeContext> {
    return this.enqueue(() => this.stateOwner.patchRuntimeContext(command))
  }

  appendUserMessageToInteraction(
    command: AppendUserMessageToInteractionCommand
  ): Promise<PersistedChatMessage> {
    return this.enqueue(() => this.stateOwner.appendUserMessage(command))
  }

  // Project archive must fail closed when even one child Session cannot be read. A partial catalog
  // cannot prove that an omitted Session is idle, so it is unsafe to hide the whole Project.
  assertProjectArchivable(
    projectId: string,
    isRuntimeBusy: (sessionId: string) => boolean = () => false
  ): Promise<string[]> {
    return this.enqueue(() => this.deletionOwner.assertProjectArchivable(projectId, isRuntimeBusy))
  }

  // Used by runtime admission checks after resolving a known project/session pair. It is intentionally
  // read-only: restoring an item never attaches or resumes an agent session by itself.
  assertSessionAvailable(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => this.deletionOwner.assertSessionAvailable(projectId, sessionId))
  }

  // Finds a persisted Session's owner for runtime admission. Fresh, unsaved sessions have no durable
  // archive state and deliberately return undefined.
  sessionProjectId(sessionId: string): Promise<string | undefined> {
    return this.enqueue(async () => this.stateOwner.sessionProjectId(sessionId))
  }

  // Dedicated main-owned archive mutation. Unlike full renderer saves it preserves updatedAt and
  // never allows a stale renderer projection to alter archive state.
  updateArchive(
    request: UpdateSessionArchiveRequest,
    isRuntimeBusy: () => boolean = () => false
  ): Promise<PersistedChatSession> {
    return this.enqueue(() => this.deletionOwner.updateArchive(request, isRuntimeBusy))
  }

  // Persists authoritative JSON before updating the derived index. If indexing fails, the save stays
  // durable, the caller receives the error for its normal retry path, and Files is reset to show its
  // incomplete state rather than silently presenting stale metadata as complete.
  saveSession(
    session: PersistedChatSession,
    options: SaveSessionOptions = {}
  ): Promise<PersistedChatSession> {
    return this.enqueue(() => this.stateOwner.saveSession(session, options))
  }

  // Specialist switching reads the latest durable Session and changes only this safe binding. Keep
  // that intent inside the persistence boundary so every caller receives graph-conflict recovery.
  saveSessionSpecialistBinding(
    session: PersistedChatSession,
    specialistId: string | undefined
  ): Promise<PersistedChatSession> {
    return this.enqueue(() =>
      this.stateOwner.saveSession(
        { ...session, specialistId },
        { conflictRebaseFields: ['specialistId'] }
      )
    )
  }

  // Joins late Session-owned side effects (for example Upload finalization) to the same ordering
  // boundary as JSON save and deletion. The mutation is rejected after a Session/Project tombstone.
  runSessionMutation<Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ): Promise<Result> {
    return this.enqueue(async () => {
      if (this.deletedProjects.has(projectId)) {
        throw new Error('Cannot mutate a session whose project has been deleted.')
      }
      if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
        throw new Error('Cannot mutate a session that has been deleted.')
      }
      try {
        return await mutation()
      } finally {
        // Artifact finalization can add a new binding without changing the Session graph. Force the
        // next save to validate that new database scope before reusing a topology fingerprint.
        this.stateOwner.invalidateBindingTopology(projectId, sessionId)
      }
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
    return this.enqueue(async () => {
      this.deletedProjects.add(projectId)
      try {
        return await this.deletionOwner.deleteProjectSessions(projectId, options)
      } catch (error) {
        try {
          const state = await this.deletionOwner.getProjectSessionDeletionState(projectId)
          if (state === 'live' || state === 'absent') {
            this.deletedProjects.delete(projectId)
          }
        } catch {
          // Unknown durable state is treated as committed: retain the in-memory tombstone and intent.
          this.fileIndex.markReconciliationIncomplete()
        }
        throw error
      }
    })
  }

  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState> {
    return this.enqueue(() => this.deletionOwner.getProjectSessionDeletionState(projectId))
  }

  markCommittedProjectSessionsPrepared(projectId: string): Promise<void> {
    return this.enqueue(() => this.deletionOwner.markCommittedProjectSessionsPrepared(projectId))
  }

  completeProjectSessionDeletion(projectId: string): Promise<void> {
    return this.enqueue(() => this.deletionOwner.completeProjectSessionDeletion(projectId))
  }

  listLegacyProjectSessionTombstones(): Promise<string[]> {
    return this.enqueue(() => this.deletionOwner.listLegacyProjectSessionTombstones())
  }

  /**
   * Explicitly repairs the global file projection from a complete session scan.
   *
   * Every project is synchronized before the global reconciliation marker can be cleared. A second
   * pass handles rows released by reconciliation. Errors are tracked per session so a transient first
   * failure that succeeds on the final pass does not make the repair IPC report a false failure.
   */
  repairProjectFiles(projectId: string): Promise<void> {
    return this.enqueue(async () => {
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
    return this.enqueue(() => this.repository.saveManifest(request))
  }

  /**
   * Deletes one session with reversible index-first ordering.
   *
   * After JSON deletion succeeds, surviving sessions in the project are retried because legacy
   * duplicates may now claim canonical file rows. Their changed sources are broadcast before the
   * deleted-owner event so already loaded renderer pages invalidate in the same operation.
   */
  deleteSession(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const key = sessionKey(projectId, sessionId)
      this.deletedSessions.add(key)
      try {
        await this.deletionOwner.deleteSession(projectId, sessionId)
      } catch (error) {
        this.deletedSessions.delete(key)
        throw error
      }
    })
  }

  // Rejections are absorbed only by the queue tail, not by the returned task promise. Later mutations
  // therefore continue in order while each caller still receives its own failure.
  private enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
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

export { SessionPersistenceCoordinator, SessionRuntimeContextRevisionConflictError }
export type {
  PatchSessionRuntimeContextCommand,
  ProjectSessionDeletionResult,
  SessionDeletionHandlers,
  SessionFileIndex,
  SessionMetadata,
  SessionMetadataSnapshot,
  SessionMutationRepository,
  SessionProvenancePersistence
}
