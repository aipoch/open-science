import type { Project, UpdateProjectArchiveRequest } from '../../shared/projects'
import type {
  PersistedChatSession,
  UpdateSessionArchiveRequest
} from '../../shared/session-persistence'
import {
  ArchiveAvailabilityError,
  SessionExportBlockedError,
  type SessionExportBlocker
} from './availability-error'

type ProjectArchiveRepository = {
  get(id: string): Promise<Project | null>
  updateArchive(request: UpdateProjectArchiveRequest, archivedAt: number): Promise<Project>
}

type SessionArchivePersistence = {
  assertProjectArchivable(
    projectId: string,
    isRuntimeBusy: (sessionId: string) => boolean | Promise<boolean>
  ): Promise<string[]>
  assertSessionAvailable(projectId: string, sessionId: string): Promise<void>
  sessionProjectId(sessionId: string): Promise<string | undefined>
  updateArchive(
    request: UpdateSessionArchiveRequest,
    isRuntimeBusy: () => boolean | Promise<boolean>
  ): Promise<PersistedChatSession>
}

type SessionRuntimeActivity = {
  isSessionBusy(projectId: string, sessionId: string): boolean | Promise<boolean>
  isSessionLocallyBusy?(projectId: string, sessionId: string): boolean | Promise<boolean>
  getSessionExportBlocker?(
    projectId: string,
    sessionId: string
  ): Promise<SessionExportBlocker | undefined>
  isProjectBusy(projectId: string): boolean | Promise<boolean>
  liveSessionProjectId(sessionId: string): string | undefined
}

// This is intentionally a narrow in-process gate, not a generic locking service. It makes an
// archive/restore decision and the final runtime admission observe one consistent active state.
// Prompt execution stays outside it; Task resume holds it only until the Session is durably running.
class ArchiveCoordinator {
  // Notebook reclamation needs local work and admission, independent of Compute-owned jobs.
  // Older compositions retain the conservative archive check until they supply this projection.
  async isSessionLocallyBusy(projectId: string, sessionId: string): Promise<boolean> {
    if (this.pendingDispatches.has(sessionId)) return true
    const check = this.runtime.isSessionLocallyBusy ?? this.runtime.isSessionBusy
    const busy = await check.call(this.runtime, projectId, sessionId)
    return busy || this.pendingDispatches.has(sessionId)
  }

  async isSessionBusy(projectId: string, sessionId: string): Promise<boolean> {
    if (this.pendingDispatches.has(sessionId)) return true
    const busy = await this.runtime.isSessionBusy(projectId, sessionId)
    return busy || this.pendingDispatches.has(sessionId)
  }

  private readonly projectQueues = new Map<string, Promise<void>>()
  private markReadSessions: (sessionIds: string[]) => Promise<void> = async () => undefined
  private readonly deletingProjectIds = new Set<string>()
  private readonly exportingSessions = new Map<string, string>()
  private readonly deletingSessionRecoveryFiles = new Set<string>()
  private readonly importingProjects = new Set<string>()
  private readonly pendingDispatches = new Map<
    string,
    {
      projectId: string
      count: number
      userPrompts: number
      observations: number
      drained?: AbortController
    }
  >()

  // Independent execution owners hold this synchronous admission through their asynchronous
  // startup/cleanup. Export observes both pending work and already-published runtime activity.
  admitSessionWork(
    projectId: string,
    sessionId: string,
    kind: 'work' | 'user-prompt' | 'observation' = 'work'
  ): () => void {
    this.assertProjectDeletionAvailable(projectId)
    this.assertExportAvailable(sessionId)
    const pending = this.pendingDispatches.get(sessionId) ?? {
      projectId,
      count: 0,
      userPrompts: 0,
      observations: 0
    }
    pending.count += 1
    if (kind === 'user-prompt') pending.userPrompts += 1
    if (kind === 'observation') pending.observations += 1
    this.pendingDispatches.set(sessionId, pending)
    let released = false
    return () => {
      if (released) return
      released = true
      pending.count -= 1
      if (kind === 'user-prompt') pending.userPrompts -= 1
      if (kind === 'observation') pending.observations -= 1
      if (!pending.count) {
        this.pendingDispatches.delete(sessionId)
        pending.drained?.abort()
      }
    }
  }

  isSessionExporting(projectId: string, sessionId: string): boolean {
    return this.exportingSessions.get(sessionId) === projectId
  }

  withSessionRecoveryDeletion<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    return this.enqueue(projectId, async () => {
      this.assertProjectDeletionAvailable(projectId)
      this.assertExportAvailable(sessionId)
      if (this.pendingDispatches.has(sessionId))
        throw new Error('Wait for Session work to finish before deleting recovery files.')
      // Share the synchronous work-admission fence with Compute and Notebook submissions.
      // The damaged Session cannot pass readable-Session admission, so check runtime activity here.
      this.deletingSessionRecoveryFiles.add(sessionId)
      try {
        if (await this.runtime.isSessionBusy(projectId, sessionId))
          throw new Error('Wait for Session work to finish before deleting recovery files.')
        return await operation()
      } finally {
        this.deletingSessionRecoveryFiles.delete(sessionId)
      }
    })
  }

  reserveProjectImport(projectId: string, signal?: AbortSignal): Promise<() => void> {
    return this.enqueue(
      projectId,
      async () => {
        await this.activeProject(projectId)
        if (this.importingProjects.has(projectId))
          throw new Error('A project import is already in progress.')
        this.importingProjects.add(projectId)
        return () => {
          this.importingProjects.delete(projectId)
        }
      },
      signal
    )
  }

  async reserveSessionExport(
    projectId: string,
    sessionId: string,
    assertIdle: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<() => void> {
    const assertRuntimeIdle = async (): Promise<void> => {
      const blocker = this.runtime.getSessionExportBlocker
        ? await this.runtime.getSessionExportBlocker(projectId, sessionId)
        : (await this.runtime.isSessionBusy(projectId, sessionId))
          ? 'pending'
          : undefined
      if (blocker) throw new SessionExportBlockedError(blocker)
    }
    const prepare = async (): Promise<void> => {
      await assertRuntimeIdle()
      await assertIdle()
      await assertRuntimeIdle()
    }
    let reserved = false
    const release = (): void => {
      if (reserved) this.exportingSessions.delete(sessionId)
      reserved = false
    }
    try {
      const drained = await this.enqueue(
        projectId,
        async () => {
          await this.activeProject(projectId)
          this.assertExportAvailable(sessionId)
          let pending = this.pendingDispatches.get(sessionId)
          if (pending && pending.count > pending.observations) {
            await assertRuntimeIdle()
            pending = this.pendingDispatches.get(sessionId)
            if (pending && pending.count > pending.observations)
              throw new SessionExportBlockedError(pending.userPrompts ? 'agent' : 'pending')
          }
          // Fence new work and refreshes before yielding. An already-admitted history read
          // can reconcile durable state and must finish before we freeze persistence.
          this.exportingSessions.set(sessionId, projectId)
          reserved = true
          if (pending) {
            pending.drained = new AbortController()
            await assertRuntimeIdle()
            return pending.drained.signal
          }
          await prepare()
          return undefined
        },
        signal
      )
      if (drained) {
        // The reader can finish work that needs the project queue.
        const changed = signal ? AbortSignal.any([drained, signal]) : drained
        if (!changed.aborted)
          await new Promise<void>((resolve) =>
            changed.addEventListener('abort', () => resolve(), { once: true })
          )
        await this.enqueue(projectId, prepare, signal)
      }
      signal?.throwIfAborted()
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  private assertExportAvailable(sessionId: string): void {
    if (this.deletingSessionRecoveryFiles.has(sessionId))
      throw new Error('This Session is locked while its recovery files are being deleted.')
    if (this.exportingSessions.has(sessionId))
      throw new Error('This Session is locked while its research package is being exported.')
  }

  private assertProjectExportAvailable(projectId: string): void {
    if (this.importingProjects.has(projectId))
      throw new Error(
        'Wait for the research package import to finish before changing this Project.'
      )
    if ([...this.exportingSessions.values()].includes(projectId))
      throw new Error(
        'Wait for the research package export to finish before changing this Project.'
      )
  }

  constructor(
    private readonly projects: ProjectArchiveRepository,
    private readonly sessions: SessionArchivePersistence,
    private readonly runtime: SessionRuntimeActivity,
    private readonly backgroundWork?: {
      cancelProject(projectId: string): Promise<void>
      cancelSession(projectId: string, sessionId: string): Promise<void>
    }
  ) {}

  private enqueue<Result>(
    projectId: string,
    operation: () => Promise<Result>,
    signal?: AbortSignal
  ): Promise<Result> {
    const currentQueue = this.projectQueues.get(projectId) ?? Promise.resolve()
    // Cancelling a waiter must not advance the project queue or start its operation later.
    const ready = signal
      ? new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(signal.reason)
          if (signal.aborted) {
            abort()
            return
          }
          signal.addEventListener('abort', abort, { once: true })
          void currentQueue.finally(() => {
            signal.removeEventListener('abort', abort)
            resolve()
          })
        })
      : currentQueue
    const result = ready.then(() => {
      signal?.throwIfAborted()
      return operation()
    })
    const nextQueue = Promise.allSettled([currentQueue, result]).then(() => undefined)
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
      this.assertProjectExportAvailable(request.id)
      this.assertProjectDeletionAvailable(request.id)
      const project = await this.projects.get(request.id)
      if (!project) throw new Error('Project not found.')
      const currentArchivedAt = project.archivedAt ?? null
      if ((project.archiveRevision ?? 0) !== request.expectedArchiveRevision) {
        throw new Error('Project archive state changed elsewhere.')
      }
      if (request.archived === (currentArchivedAt !== null)) {
        if (request.archived) await this.backgroundWork?.cancelProject(request.id)
        return project
      }

      if (
        request.archived &&
        ([...this.pendingDispatches.values()].some(
          (pending) => pending.projectId === request.id && pending.userPrompts > 0
        ) ||
          (await this.runtime.isProjectBusy(request.id)))
      ) {
        throw new Error('Finish or stop active sessions before archiving this project.')
      }
      const sessionIds = request.archived
        ? await this.sessions.assertProjectArchivable(request.id, (sessionId) =>
            this.runtime.isSessionBusy(request.id, sessionId)
          )
        : []
      const next = await this.projects.updateArchive(request, Date.now())
      if (request.archived) {
        // Admission shares this queue, so no check can start between archive and drain.
        await this.backgroundWork?.cancelProject(request.id)
        // Read state is an attention projection, not archive authority. A transient badge/database
        // failure must not roll back the durable archive transition.
        await this.markReadSessions(sessionIds).catch(() => undefined)
      }
      return next
    })
  }

  updateSessionArchive(request: UpdateSessionArchiveRequest): Promise<PersistedChatSession> {
    return this.enqueue(request.projectId, async () => {
      this.assertExportAvailable(request.sessionId)
      await this.activeProject(request.projectId)
      const session = await this.sessions.updateArchive(
        request,
        () =>
          (this.pendingDispatches.get(request.sessionId)?.userPrompts ?? 0) > 0 ||
          this.runtime.isSessionBusy(request.projectId, request.sessionId)
      )
      if (request.archived) {
        await this.backgroundWork?.cancelSession(request.projectId, request.sessionId)
        await this.markReadSessions([request.sessionId]).catch(() => undefined)
      }
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
      this.assertProjectExportAvailable(projectId)
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
    this.assertProjectExportAvailable(projectId)
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

  async isSessionResourceReadable(projectId: string, sessionId: string): Promise<boolean> {
    try {
      const ownerProjectId =
        (await this.sessions.sessionProjectId(sessionId)) ??
        this.runtime.liveSessionProjectId(sessionId)
      if (ownerProjectId !== projectId) return false
      await this.activeProject(projectId)
      await this.sessions.assertSessionAvailable(projectId, sessionId)
      return true
    } catch {
      return false
    }
  }

  assertSessionResourceReleaseAvailable(projectId: string, sessionId: string): void {
    this.assertProjectDeletionAvailable(projectId)
    this.assertProjectExportAvailable(projectId)
    this.assertExportAvailable(sessionId)
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
    operation: () => Promise<Result>,
    requireAvailable = false
  ): Promise<Result> {
    const admitted = this.resolveSessionProjectId(sessionId).then((projectId) => {
      if (!projectId) {
        if (requireAvailable)
          throw new Error('Cannot use a Session whose Project owner is unavailable.')
        return { result: operation() }
      }
      return this.enqueue(projectId, async () => {
        // New user work and archive must agree on one active state, including asynchronous startup.
        // Application continuations retain deletion-only admission so existing cleanup can finish.
        if (requireAvailable) await this.assertSessionAvailableByIdNow(sessionId, projectId)
        const release = this.admitSessionWork(
          projectId,
          sessionId,
          requireAvailable ? 'user-prompt' : 'work'
        )
        const result = Promise.resolve().then(operation).finally(release)
        return { result }
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
    this.assertExportAvailable(sessionId)
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
    this.assertExportAvailable(sessionId)
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
