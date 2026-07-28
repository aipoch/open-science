import type { ProjectFilesChangedEvent } from '../../shared/project-files'
import type { ProjectFileSource } from '../../shared/project-files'
import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../../shared/session-persistence'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import type { SessionDeletionReceipt } from '../artifacts/provenance-message-snapshot'

type SessionMutationRepository = {
  loadAllWithDiagnostics(): Promise<{
    result: LoadAllSessionsResult
    isComplete: boolean
  }>
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  saveSession(session: PersistedChatSession): Promise<void>
  deleteSession(projectId: string, sessionId: string): Promise<void>
  deleteProjectSessions(projectId: string): Promise<void>
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
  restoreProject(projectId: string, token: ManagedFileSoftDeleteToken): Promise<void>
  reconcileActiveSessions(sessions: PersistedChatSession[]): Promise<void>
  markReconciliationIncomplete(): void
}

type SessionProvenancePersistence = {
  captureFinalizedMessages(session: PersistedChatSession): Promise<void>
  reconcileSessionDeletions(activeSessions: PersistedChatSession[]): Promise<void>
  prepareSessionDeletion(session: PersistedChatSession): Promise<SessionDeletionReceipt>
  completeSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
  abortSessionDeletion(receipt: SessionDeletionReceipt): Promise<void>
}

type SessionUploadPersistence = {
  upgradeLegacySessionUploads(session: PersistedChatSession): Promise<PersistedChatSession>
}

type ArtifactStorageReconciler = {
  reconcileSession(
    projectId: string,
    sessionId: string,
    durableSession: PersistedChatSession
  ): Promise<unknown>
}

const hasLegacySessionUpload = (session: PersistedChatSession): boolean =>
  [...session.messages, ...(session.conversationGraph?.messages ?? [])].some((message) =>
    message.uploads?.some((upload) => !upload.versionId)
  )

// Serializes authoritative session JSON and derived file-index mutations through one queue. This is
// the consistency boundary that prevents a late save from racing or reviving a durable deletion.
class SessionPersistenceCoordinator {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly deletedSessions = new Set<string>()
  private readonly deletedProjects = new Set<string>()

  constructor(
    private readonly repository: SessionMutationRepository,
    private readonly fileIndex: SessionFileIndex,
    private readonly onFilesChanged?: (event: ProjectFilesChangedEvent) => void,
    private readonly provenance?: SessionProvenancePersistence,
    private readonly uploads?: SessionUploadPersistence,
    private readonly artifactStorage?: ArtifactStorageReconciler
  ) {}

  /**
   * Loads durable sessions and backfills their file projection only after a complete scan has restored
   * active ownership. Chat hydration remains available when indexing or reconciliation fails.
   */
  loadAll(): Promise<LoadAllSessionsResult> {
    return this.enqueue(async () => {
      const scan = await this.repository.loadAllWithDiagnostics()

      if (!scan.isComplete) {
        // Without the full active-session set, syncing could let a readable duplicate steal a row from
        // a soft-deleted owner whose JSON was merely unreadable during this scan.
        this.fileIndex.markReconciliationIncomplete()
        return scan.result
      }

      try {
        await this.provenance?.reconcileSessionDeletions(scan.result.sessions)
        for (const session of scan.result.sessions) {
          await this.artifactStorage?.reconcileSession(session.projectId, session.id, session)
        }
        // Reconciliation restores active owners left soft-deleted by an interrupted delete before any
        // scan-order-dependent sync can offer their canonical rows to another session.
        await this.fileIndex.reconcileActiveSessions(scan.result.sessions)
      } catch {
        // The repository records the global incomplete marker; keep chat hydration available.
        return scan.result
      }

      for (const session of scan.result.sessions) {
        await this.fileIndex.syncSession(session).catch(() => undefined)
      }

      return scan.result
    })
  }

  // Persists authoritative JSON before updating the derived index. If indexing fails, the save stays
  // durable, the caller receives the error for its normal retry path, and Files is reset to show its
  // incomplete state rather than silently presenting stale metadata as complete.
  saveSession(session: PersistedChatSession): Promise<void> {
    return this.enqueue(async () => {
      if (this.deletedProjects.has(session.projectId)) {
        throw new Error('Cannot save a session whose project has been deleted.')
      }
      if (this.deletedSessions.has(sessionKey(session.projectId, session.id))) {
        throw new Error('Cannot save a session that has been deleted.')
      }

      const materializedSession = materializeSessionConversationGraph(session)
      const durableSession = this.uploads
        ? await this.uploads.upgradeLegacySessionUploads(materializedSession)
        : materializedSession
      await this.repository.saveSession(durableSession)
      await this.provenance?.captureFinalizedMessages(durableSession)
      let changedSources: ProjectFileSource[]
      try {
        changedSources = await this.fileIndex.syncSession(durableSession)
      } catch (error) {
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
    })
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
      return mutation()
    })
  }

  // Soft-deletes index rows before removing the project session directory. A failed durable delete
  // restores only rows tagged by this operation and clears the in-memory project tombstone.
  deleteProjectSessions(projectId: string): Promise<void> {
    return this.enqueue(async () => {
      this.deletedProjects.add(projectId)
      let token: ManagedFileSoftDeleteToken | undefined

      try {
        token = await this.fileIndex.softDeleteProject(projectId)
        await this.repository.deleteProjectSessions(projectId)
      } catch (error) {
        try {
          if (token) await this.fileIndex.restoreProject(projectId, token)
        } catch (restoreError) {
          this.fileIndex.markReconciliationIncomplete()
          throw restoreError
        } finally {
          this.deletedProjects.delete(projectId)
        }
        throw error
      }

      this.notifyFilesChanged({
        projectId,
        sources: ['artifact', 'upload'],
        kind: 'reset'
      })
    })
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
        let session = await this.repository.loadSession(projectId, sessionId)
        if (session && this.uploads && hasLegacySessionUpload(session)) {
          session = await this.uploads.upgradeLegacySessionUploads(session)
          // Persist the immutable identity before tombstoning. If deletion is interrupted, startup
          // reconciliation can now retain the Upload Version without relying on a legacy path.
          await this.repository.saveSession(session)
        }
        if (session && this.provenance) {
          receipt = await this.provenance.prepareSessionDeletion(session)
        }
        if (receipt.kind === 'ordinary') {
          token = await this.fileIndex.softDeleteSession(projectId, sessionId)
        }
        await this.repository.deleteSession(projectId, sessionId)
        jsonDeleted = true
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
          this.fileIndex.markReconciliationIncomplete()
        }
      } catch {
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
}

const sessionKey = (projectId: string, sessionId: string): string => `${projectId}:${sessionId}`

export { SessionPersistenceCoordinator }
export type { SessionFileIndex, SessionMutationRepository, SessionProvenancePersistence }
