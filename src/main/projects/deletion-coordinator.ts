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

// Persists deletion intent so a crash cannot strand an absent project with active session data. The
// same sticky recovery gate is shared by project CRUD, session persistence, and Files queries.
class ProjectDeletionCoordinator {
  private recoveryPromise: Promise<void> | undefined
  private isRecoveryComplete = false

  constructor(
    private readonly projects: ProjectDeletionRepository,
    private readonly sessions: ProjectSessionDeletion,
    private readonly preview: PreviewDeletion
  ) {}

  // Waits for older recovery work, publishes this deletion as the new gate, and keeps the gate
  // incomplete on failure so the next caller retries persisted intents instead of bypassing them.
  async deleteProject(projectId: string): Promise<void> {
    await this.recoverPendingDeletions()
    const deletion = this.runDeletion(projectId)
    this.isRecoveryComplete = false
    this.recoveryPromise = deletion

    try {
      await deletion
      this.isRecoveryComplete = true
    } catch (error) {
      this.isRecoveryComplete = false
      throw error
    } finally {
      if (this.recoveryPromise === deletion) this.recoveryPromise = undefined
    }
  }

  // Deduplicates concurrent startup/IPC recovery callers. Completion is sticky until a new deletion
  // begins, avoiding repeated intent scans on every ordinary query.
  async recoverPendingDeletions(): Promise<void> {
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
    await this.projects.deleteDeletionIntent(projectId)

    // Preview state is derived UI state; a cleanup failure must not resurrect deleted chat data.
    await this.preview.delete(projectId).catch(() => undefined)
  }
}

export { ProjectDeletionCoordinator }
export type { PreviewDeletion, ProjectDeletionRepository, ProjectSessionDeletion }
