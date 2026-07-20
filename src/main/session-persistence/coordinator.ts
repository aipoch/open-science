import type { ProjectFilesChangedEvent } from '../../shared/project-files'
import type { ProjectFileSource } from '../../shared/project-files'
import type {
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../../shared/session-persistence'
import type { ManagedFileSoftDeleteToken } from '../project-files/repository'

type SessionMutationRepository = {
  loadAllWithDiagnostics(): Promise<{
    result: LoadAllSessionsResult
    isComplete: boolean
  }>
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

// Serializes authoritative session JSON and derived file-index mutations through one queue. This is
// the consistency boundary that prevents a late save from racing or reviving a durable deletion.
class SessionPersistenceCoordinator {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly deletedSessions = new Set<string>()
  private readonly deletedProjects = new Set<string>()

  constructor(
    private readonly repository: SessionMutationRepository,
    private readonly fileIndex: SessionFileIndex,
    private readonly onFilesChanged?: (event: ProjectFilesChangedEvent) => void
  ) {}

  /**
   * Loads durable sessions and opportunistically backfills their file projection.
   *
   * Chat hydration remains available when indexing fails. Reconciliation only runs after a complete
   * directory scan, then a cheap second revision pass lets collision losers claim rows released by
   * reconciliation in the same startup cycle.
   */
  loadAll(): Promise<LoadAllSessionsResult> {
    return this.enqueue(async () => {
      const scan = await this.repository.loadAllWithDiagnostics()

      for (const session of scan.result.sessions) {
        await this.fileIndex.syncSession(session).catch(() => undefined)
      }

      if (scan.isComplete) {
        let reconciliationSucceeded = false
        try {
          await this.fileIndex.reconcileActiveSessions(scan.result.sessions)
          reconciliationSucceeded = true
        } catch {
          // The repository records the global incomplete marker.
        }

        if (reconciliationSucceeded) {
          // Reconciliation can soft-delete a missing collision owner. A cheap second revision pass
          // lets a retry-sentinel loser claim that file during the same startup.
          for (const session of scan.result.sessions) {
            await this.fileIndex.syncSession(session).catch(() => undefined)
          }
        }
      } else {
        this.fileIndex.markReconciliationIncomplete()
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

      await this.repository.saveSession(session)
      let changedSources: ProjectFileSource[]
      try {
        changedSources = await this.fileIndex.syncSession(session)
      } catch (error) {
        // The JSON is already durable. Tell open Files views to surface the incomplete projection,
        // then preserve the rejection so the normal persistence retry path remains active.
        this.onFilesChanged?.({
          projectId: session.projectId,
          sources: ['artifact', 'upload'],
          kind: 'reset'
        })
        throw error
      }
      if (changedSources.length > 0) {
        this.onFilesChanged?.({
          projectId: session.projectId,
          sessionId: session.id,
          sources: changedSources,
          kind: 'upsert'
        })
      }
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
        } finally {
          this.deletedProjects.delete(projectId)
        }
        throw error
      }

      this.onFilesChanged?.({
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
        this.onFilesChanged?.({
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
      this.onFilesChanged?.({
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

      try {
        token = await this.fileIndex.softDeleteSession(projectId, sessionId)
        await this.repository.deleteSession(projectId, sessionId)
      } catch (error) {
        try {
          if (token) await this.fileIndex.restoreSession(projectId, sessionId, token)
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
        } else {
          this.fileIndex.markReconciliationIncomplete()
        }
      } catch {
        this.fileIndex.markReconciliationIncomplete()
      }

      for (const change of survivorChanges) {
        this.onFilesChanged?.({
          projectId,
          sessionId: change.sessionId,
          sources: change.sources,
          kind: 'upsert'
        })
      }

      this.onFilesChanged?.({
        projectId,
        sessionId,
        sources: ['artifact', 'upload'],
        kind: 'delete'
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
}

const sessionKey = (projectId: string, sessionId: string): string => `${projectId}:${sessionId}`

export { SessionPersistenceCoordinator }
export type { SessionFileIndex, SessionMutationRepository }
