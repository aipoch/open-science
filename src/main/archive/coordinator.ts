import type { Project, UpdateProjectArchiveRequest } from '../../shared/projects'
import type {
  PersistedChatSession,
  UpdateSessionArchiveRequest
} from '../../shared/session-persistence'

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
  isProjectBusy(projectId: string): boolean
  liveSessionProjectId(sessionId: string): string | undefined
}

// This is intentionally a narrow in-process gate, not a generic locking service. It makes an
// archive/restore decision and the final runtime admission observe one consistent active state.
// Prompt execution stays outside it; Task resume holds it only until the Session is durably running.
class ArchiveCoordinator {
  private queue: Promise<void> = Promise.resolve()
  private markReadSessions: (sessionIds: string[]) => Promise<void> = async () => undefined

  constructor(
    private readonly projects: ProjectArchiveRepository,
    private readonly sessions: SessionArchivePersistence,
    private readonly runtime: SessionRuntimeActivity
  ) {}

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async activeProject(projectId: string): Promise<Project> {
    const project = await this.projects.get(projectId)
    if (!project) throw new Error('Project not found.')
    if (project.archivedAt !== undefined) {
      throw new Error('Restore this archived Project before continuing.')
    }
    return project
  }

  updateProjectArchive(request: UpdateProjectArchiveRequest): Promise<Project> {
    return this.enqueue(async () => {
      const project = await this.projects.get(request.id)
      if (!project) throw new Error('Project not found.')
      const currentArchivedAt = project.archivedAt ?? null
      if (currentArchivedAt !== request.expectedArchivedAt) {
        throw new Error('Project archive state changed elsewhere.')
      }
      if (request.archived === (currentArchivedAt !== null)) return project

      if (request.archived && this.runtime.isProjectBusy(request.id)) {
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
    return this.enqueue(async () => {
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
    return this.enqueue(async () => {
      await this.activeProject(projectId)
    })
  }

  assertSessionAvailable(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => this.assertSessionAvailableNow(projectId, sessionId))
  }

  withSessionAvailable<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    // ponytail: reuse the global archive queue until measured resume contention justifies
    // partitioning it by Project.
    return this.enqueue(async () => {
      await this.assertSessionAvailableNow(projectId, sessionId)
      return operation()
    })
  }

  assertSessionAvailableById(sessionId: string): Promise<void> {
    return this.enqueue(() => this.assertSessionAvailableByIdNow(sessionId))
  }

  withSessionAvailableById<Result>(
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    return this.enqueue(async () => {
      await this.assertSessionAvailableByIdNow(sessionId)
      return operation()
    })
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

  private async assertSessionAvailableByIdNow(sessionId: string): Promise<void> {
    const projectId =
      (await this.sessions.sessionProjectId(sessionId)) ??
      this.runtime.liveSessionProjectId(sessionId)
    if (!projectId) {
      throw new Error('Cannot use a Session whose Project owner is unavailable.')
    }
    await this.activeProject(projectId)
    await this.sessions.assertSessionAvailable(projectId, sessionId)
  }
}

export { ArchiveCoordinator }
export type { ProjectArchiveRepository, SessionArchivePersistence, SessionRuntimeActivity }
