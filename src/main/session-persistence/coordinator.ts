import { createHash, randomUUID } from 'node:crypto'

import type { ProjectFilesChangedEvent } from '../../shared/project-files'
import type { ProjectFileSource } from '../../shared/project-files'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import type {
  LoadAllSessionsResult,
  PersistedArtifact,
  PersistedChatMessage,
  PersistedChatSession,
  PersistedSessionStatus,
  SaveSessionOptions,
  SaveSessionManifestRequest,
  SessionRuntimeContext,
  SessionRuntimeContextPatch,
  SessionLoadFailure,
  SessionLoadWarning
} from '../../shared/session-persistence'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'
import type { ProjectSessionDeletionState } from './repository'
import {
  materializeSessionConversationGraph,
  sanitizeSessionRuntimeContext
} from '../../shared/session-persistence'
import {
  FinalizedArtifactBindingConflictError,
  type SessionDeletionReceipt
} from '../artifacts/provenance-message-snapshot'
import type { ArtifactProjectReconciliationSnapshot } from '../artifacts/provenance-repository'
import { createLogger, diagnosticErrorFields, type Logger } from '../logger'
import { repairHistoricalArtifactAliases } from './artifact-alias-repair'
import { startDiagnosticOperation } from '../diagnostics/operation'
import {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError
} from '../uploads/repository'

type ProjectSessionDeletionResult =
  { status: 'completed' } | { status: 'orphan-retained'; reason: 'missing-upload-authority' }

type SessionMetadata = Readonly<Pick<PersistedChatSession, 'id' | 'projectId' | 'title'>>

type SessionMetadataSnapshot = Readonly<{
  sessions: readonly SessionMetadata[]
  isComplete: boolean
}>

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
  reconcile(existingSessionIds: string[]): Promise<void>
}

type PatchSessionRuntimeContextCommand = Readonly<{
  projectId: string
  sessionId: string
  expectedRevision: number
  patch: SessionRuntimeContextPatch
  sessionStatus?: PersistedSessionStatus
}>

type AppendUserMessageToInteractionCommand = Readonly<{
  projectId: string
  sessionId: string
  interactionId: string
  content: string
}>

class SessionRuntimeContextRevisionConflictError extends Error {
  readonly code = 'revision-conflict' as const

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Session runtime context revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`
    )
    this.name = 'SessionRuntimeContextRevisionConflictError'
  }
}

const emptySessionRuntimeContext = (): SessionRuntimeContext => ({ version: 1, revision: 0 })

const cloneRuntimeContext = (context: SessionRuntimeContext): SessionRuntimeContext =>
  structuredClone(context)

const hasLegacySessionUpload = (session: PersistedChatSession): boolean =>
  [...session.messages, ...(session.conversationGraph?.messages ?? [])].some((message) =>
    message.uploads?.some((upload) => !upload.versionId)
  )

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

const rebaseSafeSessionFields = (
  authoritative: PersistedChatSession,
  submitted: PersistedChatSession,
  fields: NonNullable<SaveSessionOptions['conflictRebaseFields']>
): PersistedChatSession => {
  const rebased = { ...authoritative }
  for (const field of fields) {
    switch (field) {
      case 'title':
        rebased.title = submitted.title
        break
      case 'permissionProfile':
        rebased.permissionProfile = submitted.permissionProfile
        break
      case 'autoReviewEnabled':
        rebased.autoReviewEnabled = submitted.autoReviewEnabled
        break
      case 'enabledComputeHosts':
        rebased.enabledComputeHosts = submitted.enabledComputeHosts
          ? [...submitted.enabledComputeHosts]
          : undefined
        break
      case 'pinned':
        rebased.pinned = submitted.pinned
        break
      case 'specialistId':
        rebased.specialistId = submitted.specialistId
        break
    }
  }
  rebased.updatedAt = Math.max(authoritative.updatedAt, submitted.updatedAt) + 1
  return rebased
}

const sessionBindingTopologyHash = (session: PersistedChatSession): string => {
  const graph = session.conversationGraph
  const topology = graph
    ? {
        rootFrameId: graph.rootFrameId,
        branches: graph.branches.map(({ id, agentFrameId, headMessageId }) => ({
          id,
          agentFrameId,
          headMessageId
        })),
        messages: graph.messages.map(({ id, agentFrameId, parentMessageId }) => ({
          id,
          agentFrameId,
          parentMessageId
        }))
      }
    : null
  return createHash('sha256').update(JSON.stringify(topology)).digest('hex')
}

type FinalizedArtifactBindingValidation =
  | { status: 'valid' }
  | { status: 'unavailable' }
  | { status: 'conflict'; error: FinalizedArtifactBindingConflictError }

const validateFinalizedArtifactBindings = async (
  provenance: SessionProvenancePersistence | undefined,
  session: PersistedChatSession,
  log: Logger
): Promise<FinalizedArtifactBindingValidation> => {
  if (!provenance) return { status: 'valid' }

  try {
    await provenance.validateFinalizedMessageBindings(session)
    return { status: 'valid' }
  } catch (error) {
    if (error instanceof FinalizedArtifactBindingConflictError) {
      return { status: 'conflict', error }
    }
    // Provenance is derived from authoritative Session JSON. A transient lookup failure must not
    // regress the JSON-first durability guarantee; capture/indexing keep their post-save retry path.
    emitRecoverableDiagnostic(log, 'pre-save provenance validation unavailable', {
      operation: 'session-save',
      phase: 'validate-provenance',
      outcome: 'degraded',
      ...diagnosticErrorFields(error)
    })
    return { status: 'unavailable' }
  }
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
  private readonly validatedBindingTopologies = new Map<string, string>()
  private sessionMetadata = new Map<string, SessionMetadata>()
  private isSessionMetadataComplete = false
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
  ) {}

  // Binds unread cleanup to authoritative Session mutations. Reconciliation is called only with a
  // complete live Session catalog, while commit runs only after deletion succeeds.
  setSessionDeletionHandlers(handlers: SessionDeletionHandlers): void {
    this.sessionDeletionHandlers = handlers
  }

  sessionMetadataSnapshot(): Promise<SessionMetadataSnapshot> {
    return this.enqueue(async () => ({
      sessions: [...this.sessionMetadata.values()],
      isComplete: this.isSessionMetadataComplete
    }))
  }

  private replaceSessionMetadata(
    sessions: readonly PersistedChatSession[],
    isComplete: boolean
  ): void {
    this.sessionMetadata = new Map(
      sessions.map((session) => [
        session.id,
        { id: session.id, projectId: session.projectId, title: session.title }
      ])
    )
    this.isSessionMetadataComplete = isComplete
  }

  private upsertSessionMetadata(session: PersistedChatSession): void {
    this.sessionMetadata.set(session.id, {
      id: session.id,
      projectId: session.projectId,
      title: session.title
    })
  }

  private removeSessionMetadata(sessionId: string): void {
    this.sessionMetadata.delete(sessionId)
  }

  private removeProjectSessionMetadata(projectId: string): void {
    for (const [sessionId, metadata] of this.sessionMetadata) {
      if (metadata.projectId === projectId) this.sessionMetadata.delete(sessionId)
    }
  }

  /**
   * Reads the Session authority without running recovery or derived-state reconciliation. This is
   * the degraded path used when an earlier startup prerequisite failed: healthy transcripts remain
   * navigable, while the incomplete marker keeps writes blocked until a full retry succeeds.
   */
  loadAllReadOnly(): Promise<LoadAllSessionsResult> {
    return this.enqueue(async () => {
      this.validatedBindingTopologies.clear()
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
      this.replaceSessionMetadata(scan.result.sessions, false)
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
      this.validatedBindingTopologies.clear()
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
      this.replaceSessionMetadata(scan.result.sessions, scan.isComplete)
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
      operation.phase('reconcile-unread-deletions')
      try {
        await this.sessionDeletionHandlers?.reconcile(sessions.map((session) => session.id))
      } catch (error) {
        degradedReconciliationCount += 1
        // Unread metadata is a recoverable projection and must not block Session hydration.
        emitRecoverableDiagnostic(this.log, 'unread deletion reconciliation failed', {
          operation: 'session-hydration',
          phase: 'reconcile-unread-deletions',
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
        this.isSessionMetadataComplete = false
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

  private async loadRuntimeContextSession(
    projectId: string,
    sessionId: string,
    operation: 'read' | 'patch'
  ): Promise<PersistedChatSession> {
    const loaded = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
    if (loaded.status === 'unreadable') {
      throw new Error(
        `Cannot ${operation} Session runtime context because its durable JSON is unreadable.`
      )
    }
    if (loaded.status === 'missing') {
      throw new Error(`Cannot ${operation} runtime context for a missing Session.`)
    }
    return loaded.session
  }

  readSessionRuntimeContext(projectId: string, sessionId: string): Promise<SessionRuntimeContext> {
    return this.enqueue(async () => {
      const session = await this.loadRuntimeContextSession(projectId, sessionId, 'read')
      return cloneRuntimeContext(session.runtimeContext ?? emptySessionRuntimeContext())
    })
  }

  patchSessionRuntimeContext(
    command: PatchSessionRuntimeContextCommand
  ): Promise<SessionRuntimeContext> {
    return this.enqueue(async () => {
      const { projectId, sessionId, expectedRevision, patch, sessionStatus } = command
      if (this.deletedProjects.has(projectId)) {
        throw new Error('Cannot mutate a session whose project has been deleted.')
      }
      if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
        throw new Error('Cannot mutate a session that has been deleted.')
      }
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('Session runtime context expected revision must be a non-negative integer.')
      }
      if (Object.keys(patch).some((owner) => owner !== 'plan')) {
        throw new Error('Session runtime context patch contains an unknown authority owner.')
      }

      const session = await this.loadRuntimeContextSession(projectId, sessionId, 'patch')
      const current = session.runtimeContext ?? emptySessionRuntimeContext()
      if (current.revision !== expectedRevision) {
        throw new SessionRuntimeContextRevisionConflictError(expectedRevision, current.revision)
      }

      const candidate: Record<string, unknown> = { ...current }
      for (const [owner, value] of Object.entries(patch)) {
        if (value === undefined) delete candidate[owner]
        else candidate[owner] = value
      }
      candidate.revision = current.revision + 1
      const runtimeContext = sanitizeSessionRuntimeContext(candidate)
      if (!runtimeContext) throw new Error('Session runtime context patch is not JSON-safe.')

      await this.repository.saveSession({
        ...session,
        ...(sessionStatus ? { status: sessionStatus } : {}),
        runtimeContext,
        updatedAt: Math.max(session.updatedAt + 1, Date.now())
      })
      return cloneRuntimeContext(runtimeContext)
    })
  }

  appendUserMessageToInteraction(
    command: AppendUserMessageToInteractionCommand
  ): Promise<PersistedChatMessage> {
    return this.enqueue(async () => {
      const { projectId, sessionId, interactionId } = command
      const content = command.content.trim()
      if (!content) throw new Error('User Message content must be non-empty.')
      if (this.deletedProjects.has(projectId)) {
        throw new Error('Cannot mutate a session whose project has been deleted.')
      }
      if (this.deletedSessions.has(sessionKey(projectId, sessionId))) {
        throw new Error('Cannot mutate a session that has been deleted.')
      }
      const session = await this.loadRuntimeContextSession(projectId, sessionId, 'patch')
      const timestamp = Math.max(session.updatedAt + 1, Date.now())
      const message: PersistedChatMessage = {
        id: `message-${randomUUID()}`,
        role: 'user',
        content,
        status: 'complete',
        eventIds: [],
        responseToMessageId: interactionId,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      const durable = materializeSessionConversationGraph({
        ...session,
        messages: [...session.messages, message],
        updatedAt: timestamp
      })
      await this.repository.saveSession(durable)
      this.upsertSessionMetadata(durable)
      return message
    })
  }

  // Persists authoritative JSON before updating the derived index. If indexing fails, the save stays
  // durable, the caller receives the error for its normal retry path, and Files is reset to show its
  // incomplete state rather than silently presenting stale metadata as complete.
  saveSession(
    session: PersistedChatSession,
    options: SaveSessionOptions = {}
  ): Promise<PersistedChatSession> {
    return this.enqueue(async () => {
      if (this.deletedProjects.has(session.projectId)) {
        throw new Error('Cannot save a session whose project has been deleted.')
      }
      if (this.deletedSessions.has(sessionKey(session.projectId, session.id))) {
        throw new Error('Cannot save a session that has been deleted.')
      }

      // Whole-session saves are renderer-owned projections. Resolve main authority on every save so
      // a window holding an old snapshot cannot clear, forge, or roll back runtime context. An
      // unreadable primary fails closed because overwriting it would silently destroy that authority.
      const authoritative = await this.repository.loadSessionWithDiagnostics(
        session.projectId,
        session.id
      )
      if (authoritative.status === 'unreadable') {
        throw new Error(
          'Cannot save Session projection because main-owned runtime context is unreadable.'
        )
      }
      const { runtimeContext: _submittedRuntimeContext, ...rendererOwnedSession } = session
      void _submittedRuntimeContext
      const authority = authoritative.status === 'found' ? authoritative.session : undefined
      const mainOwnedStatus =
        authority?.status === 'waiting-plan-approval' ||
        rendererOwnedSession.status === 'waiting-plan-approval'
          ? (authority?.status ?? 'idle')
          : undefined
      const mergedSession: PersistedChatSession = {
        ...rendererOwnedSession,
        ...(authority?.runtimeContext ? { runtimeContext: authority.runtimeContext } : {}),
        // Awaiting Plan approval is main-owned blocking state and must survive the same stale save.
        ...(mainOwnedStatus ? { status: mainOwnedStatus } : {}),
        updatedAt:
          authority?.runtimeContext || mainOwnedStatus
            ? Math.max(rendererOwnedSession.updatedAt, (authority?.updatedAt ?? -1) + 1, Date.now())
            : rendererOwnedSession.updatedAt
      }

      const materializedSession = materializeSessionConversationGraph(mergedSession)
      let durableSession = this.uploads
        ? await this.uploads.upgradeLegacySessionUploads(materializedSession, {
            mode: 'live-save'
          })
        : materializedSession
      const key = sessionKey(session.projectId, session.id)
      let bindingTopology = sessionBindingTopologyHash(durableSession)
      let bindingValidation: FinalizedArtifactBindingValidation =
        this.validatedBindingTopologies.get(key) === bindingTopology
          ? { status: 'valid' }
          : await validateFinalizedArtifactBindings(this.provenance, durableSession, this.log)
      // Reject a stale graph before it can replace the authoritative Session JSON. Capture remains
      // after the durable write so immutable evidence never includes Message bytes that were not saved.
      // Streaming payload changes preserve this topology, avoiding a database lookup on every chunk.
      if (bindingValidation.status === 'conflict') {
        const conflictRebaseFields = options.conflictRebaseFields ?? []
        if (conflictRebaseFields.length === 0) throw bindingValidation.error

        const authoritative = await this.repository.loadSessionWithDiagnostics(
          session.projectId,
          session.id
        )
        if (authoritative.status !== 'found') throw bindingValidation.error

        const rebasedSession = rebaseSafeSessionFields(
          authoritative.session,
          durableSession,
          conflictRebaseFields
        )
        durableSession = this.uploads
          ? await this.uploads.upgradeLegacySessionUploads(rebasedSession, { mode: 'live-save' })
          : rebasedSession
        bindingTopology = sessionBindingTopologyHash(durableSession)
        bindingValidation =
          this.validatedBindingTopologies.get(key) === bindingTopology
            ? { status: 'valid' }
            : await validateFinalizedArtifactBindings(this.provenance, durableSession, this.log)
        if (bindingValidation.status === 'conflict') throw bindingValidation.error
      }
      await this.repository.saveSession(durableSession)
      this.upsertSessionMetadata(durableSession)
      // Cache only confirmed topology. A transient validation failure keeps the old fingerprint so
      // the next autosave retries the narrow lookup instead of silently treating it as acknowledged.
      if (bindingValidation.status === 'valid') {
        this.validatedBindingTopologies.set(key, bindingTopology)
      }
      await this.provenance?.captureFinalizedMessages(durableSession)
      let changedSources: ProjectFileSource[]
      try {
        changedSources = await this.fileIndex.syncSession(durableSession)
      } catch (error) {
        this.isSessionMetadataComplete = false
        // The JSON is already durable. Tell open Files views to surface the incomplete projection,
        // then preserve the rejection so the normal persistence retry path remains active.
        this.notifyFilesChanged({
          projectId: session.projectId,
          sources: ['artifact', 'upload'],
          kind: 'reset'
        })
        throw error
      }
      if (changedSources.length > 0) {
        this.notifyFilesChanged({
          projectId: session.projectId,
          sessionId: session.id,
          sources: changedSources,
          kind: 'upsert'
        })
      }
      return durableSession
    })
  }

  // Specialist switching reads the latest durable Session and changes only this safe binding. Keep
  // that intent inside the persistence boundary so every caller receives graph-conflict recovery.
  saveSessionSpecialistBinding(
    session: PersistedChatSession,
    specialistId: string | undefined
  ): Promise<PersistedChatSession> {
    return this.saveSession(
      { ...session, specialistId },
      { conflictRebaseFields: ['specialistId'] }
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
        this.validatedBindingTopologies.delete(sessionKey(projectId, sessionId))
      }
    })
  }

  // A path-only projection must become durable before terminal cleanup may consume its source.
  // Keeping the live-save source through the JSON commit makes a failed save safely retryable; once
  // the path-free identity is durable, terminal cleanup can run without stranding an active Session.
  private async prepareSessionUploadsForTerminalDelete(
    session: PersistedChatSession
  ): Promise<PersistedChatSession> {
    if (!this.uploads) return session

    if (!hasLegacySessionUpload(session)) {
      return this.uploads.upgradeLegacySessionUploads(session, { mode: 'terminal-delete' })
    }

    const upgradedSession = await this.uploads.upgradeLegacySessionUploads(session, {
      mode: 'live-save'
    })
    await this.repository.saveSession(upgradedSession)
    return this.uploads.upgradeLegacySessionUploads(upgradedSession, {
      mode: 'terminal-delete'
    })
  }

  // A whole-Project intent may retain only a positively identified unowned replacement. Path-only
  // JSON must first be durably upgraded before terminal cleanup consumes its source: the later atomic
  // Session-directory removal can still fail and restore a live Project. Every authority,
  // publication, filesystem, save, and private-claim failure aborts that reversible phase.
  private async prepareProjectSessionUploadsForTerminalDelete(
    session: PersistedChatSession,
    saveUpgradedSession: (session: PersistedChatSession) => Promise<void> = (upgraded) =>
      this.repository.saveSession(upgraded),
    requireExistingUploadAuthority = false
  ): Promise<{ hasUnsafeResidual: boolean }> {
    if (!this.uploads) return { hasUnsafeResidual: false }

    let terminalSession = session
    if (hasLegacySessionUpload(session)) {
      terminalSession = await this.uploads.upgradeLegacySessionUploads(session, {
        mode: requireExistingUploadAuthority ? 'orphan-recovery' : 'live-save'
      })
      await saveUpgradedSession(terminalSession)
    }

    try {
      await this.uploads.upgradeLegacySessionUploads(terminalSession, {
        mode: 'terminal-delete'
      })
      return { hasUnsafeResidual: false }
    } catch (error) {
      if (error instanceof UnsafeLegacyUploadResidualError) {
        return { hasUnsafeResidual: true }
      }
      throw error
    }
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
      let deletedSessionIds: string[] = []

      try {
        if (options.requireExistingUploadAuthority && !this.uploads) {
          throw new Error('Upload recovery is unavailable for an orphaned Project tombstone.')
        }
        const deletionState = await this.repository.getProjectSessionDeletionState(projectId)
        // Read the same live or committed authority used by Project deletion before its atomic
        // transition. Partial scans still contribute safe IDs; a later complete global scan removes
        // any unread rows that could not be named here.
        const scan =
          deletionState === 'legacy-committed' || deletionState === 'prepared'
            ? await this.repository.loadCommittedProjectWithDiagnostics(projectId)
            : await this.repository.loadProjectWithDiagnostics(projectId)
        deletedSessionIds = [...new Set(scan.sessions.map((session) => session.id))]

        if (this.uploads && deletionState !== 'prepared') {
          // Terminal deletion is the final point at which Session JSON and Upload SQLite authority
          // coexist. Reconcile retained live-save copies before either authority is removed.
          if (!scan.isComplete) {
            if (options.requireExistingUploadAuthority) {
              throw new Error(
                'Cannot adopt a legacy Project tombstone with incomplete Session authority.'
              )
            }
            // Whole-Project deletion is backed by a durable user intent and may discard opaque
            // Session authority. Still terminal-clean every readable Session below; unknown legacy
            // bytes are deliberately retained rather than guessed from a possibly-colliding runtime
            // Session id, while the atomic Project directory removal keeps recovery progressing.
            this.fileIndex.markReconciliationIncomplete()
          }
          for (const session of scan.sessions) {
            let cleanup: { hasUnsafeResidual: boolean }
            try {
              cleanup = await this.prepareProjectSessionUploadsForTerminalDelete(
                session,
                deletionState === 'legacy-committed'
                  ? (upgraded) => this.repository.saveCommittedProjectSession(upgraded)
                  : undefined,
                options.requireExistingUploadAuthority === true
              )
            } catch (error) {
              if (
                options.requireExistingUploadAuthority &&
                error instanceof OrphanLegacyUploadAuthorityMissingError
              ) {
                this.fileIndex.markReconciliationIncomplete()
                // Sibling Upload work has fully settled before this typed error is surfaced. Commit
                // derived index deletion now so a recovered Version cannot remain visible for a
                // logically deleted Project whose legacy tombstone must be retained.
                await this.fileIndex.softDeleteProject(projectId)
                await this.notifySessionsDeleted(deletedSessionIds)
                return { status: 'orphan-retained', reason: 'missing-upload-authority' }
              }
              throw error
            }
            if (cleanup.hasUnsafeResidual) {
              // Never guess-delete a positively identified replacement. The Project intent can still
              // commit because immutable Version authority exists and the unrelated bytes are kept.
              this.fileIndex.markReconciliationIncomplete()
            }
          }
        }
        if (deletionState === 'legacy-committed') {
          await this.repository.markCommittedProjectSessionsPrepared(projectId)
        }
        // The marked directory rename is the sole authoritative commit. Derived index deletion runs
        // afterward so any failure is replayable from the durable Project intent and tombstone.
        await this.repository.deleteProjectSessions(projectId)
        this.removeProjectSessionMetadata(projectId)
        for (const sessionId of deletedSessionIds) {
          this.validatedBindingTopologies.delete(sessionKey(projectId, sessionId))
        }
        await this.fileIndex.softDeleteProject(projectId)
      } catch (error) {
        try {
          const state = await this.repository.getProjectSessionDeletionState(projectId)
          if (state === 'live' || state === 'absent') {
            this.deletedProjects.delete(projectId)
          }
        } catch {
          // Unknown durable state is treated as committed: retain the in-memory tombstone and intent.
          this.fileIndex.markReconciliationIncomplete()
        }
        throw error
      }

      this.notifyFilesChanged({
        projectId,
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
      await this.notifySessionsDeleted(deletedSessionIds)
      return { status: 'completed' }
    })
  }

  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState> {
    return this.enqueue(() => this.repository.getProjectSessionDeletionState(projectId))
  }

  markCommittedProjectSessionsPrepared(projectId: string): Promise<void> {
    return this.enqueue(() => this.repository.markCommittedProjectSessionsPrepared(projectId))
  }

  completeProjectSessionDeletion(projectId: string): Promise<void> {
    return this.enqueue(() => this.repository.completeProjectSessionDeletion(projectId))
  }

  listLegacyProjectSessionTombstones(): Promise<string[]> {
    return this.enqueue(() => this.repository.listLegacyProjectSessionTombstones())
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
      let token: ManagedFileSoftDeleteToken | undefined
      let receipt: SessionDeletionReceipt = { kind: 'ordinary', projectId, sessionId }
      let jsonDeleted = false

      try {
        const loadedSession = await this.repository.loadSessionWithDiagnostics(projectId, sessionId)
        if (loadedSession.status === 'unreadable') {
          throw new Error('Cannot delete a Session whose durable JSON is unreadable.')
        }
        let session = loadedSession.status === 'found' ? loadedSession.session : undefined
        if (session && this.uploads) {
          session = await this.prepareSessionUploadsForTerminalDelete(session)
        }
        if (session && this.provenance) {
          receipt = await this.provenance.prepareSessionDeletion(session)
        }
        if (receipt.kind === 'ordinary') {
          token = await this.fileIndex.softDeleteSession(projectId, sessionId)
        }
        await this.repository.deleteSession(projectId, sessionId)
        jsonDeleted = true
        this.removeSessionMetadata(sessionId)
        this.validatedBindingTopologies.delete(key)
        await this.provenance?.completeSessionDeletion(receipt)
      } catch (error) {
        try {
          if (!jsonDeleted) {
            if (receipt.kind === 'retained') {
              await this.provenance?.abortSessionDeletion(receipt)
            }
            if (token) await this.fileIndex.restoreSession(projectId, sessionId, token)
          } else {
            // A missing JSON file plus a deleting origin is an intentional recovery state. Startup
            // reconciliation completes it; reverting to active would expose a dead navigation target.
            this.fileIndex.markReconciliationIncomplete()
          }
        } catch (restoreError) {
          this.fileIndex.markReconciliationIncomplete()
          throw restoreError
        } finally {
          this.deletedSessions.delete(key)
        }
        throw error
      }

      const survivorChanges: Array<{
        sessionId: string
        sources: ProjectFileSource[]
      }> = []
      try {
        const scan = await this.repository.loadAllWithDiagnostics()
        if (scan.isComplete) {
          this.replaceSessionMetadata(scan.result.sessions, true)
          // The deleted session may have owned a canonical row referenced by a surviving legacy
          // session. Retry the project's revision ledgers after the owner is durably gone.
          for (const session of scan.result.sessions) {
            if (session.projectId !== projectId) continue
            const changedSources = await this.fileIndex.syncSession(session).catch(() => undefined)
            if (changedSources?.length) {
              survivorChanges.push({ sessionId: session.id, sources: changedSources })
            }
          }
          // A complete scan is the commit point for clearing the deleted session's incomplete marker
          // and any other stale ledgers that no longer have authoritative JSON.
          await this.fileIndex.reconcileActiveSessions(scan.result.sessions)
        } else {
          this.isSessionMetadataComplete = false
          this.fileIndex.markReconciliationIncomplete()
        }
      } catch {
        this.isSessionMetadataComplete = false
        this.fileIndex.markReconciliationIncomplete()
      }

      for (const change of survivorChanges) {
        this.notifyFilesChanged({
          projectId,
          sessionId: change.sessionId,
          sources: change.sources,
          kind: 'upsert'
        })
      }

      this.notifyFilesChanged({
        projectId,
        sessionId,
        sources: ['artifact', 'upload'],
        kind: receipt.kind === 'retained' ? 'upsert' : 'delete'
      })
      await this.notifySessionsDeleted([sessionId])
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
