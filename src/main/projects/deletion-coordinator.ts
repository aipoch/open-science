import type { Project } from '../../shared/projects'
import type { ProjectSessionDeletionResult } from '../session-persistence/coordinator'
import type { ProjectSessionDeletionState } from '../session-persistence/repository'
import { withDataRootWrite } from '../storage/migration-state'

type ProjectDeletionRepository = {
  get(id: string): Promise<Project | null>
  delete(id: string): Promise<void>
  createDeletionIntent(projectId: string): Promise<void>
  deleteDeletionIntent(projectId: string): Promise<void>
  listDeletionIntents(): Promise<string[]>
}

type ProjectSessionDeletion = {
  // This capability is intentionally wired only into the durable whole-Project intent coordinator;
  // ordinary Session IPC must use the strict per-Session deletion path instead.
  deleteProjectSessions(
    projectId: string,
    options?: { requireExistingUploadAuthority?: boolean }
  ): Promise<ProjectSessionDeletionResult>
  getProjectSessionDeletionState(projectId: string): Promise<ProjectSessionDeletionState>
  completeProjectSessionDeletion(projectId: string): Promise<void>
  listLegacyProjectSessionTombstones(): Promise<string[]>
}

type PreviewDeletion = {
  delete(projectId: string): Promise<void>
}

type ProjectReviewDeletion = {
  deleteReviewsForProject(projectId: string): Promise<void>
}

type ProjectProvenanceDeletion = {
  deleteProjectProvenance(projectId: string): Promise<void>
}

type ProjectPermissionGrantDeletion = {
  prune(owner: { kind: 'project'; projectId: string }): Promise<unknown>
  finalizeOwnerDeletion?(owner: { kind: 'project'; projectId: string }): Promise<void>
}

type ProjectDeletionLifecycle = {
  beforeProjectDelete(projectId: string): Promise<void>
}

// Persists deletion intent so a crash cannot strand an absent project with active session data. The
// same sticky recovery gate is shared by project CRUD, session persistence, and Files queries.
class ProjectDeletionCoordinator {
  private operationQueue: Promise<void> = Promise.resolve()
  private recoveryPromise: Promise<void> | undefined
  private isRecoveryComplete = false

  constructor(
    private readonly projects: ProjectDeletionRepository,
    private readonly sessions: ProjectSessionDeletion,
    private readonly preview: PreviewDeletion,
    private readonly reviews?: ProjectReviewDeletion,
    private readonly provenance?: ProjectProvenanceDeletion,
    private readonly permissionGrants?: ProjectPermissionGrantDeletion,
    private readonly lifecycle?: ProjectDeletionLifecycle
  ) {}

  // Enqueues before yielding so two callers in the same event-loop turn cannot publish competing
  // recovery promises. The queue tail swallows failures only to keep later recovery work runnable.
  deleteProject(projectId: string): Promise<void> {
    const deletion = this.operationQueue.then(() =>
      withDataRootWrite(async () => {
        await this.recoverPendingDeletionsNow()
        this.isRecoveryComplete = false
        try {
          await this.runDeletion(projectId)
          this.isRecoveryComplete = true
        } catch (error) {
          this.isRecoveryComplete = false
          throw error
        }
      })
    )
    this.operationQueue = deletion.catch(() => undefined)
    return deletion
  }

  // Every read/recovery gate waits for the full deletion queue that existed when it was called.
  // Newly requested deletions enqueue synchronously, so later callers cannot bypass active work.
  async recoverPendingDeletions(): Promise<void> {
    await this.operationQueue
    return withDataRootWrite(() => this.recoverPendingDeletionsNow())
  }

  // Deduplicates concurrent intent scans. Completion remains sticky until queued deletion work starts,
  // avoiding a database scan on every ordinary project, session, or Files request.
  private async recoverPendingDeletionsNow(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise
    if (this.isRecoveryComplete) return

    const recovery = this.runPendingDeletionRecovery().then((retainedProjectIds) =>
      this.adoptLegacyProjectSessionTombstones(retainedProjectIds)
    )
    this.recoveryPromise = recovery
    try {
      await recovery
      this.isRecoveryComplete = true
    } catch (error) {
      this.isRecoveryComplete = false
      throw error
    } finally {
      if (this.recoveryPromise === recovery) this.recoveryPromise = undefined
    }
  }

  // The intent is durable before session/index deletion starts. If that reversible phase fails, the
  // intent is removed because the project record is still authoritative and visible.
  private async runDeletion(projectId: string): Promise<void> {
    const project = await this.projects.get(projectId)
    if (!project) return

    await this.lifecycle?.beforeProjectDelete(projectId)
    await this.projects.createDeletionIntent(projectId)
    try {
      await this.sessions.deleteProjectSessions(projectId)
    } catch (error) {
      try {
        const state = await this.sessions.getProjectSessionDeletionState(projectId)
        if (state === 'live' || state === 'absent') {
          await this.projects.deleteDeletionIntent(projectId)
        }
      } catch {
        // Unknown durable Session state is fail-closed; retain the intent for recovery.
      }
      throw error
    }

    await this.finishDeletion(projectId)
  }

  // Replays intents serially so crash recovery follows the same ordering as an online deletion.
  private async runPendingDeletionRecovery(): Promise<Set<string>> {
    const projectIds = await this.projects.listDeletionIntents()
    const retainedProjectIds = new Set<string>()
    for (const projectId of projectIds) {
      let result: ProjectSessionDeletionResult
      try {
        // An absent Project plus an unmarked tombstone identifies a cross-version orphan adoption.
        // Re-derive its conservative policy from durable state so a crash immediately after intent
        // creation cannot turn the next retry into authority-creating normal deletion.
        const requireExistingUploadAuthority =
          !(await this.projects.get(projectId)) &&
          (await this.sessions.getProjectSessionDeletionState(projectId)) === 'legacy-committed'
        if (requireExistingUploadAuthority) {
          result = await this.sessions.deleteProjectSessions(projectId, {
            requireExistingUploadAuthority: true
          })
        } else {
          result = await this.sessions.deleteProjectSessions(projectId)
        }
      } catch (error) {
        // A visible Project row is insufficient evidence of a pre-commit failure: a crash may occur
        // after the atomic Session rename but before deleting that row. Clear the intent only when
        // the durable tombstone positively proves the Session phase never committed. Unknown marker
        // state and committed state both retain the intent and retry the irreversible tail.
        let sessionState: ProjectSessionDeletionState
        try {
          sessionState = await this.sessions.getProjectSessionDeletionState(projectId)
        } catch {
          throw error
        }
        if (sessionState === 'live' && (await this.projects.get(projectId))) {
          await this.projects.deleteDeletionIntent(projectId)
          continue
        }
        throw error
      }
      if (result.status === 'orphan-retained') {
        await this.projects.deleteDeletionIntent(projectId)
        retainedProjectIds.add(projectId)
        continue
      }
      await this.finishDeletion(projectId)
    }
    return retainedProjectIds
  }

  // Older releases could remove the Project row and intent before their best-effort physical
  // tombstone cleanup. Adopt every surviving unmarked tombstone into the durable intent protocol
  // before its Session migration can write a prepared marker or create new Version authority.
  private async adoptLegacyProjectSessionTombstones(
    retainedProjectIds: ReadonlySet<string>
  ): Promise<void> {
    const projectIds = await this.sessions.listLegacyProjectSessionTombstones()
    for (const projectId of projectIds) {
      if (retainedProjectIds.has(projectId)) continue
      await this.projects.createDeletionIntent(projectId)
      const result = await this.sessions.deleteProjectSessions(projectId, {
        requireExistingUploadAuthority: true
      })
      if (result.status === 'orphan-retained') {
        await this.projects.deleteDeletionIntent(projectId)
        continue
      }
      await this.finishDeletion(projectId)
    }
  }

  // The Project row is removed only after every fallible authority cleanup succeeds. Keeping both
  // the row and deletion intent through Permission Grant pruning lets the renderer contract report
  // the failure without publishing a false success; replaying this tail is idempotent.
  private async finishDeletion(projectId: string): Promise<void> {
    // Prune is transactional and idempotent. Run it before the hard delete so a Registry/database
    // failure retains the visible Project plus its durable intent for an explicit or startup retry.
    await this.permissionGrants?.prune({ kind: 'project', projectId })
    if (await this.projects.get(projectId)) await this.projects.delete(projectId)
    // The Project FK cascade commits outside the Registry mutation queue. A remember/restore that
    // was already in flight may have updated its cache around that commit, so enqueue one non-failing
    // cache barrier after the hard delete. Later mutations fail owner-liveness validation.
    await this.permissionGrants
      ?.finalizeOwnerDeletion?.({ kind: 'project', projectId })
      .catch(() => undefined)

    // Preview state is derived UI state; a cleanup failure must not resurrect deleted chat data.
    await this.preview.delete(projectId).catch(() => undefined)

    // Reviews are derived project data. Keeping this after the project/session commit makes normal
    // deletion and crash recovery remove the same orphan rows without risking review loss on failure.
    await this.reviews?.deleteReviewsForProject(projectId).catch(() => undefined)

    // Session deletion retains provenance, but Project deletion is terminal. This tail is replayed
    // from the durable intent after a crash, so both SQLite rows and immutable bytes are eventually
    // removed even if the Project row is already gone.
    await this.provenance?.deleteProjectProvenance(projectId)

    // The marked Session tombstone is the durable phase boundary. Remove it only after every Project
    // tail has completed, and keep the intent if physical cleanup fails so recovery retries it.
    await this.sessions.completeProjectSessionDeletion(projectId)

    // Keep the intent until all derived and tombstone cleanup has completed.
    await this.projects.deleteDeletionIntent(projectId)
  }
}

export { ProjectDeletionCoordinator }
export type {
  PreviewDeletion,
  ProjectDeletionRepository,
  ProjectReviewDeletion,
  ProjectProvenanceDeletion,
  ProjectPermissionGrantDeletion,
  ProjectDeletionLifecycle,
  ProjectSessionDeletion
}
