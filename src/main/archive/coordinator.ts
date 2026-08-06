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
}

// This is intentionally a narrow in-process gate, not a generic locking service. It makes an
// archive/restore decision and the final runtime admission observe one consistent active state;
// provider work and ordinary Session persistence stay outside it.
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
    return this.enqueue(async () => {
      const ownerProjectId = await this.sessions.sessionProjectId(sessionId)
      if (ownerProjectId && ownerProjectId !== projectId) {
        throw new Error('Session does not belong to the requested Project.')
      }
      // A missing owner is allowed only for an explicitly addressed transient runtime Session. Once
      // metadata exists, its durable owner is authoritative over caller-supplied project IDs.
      const resolvedProjectId = ownerProjectId ?? projectId
      await this.activeProject(resolvedProjectId)
      await this.sessions.assertSessionAvailable(resolvedProjectId, sessionId)
    })
  }

  assertSessionAvailableById(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const projectId = await this.sessions.sessionProjectId(sessionId)
      if (!projectId) return
      await this.activeProject(projectId)
      await this.sessions.assertSessionAvailable(projectId, sessionId)
    })
  }

  isSessionAvailableById(sessionId: string): Promise<boolean> {
    return this.assertSessionAvailableById(sessionId).then(
      () => true,
      () => false
    )
  }
}

export { ArchiveCoordinator }
export type { ProjectArchiveRepository, SessionArchivePersistence, SessionRuntimeActivity }
