import type { Project } from '../../shared/projects'

type ProjectDeletionRepository = {
  get(id: string): Promise<Project | null>
  delete(id: string): Promise<void>
  createDeletionIntent(projectId: string): Promise<void>
  deleteDeletionIntent(projectId: string): Promise<void>
  listDeletionIntents(): Promise<string[]>
}

type ProjectSessionDeletion = {
  deleteProjectSessions(projectId: string): Promise<void>
}

type PreviewDeletion = {
  delete(projectId: string): Promise<void>
}

type ProjectReviewDeletion = {
  deleteReviewsForProject(projectId: string): Promise<void>
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
    private readonly reviews?: ProjectReviewDeletion
  ) {}

  // Enqueues before yielding so two callers in the same event-loop turn cannot publish competing
  // recovery promises. The queue tail swallows failures only to keep later recovery work runnable.
  deleteProject(projectId: string): Promise<void> {
    const deletion = this.operationQueue.then(async () => {
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
    this.operationQueue = deletion.catch(() => undefined)
    return deletion
  }

  // Every read/recovery gate waits for the full deletion queue that existed when it was called.
  // Newly requested deletions enqueue synchronously, so later callers cannot bypass active work.
  async recoverPendingDeletions(): Promise<void> {
    await this.operationQueue
    return this.recoverPendingDeletionsNow()
  }

  // Deduplicates concurrent intent scans. Completion remains sticky until queued deletion work starts,
  // avoiding a database scan on every ordinary project, session, or Files request.
  private async recoverPendingDeletionsNow(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise
    if (this.isRecoveryComplete) return

    const recovery = this.runPendingDeletionRecovery()
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

    await this.projects.createDeletionIntent(projectId)
    try {
      await this.sessions.deleteProjectSessions(projectId)
    } catch (error) {
      await this.projects.deleteDeletionIntent(projectId)
      throw error
    }

    await this.finishDeletion(projectId)
  }

  // Replays intents serially so crash recovery follows the same ordering as an online deletion.
  private async runPendingDeletionRecovery(): Promise<void> {
    const projectIds = await this.projects.listDeletionIntents()
    for (const projectId of projectIds) {
      await this.sessions.deleteProjectSessions(projectId)
      await this.finishDeletion(projectId)
    }
  }

  // The project row is removed only after session/index deletion succeeds; deleting the intent last
  // makes this tail idempotent if the app crashes between either statement.
  private async finishDeletion(projectId: string): Promise<void> {
    if (await this.projects.get(projectId)) await this.projects.delete(projectId)

    // Preview state is derived UI state; a cleanup failure must not resurrect deleted chat data.
    await this.preview.delete(projectId).catch(() => undefined)

    // Reviews are derived project data. Keeping this after the project/session commit makes normal
    // deletion and crash recovery remove the same orphan rows without risking review loss on failure.
    await this.reviews?.deleteReviewsForProject(projectId).catch(() => undefined)

    // Keep the intent until all derived cleanup has been attempted so a crash replays the full tail.
    await this.projects.deleteDeletionIntent(projectId)
  }
}

export { ProjectDeletionCoordinator }
export type {
  PreviewDeletion,
  ProjectDeletionRepository,
  ProjectReviewDeletion,
  ProjectSessionDeletion
}
