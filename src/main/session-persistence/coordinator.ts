import type { ProjectFilesChangedEvent } from '../../shared/project-files'
import type { ProjectFileSource } from '../../shared/project-files'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import type {
  LoadAllSessionsResult,
  PersistedArtifact,
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
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import type { ArtifactProjectReconciliationSnapshot } from '../artifacts/provenance-repository'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { repairHistoricalArtifactAliases } from './artifact-alias-repair'
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
  hasLegacySessionUpload,
  type ProjectSessionDeletionResult
} from './deletion-owner'

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

type SessionPermissionGrantReconciliation = {
  reconcileSessions(
    sessions: ReadonlyArray<{ projectId: string; sessionId: string }>
  ): Promise<void>
}

type SessionUploadPersistence = {
  upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options?: { mode?: 'reconcile' | 'live-save' | 'orphan-recovery' | 'terminal-delete' }
  ): Promise<PersistedChatSession>
}

type RecoveredMessageArtifacts = { messageId: string; artifacts: ArtifactVersionFile[] }

type ArtifactStorageReconciler = {
  prepareProjectReconciliation(projectId: string): Promise<ArtifactProjectReconciliationSnapshot>
  reconcileSession(
    projectId: string,
    sessionId: string,
    durableSession: PersistedChatSession,
    options?: {
      removeOrphanStaging?: boolean
      projectReconciliation?: ArtifactProjectReconciliationSnapshot
    }
  ): Promise<
    | {
        recoveredMessageArtifacts: RecoveredMessageArtifacts[]
      }
    | undefined
  >
}

type SessionDeletionHandlers = {
  commit(sessionIds: string[]): Promise<void>
  reconcile(existingSessionIds: string[], archivedSessionIds: string[]): Promise<void>
}

const toPersistedArtifact = (artifact: ArtifactVersionFile): PersistedArtifact => ({
  id: artifact.id,
  artifactId: artifact.artifactId,
  versionId: artifact.versionId,
  versionNumber: artifact.versionNumber,
  kind: 'managed-file',
  path: artifact.path,
  fileUrl: artifact.fileUrl,
  name: artifact.name,
  mimeType: artifact.mimeType,
  size: artifact.size,
  mtimeMs: artifact.mtimeMs,
  sha256: artifact.checksum
})

const persistedArtifactsEqual = (left: PersistedArtifact, right: PersistedArtifact): boolean =>
  Object.entries(right).every(([field, value]) => left[field as keyof PersistedArtifact] === value)

const appendUnique = (existing: string[] | undefined, incoming: readonly string[]): string[] => {
  const result = [...(existing ?? [])]
  const seen = new Set(result)
  for (const value of incoming) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
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

// Reattach native Versions through the Session authority, preserving graph-only inactive Branches.
const attachRecoveredMessageArtifacts = (
  session: PersistedChatSession,
  recoveries: RecoveredMessageArtifacts[]
): PersistedChatSession => {
  if (recoveries.length === 0) return session

  const materialized = materializeSessionConversationGraph(session)
  const messageIds = new Set([
    ...materialized.messages.map((message) => message.id),
    ...(materialized.conversationGraph?.messages.map((message) => message.id) ?? [])
  ])
  const recoveredByMessage = new Map<string, Map<string, PersistedArtifact>>()
  for (const recovery of recoveries) {
    if (!messageIds.has(recovery.messageId)) continue
    const artifacts = recoveredByMessage.get(recovery.messageId) ?? new Map()
    for (const artifact of recovery.artifacts) {
      artifacts.set(artifact.id, toPersistedArtifact(artifact))
    }
    if (artifacts.size > 0) recoveredByMessage.set(recovery.messageId, artifacts)
  }
  if (recoveredByMessage.size === 0) return session

  const nextArtifacts = [...(materialized.artifacts ?? [])]
  const artifactIndexes = new Map(nextArtifacts.map((artifact, index) => [artifact.id, index]))
  let artifactsChanged = false
  for (const artifacts of recoveredByMessage.values()) {
    for (const artifact of artifacts.values()) {
      const index = artifactIndexes.get(artifact.id)
      if (index === undefined) {
        artifactIndexes.set(artifact.id, nextArtifacts.length)
        nextArtifacts.push(artifact)
        artifactsChanged = true
      } else if (!persistedArtifactsEqual(nextArtifacts[index], artifact)) {
        nextArtifacts[index] = artifact
        artifactsChanged = true
      }
    }
  }

  const now = Date.now()
  let flatMessagesChanged = false
  const messages = materialized.messages.map((message) => {
    const artifacts = recoveredByMessage.get(message.id)
    if (!artifacts) return message
    const artifactIds = appendUnique(message.artifactIds, [...artifacts.keys()])
    if (artifactIds.length === (message.artifactIds?.length ?? 0)) return message
    flatMessagesChanged = true
    return { ...message, artifactIds, updatedAt: now }
  })
  let graphMessagesChanged = false
  const conversationGraph = materialized.conversationGraph
    ? {
        ...materialized.conversationGraph,
        messages: materialized.conversationGraph.messages.map((message) => {
          const artifacts = recoveredByMessage.get(message.id)
          if (!artifacts) return message
          const artifactIds = appendUnique(message.artifactIds, [...artifacts.keys()])
          if (artifactIds.length === (message.artifactIds?.length ?? 0)) return message
          graphMessagesChanged = true
          return { ...message, artifactIds, updatedAt: now }
        })
      }
    : undefined

  if (!artifactsChanged && !flatMessagesChanged && !graphMessagesChanged) return session
  return {
    ...materialized,
    artifacts: nextArtifacts,
    messages,
    conversationGraph,
    filesRevision: (materialized.filesRevision ?? 0) + 1,
    updatedAt: now
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
  private destructiveStartupWindowOpen = true
  private sessionDeletionHandlers: SessionDeletionHandlers | undefined

  constructor(
    private readonly repository: SessionMutationRepository,
    private readonly fileIndex: SessionFileIndex,
    private readonly onFilesChanged?: (event: ProjectFilesChangedEvent) => void,
    private readonly provenance?: SessionProvenancePersistence,
    private readonly uploads?: SessionUploadPersistence,
    private readonly artifactStorage?: ArtifactStorageReconciler,
    private readonly permissionGrants?: SessionPermissionGrantReconciliation,
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
      let result = scan.result
      let sessions = scan.result.sessions

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

      if (mayRunDestructiveStartupCleanup && this.permissionGrants) {
        operation.phase('reconcile-permission-grants')
        try {
          await this.permissionGrants.reconcileSessions(
            sessions.map((session) => ({ projectId: session.projectId, sessionId: session.id }))
          )
        } catch (error) {
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
      }

      operation.phase('reconcile-derived-state')
      try {
        if (this.uploads) {
          for (let index = 0; index < sessions.length; index += 1) {
            const session = sessions[index]
            const requiresProjectionWrite = hasLegacySessionUpload(session)
            if (requiresProjectionWrite) {
              // Build the complete immutable projection without consuming any source. Promise.all
              // publication may otherwise strand successful Uploads when a sibling upgrade fails.
              const upgradedSession = await this.uploads.upgradeLegacySessionUploads(session, {
                mode: 'live-save'
              })
              // Advance hydration before attempting the JSON write so a save failure still hands
              // callers the readable immutable projection produced by the completed live-save.
              sessions = sessions.map((candidate, candidateIndex) =>
                candidateIndex === index ? upgradedSession : candidate
              )
              result = { ...result, sessions }
              // Persist every immutable identity before startup reconciliation can consume a legacy
              // source. A failed write remains retryable because live-save preserved every source.
              await this.repository.saveSession(upgradedSession)
              if (mayRunDestructiveStartupCleanup) {
                await this.uploads.upgradeLegacySessionUploads(upgradedSession, {
                  mode: 'reconcile'
                })
              }
            } else {
              await this.uploads.upgradeLegacySessionUploads(session, {
                mode: mayRunDestructiveStartupCleanup ? 'reconcile' : 'live-save'
              })
            }
          }
        }

        await this.provenance?.reconcileSessionDeletions(sessions)
        const projectReconciliations = new Map<string, ArtifactProjectReconciliationSnapshot>()
        if (this.artifactStorage) {
          for (const projectId of new Set(sessions.map((session) => session.projectId))) {
            projectReconciliations.set(
              projectId,
              await this.artifactStorage.prepareProjectReconciliation(projectId)
            )
          }
        }
        for (let index = 0; index < sessions.length; index += 1) {
          const session = sessions[index]
          const artifactRecovery = await this.artifactStorage?.reconcileSession(
            session.projectId,
            session.id,
            session,
            {
              // Only the first process-level load is a startup boundary. Later renderer/task readers
              // may inspect recovery state but cannot destructively clean storage held by live clients.
              removeOrphanStaging: mayRunDestructiveStartupCleanup,
              projectReconciliation: projectReconciliations.get(session.projectId)!
            }
          )
          const attachedSession = attachRecoveredMessageArtifacts(
            session,
            artifactRecovery?.recoveredMessageArtifacts ?? []
          )
          const recoveredSession = repairHistoricalArtifactAliases(attachedSession, {
            // One reconciliation pass writes one JSON revision even when recovery and historical
            // alias repair both contribute to the same atomic Session update.
            advanceFilesRevision: attachedSession === session
          })
          if (recoveredSession !== session) {
            sessions = sessions.map((candidate, candidateIndex) =>
              candidateIndex === index ? recoveredSession : candidate
            )
            result = { ...result, sessions }
            // Capture immutable Message evidence before JSON. If either write fails, the unchanged
            // Session remains an attachment witness on the next startup and the whole sequence retries.
            await this.provenance?.captureFinalizedMessages(recoveredSession)
            await this.repository.saveSession(recoveredSession)
          }
        }
        // Reconciliation restores active owners left soft-deleted by an interrupted delete before any
        // scan-order-dependent sync can offer their canonical rows to another session.
        await this.fileIndex.reconcileActiveSessions(sessions)
        for (const session of sessions) {
          await this.fileIndex.syncSession(session)
        }
      } catch (error) {
        this.stateOwner.markMetadataIncomplete()
        this.fileIndex.markReconciliationIncomplete()
        operation.fail(error, {
          status: 'degraded',
          hydrationAvailable: true,
          sessionCount: sessions.length,
          warningCount: scan.warnings?.length ?? 0,
          degradedReconciliationCount
        })
        // Keep chat hydration available while Files remains explicitly incomplete and retryable.
        result.diagnostics = {
          isComplete: false,
          warnings: scan.warnings ?? [],
          failure: 'startup-reconciliation-failed'
        }
        return result
      }

      operation.complete({
        status: degradedReconciliationCount > 0 ? 'degraded' : 'ready',
        sessionCount: sessions.length,
        warningCount: scan.warnings?.length ?? 0,
        degradedReconciliationCount
      })
      return result
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

      const syncErrors = new Map<string, unknown>()
      for (const session of scan.result.sessions) {
        try {
          await this.fileIndex.syncSession(session, { force: true })
        } catch (error) {
          syncErrors.set(sessionKey(session.projectId, session.id), error)
        }
      }

      let reconciliationSucceeded = false
      let reconciliationError: unknown
      try {
        await this.fileIndex.reconcileActiveSessions(scan.result.sessions)
        reconciliationSucceeded = true
      } catch (error) {
        reconciliationError = error
      }

      if (reconciliationSucceeded) {
        for (const session of scan.result.sessions) {
          const key = sessionKey(session.projectId, session.id)
          try {
            await this.fileIndex.syncSession(session, { force: true })
            syncErrors.delete(key)
          } catch (error) {
            syncErrors.set(key, error)
          }
        }
      }

      // One reset refreshes overview and all cursor layers after the explicit repair attempt.
      this.notifyFilesChanged({
        projectId,
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })

      if (reconciliationError) throw reconciliationError
      const finalSyncError = syncErrors.values().next().value
      if (finalSyncError) throw finalSyncError
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
