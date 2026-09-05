import type { Project, UpdateProjectArchiveRequest } from '../../shared/projects'
import type {
  PersistedChatSession,
  UpdateSessionArchiveRequest
} from '../../shared/session-persistence'
import { ArchiveAvailabilityError } from './availability-error'

type ProjectArchiveRepository = {
  get(id: string): Promise<Project | null>
  updateArchive(request: UpdateProjectArchiveRequest, archivedAt: number): Promise<Project>
}

type SessionArchivePersistence = {
  assertProjectArchivable(
    projectId: string,
    isRuntimeBusy: (sessionId: string) => boolean
  ): Promise<string[]>
  assertSessionAvailable(projectId: string, sessionId: string): Promise<void>
  sessionProjectId(sessionId: string): Promise<string | undefined>
  updateArchive(
    request: UpdateSessionArchiveRequest,
    isRuntimeBusy: () => boolean
  ): Promise<PersistedChatSession>
}

type SessionRuntimeActivity = {
  isSessionBusy(projectId: string, sessionId: string): boolean
  isProjectBusy(projectId: string): boolean | Promise<boolean>
  liveSessionProjectId(sessionId: string): string | undefined
}

// This is intentionally a narrow in-process gate, not a generic locking service. It makes an
// archive/restore decision and the final runtime admission observe one consistent active state.
// Prompt execution stays outside it; Task resume holds it only until the Session is durably running.
class ArchiveCoordinator {
  private readonly projectQueues = new Map<string, Promise<void>>()
  private markReadSessions: (sessionIds: string[]) => Promise<void> = async () => undefined
  private readonly deletingProjectIds = new Set<string>()

  constructor(
    private readonly projects: ProjectArchiveRepository,
    private readonly sessions: SessionArchivePersistence,
    private readonly runtime: SessionRuntimeActivity
  ) {}

  private enqueue<Result>(projectId: string, operation: () => Promise<Result>): Promise<Result> {
    const currentQueue = this.projectQueues.get(projectId) ?? Promise.resolve()
    const result = currentQueue.then(operation, operation)
    const nextQueue = result.then(
      () => undefined,
      () => undefined
    )
    this.projectQueues.set(projectId, nextQueue)
    void nextQueue.then(() => {
      if (this.projectQueues.get(projectId) === nextQueue) {
        this.projectQueues.delete(projectId)
      }
    })
    return result
  }

  private async activeProject(projectId: string): Promise<Project> {
    this.assertProjectDeletionAvailable(projectId)
    const project = await this.projects.get(projectId)
    this.assertProjectDeletionAvailable(projectId)
    if (!project) throw new Error('Project not found.')
    if (project.archivedAt !== undefined) {
      throw new ArchiveAvailabilityError('project-archived')
    }
    return project
  }

  updateProjectArchive(request: UpdateProjectArchiveRequest): Promise<Project> {
    return this.enqueue(request.id, async () => {
      this.assertProjectDeletionAvailable(request.id)
      const project = await this.projects.get(request.id)
      if (!project) throw new Error('Project not found.')
      const currentArchivedAt = project.archivedAt ?? null
      if (currentArchivedAt !== request.expectedArchivedAt) {
        throw new Error('Project archive state changed elsewhere.')
      }
      if (request.archived === (currentArchivedAt !== null)) return project

      if (request.archived && (await this.runtime.isProjectBusy(request.id))) {
        throw new Error('Finish or stop active sessions before archiving this project.')
      }
      const sessionIds = request.archived
        ? await this.sessions.assertProjectArchivable(request.id, (sessionId) =>
            this.runtime.isSessionBusy(request.id, sessionId)
          )
        : []
      const next = await this.projects.updateArchive(request, Date.now())
      if (request.archived) {
        // Read state is an attention projection, not archive authority. A transient badge/database
        // failure must not roll back the durable archive transition.
        await this.markReadSessions(sessionIds).catch(() => undefined)
      }
      return next
    })
  }

  updateSessionArchive(request: UpdateSessionArchiveRequest): Promise<PersistedChatSession> {
    return this.enqueue(request.projectId, async () => {
      await this.activeProject(request.projectId)
      const session = await this.sessions.updateArchive(request, () =>
        this.runtime.isSessionBusy(request.projectId, request.sessionId)
      )
      if (request.archived) await this.markReadSessions([request.sessionId]).catch(() => undefined)
      return session
    })
  }

  setMarkReadSessions(handler: (sessionIds: string[]) => Promise<void>): void {
    this.markReadSessions = handler
  }

  assertProjectAvailable(projectId: string | undefined): Promise<void> {
    if (!projectId) return Promise.resolve()
    return this.enqueue(projectId, async () => {
      await this.activeProject(projectId)
    })
  }

  withProjectAvailable<Result>(
    projectId: string | undefined,
    operation: () => Promise<Result>
  ): Promise<Result> {
    if (!projectId) return operation()
    return this.enqueue(projectId, async () => {
      await this.activeProject(projectId)
      return operation()
    })
  }

  withProjectDeletion<Result>(
    projectId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    return this.enqueue(projectId, async () => {
      // ProjectDeletionIntent is durable before this boundary. Re-entry is a recovery retry, and a
      // failed teardown must retain the fence until the coordinator completes or explicitly aborts.
      this.deletingProjectIds.add(projectId)
      return operation()
    })
  }

  withProjectDeletionAdmission<Result>(
    projectId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    // Parent-message delivery holds this short lifecycle through validation, optional resume, and
    // provider acceptance so Project deletion cannot snapshot ACP ownership in the middle.
    return this.enqueue(projectId, async () => {
      this.assertProjectDeletionAvailable(projectId)
      return operation()
    })
  }

  restoreProjectDeletion(projectId: string): void {
    this.deletingProjectIds.add(projectId)
  }

  releaseProjectDeletion(projectId: string): void {
    this.deletingProjectIds.delete(projectId)
  }

  assertSessionAvailable(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(projectId, () => this.assertSessionAvailableNow(projectId, sessionId))
  }

  withSessionAvailable<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    return this.enqueue(projectId, async () => {
      await this.assertSessionAvailableNow(projectId, sessionId)
      return operation()
    })
  }

  assertSessionAvailableById(sessionId: string): Promise<void> {
    return this.resolveSessionProjectId(sessionId).then((projectId) => {
      if (!projectId) {
        throw new Error('Cannot use a Session whose Project owner is unavailable.')
      }
      return this.enqueue(projectId, async () => {
        await this.assertSessionAvailableByIdNow(sessionId, projectId)
      })
    })
  }

  withSessionAvailableById<Result>(
    sessionId: string,
    operation: (projectId: string) => Promise<Result>
  ): Promise<Result> {
    return this.resolveSessionProjectId(sessionId).then((projectId) => {
      if (!projectId) {
        throw new Error('Cannot use a Session whose Project owner is unavailable.')
      }
      return this.enqueue(projectId, async () => {
        await this.assertSessionAvailableByIdNow(sessionId, projectId)
        return operation(projectId)
      })
    })
  }

  withSessionDeletionAdmissionById<Result>(
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const admitted = this.resolveSessionProjectId(sessionId).then((projectId) => {
      if (!projectId) return { result: operation() }
      return this.enqueue(projectId, async () => {
        this.assertProjectDeletionAvailable(projectId)
        return { result: operation() }
      })
    })
    return admitted.then(({ result }) => result)
  }

  isSessionAvailableById(sessionId: string): Promise<boolean> {
    return this.assertSessionAvailableById(sessionId).then(
      () => true,
      () => false
    )
  }

  private async assertSessionAvailableNow(projectId: string, sessionId: string): Promise<void> {
    const ownerProjectId =
      (await this.sessions.sessionProjectId(sessionId)) ??
      this.runtime.liveSessionProjectId(sessionId)
    if (!ownerProjectId) {
      throw new Error('Cannot use a Session whose Project owner is unavailable.')
    }
    if (ownerProjectId !== projectId) {
      throw new Error('Session does not belong to the requested Project.')
    }
    await this.activeProject(ownerProjectId)
    await this.sessions.assertSessionAvailable(ownerProjectId, sessionId)
  }

  private async assertSessionAvailableByIdNow(sessionId: string, projectId: string): Promise<void> {
    await this.activeProject(projectId)
    await this.sessions.assertSessionAvailable(projectId, sessionId)
  }

  private async resolveSessionProjectId(sessionId: string): Promise<string | undefined> {
    return (
      (await this.sessions.sessionProjectId(sessionId)) ??
      this.runtime.liveSessionProjectId(sessionId)
    )
  }

  private assertProjectDeletionAvailable(projectId: string): void {
    if (this.deletingProjectIds.has(projectId)) {
      throw new Error('Project is being deleted.')
    }
  }
}

export { ArchiveCoordinator }
export type { ProjectArchiveRepository, SessionArchivePersistence, SessionRuntimeActivity }
