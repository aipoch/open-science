import { isCurrentInFlight } from '../../shared/in-flight-promise'
import type { Project } from '../../shared/projects'
import type { ProjectSessionDeletionResult } from '../session-persistence/coordinator'
import type { ProjectSessionDeletionState } from '../session-persistence/repository'
import { withDataRootWrite } from '../storage/migration-state'
import type { ApplicationEventPublisher } from '../application-events'
import type { ProjectDeletionResult } from './repository'

type ProjectDeletionRepository = {
  get(id: string): Promise<Project | null>
  delete(id: string): Promise<ProjectDeletionResult | undefined>
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
  restoreProjectDeletion?(projectId: string): Promise<void>
  finalizeProjectDeletion?(projectId: string): Promise<void>
  completeProjectDeletion?(projectId: string): void
  abortProjectDeletion?(projectId: string): Promise<void> | void
}

type ProjectDeletionRecoveryLoopOptions = {
  retryDelayMs?: number
  onError?: (error: unknown) => void
}

type ProjectDeletionFailure = {
  projectId: string
  error: unknown
}

class ProjectDeletionRecoveryError extends AggregateError {
  readonly failures: readonly ProjectDeletionFailure[]

  constructor(failures: readonly ProjectDeletionFailure[]) {
    const firstError = failures[0]?.error
    super(
      failures.map(({ error }) => error),
      firstError instanceof Error
        ? firstError.message
        : `Project deletion recovery failed: ${failures[0]?.projectId ?? 'unknown'}`
    )
    this.name = 'ProjectDeletionRecoveryError'
    this.failures = failures
  }

  affectsAny(projectIds: ReadonlySet<string>): boolean {
    return this.failures.some(({ projectId }) => projectIds.has(projectId))
  }
}

class ProjectDeletionRecoveryLoop {
  private readonly retryDelayMs: number
  private readonly onError: (error: unknown) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private running = false
  private activeRun: Promise<void> | undefined

  constructor(
    private readonly recover: () => Promise<void>,
    options: ProjectDeletionRecoveryLoopOptions = {}
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 30_000
    this.onError = options.onError ?? (() => undefined)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.run()
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.activeRun
  }

  private run(): void {
    if (!this.started || this.running) return
    this.running = true
    const activeRun = Promise.resolve()
      .then(() => this.recover())
      .then(
        () => {
          this.running = false
        },
        (error: unknown) => {
          this.running = false
          try {
            this.onError(error)
          } catch {
            // A diagnostic sink failure must not disable durable deletion recovery.
          }
          if (!this.started) return
          this.timer = setTimeout(() => {
            this.timer = undefined
            this.run()
          }, this.retryDelayMs)
        }
      )
    this.activeRun = activeRun
    void activeRun.then(() => {
      if (this.activeRun === activeRun) this.activeRun = undefined
    })
  }
}

// Persists deletion intent so a crash cannot strand an absent project with active session data. The
// the same recovery work is shared by project CRUD, session persistence, and Files queries. Strict
// recovery reports every failure for background retry; foreground Project/Files admission filters
// those failures by durable Project ownership.
class ProjectDeletionCoordinator {
  private operationQueue: Promise<void> = Promise.resolve()
  private recoveryPromise: Promise<void> | undefined
  private isRecoveryComplete = false

  constructor(
    private readonly projects: ProjectDeletionRepository,
    private readonly sessions: ProjectSessionDeletion,
    private readonly reviews?: ProjectReviewDeletion,
    private readonly provenance?: ProjectProvenanceDeletion,
    private readonly permissionGrants?: ProjectPermissionGrantDeletion,
    private readonly lifecycle?: ProjectDeletionLifecycle,
    private readonly events?: Pick<ApplicationEventPublisher, 'publish'>
  ) {}

  // Enqueues before yielding so two callers in the same event-loop turn cannot publish competing
  // recovery promises. The queue tail swallows failures only to keep later recovery work runnable.
  deleteProject(projectId: string): Promise<void> {
    const deletion = this.operationQueue.then(() =>
      withDataRootWrite(async () => {
        const recoveryComplete = await this.waitForProjectOperationsNow([projectId])
        this.isRecoveryComplete = false
        try {
          await this.runDeletion(projectId)
          // Preserve sticky completion only when scoped admission did not suppress failures owned by
          // other Projects. Suppressed durable intents must remain eligible for retry.
          this.isRecoveryComplete = recoveryComplete
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

  // Foreground operations still drive durable recovery, but a failed tail only denies access to the
  // Project(s) that own that intent. Infrastructure failures remain global because intent ownership
  // could not be established safely. An empty set represents Project list/create operations.
  async waitForProjectOperations(projectIds: readonly string[]): Promise<void> {
    await this.operationQueue
    await withDataRootWrite(() => this.waitForProjectOperationsNow(projectIds))
  }

  // Restores fail-closed in-memory barriers from local durable authority only. Startup waits for this
  // bounded phase, then remote cleanup is retried by ProjectDeletionRecoveryLoop after the app opens.
  async restorePendingDeletionBarriers(): Promise<void> {
    await this.operationQueue
    return withDataRootWrite(async () => {
      if (!this.lifecycle?.restoreProjectDeletion) return
      const projectIds = new Set(await this.projects.listDeletionIntents())
      for (const projectId of await this.sessions.listLegacyProjectSessionTombstones()) {
        projectIds.add(projectId)
      }
      for (const projectId of projectIds) {
        await this.lifecycle.restoreProjectDeletion(projectId)
      }
    })
  }

  // Deduplicates concurrent intent scans. Completion remains sticky until queued deletion work starts,
  // avoiding a database scan on every ordinary project, session, or Files request.
  private async recoverPendingDeletionsNow(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise
    if (this.isRecoveryComplete) return

    const recovery = this.recoverEveryPendingDeletion()
    this.recoveryPromise = recovery
    try {
      await recovery
      this.isRecoveryComplete = true
    } catch (error) {
      this.isRecoveryComplete = false
      throw error
    } finally {
      if (isCurrentInFlight(this.recoveryPromise, recovery)) this.recoveryPromise = undefined
    }
  }

  private async waitForProjectOperationsNow(projectIds: readonly string[]): Promise<boolean> {
    try {
      await this.recoverPendingDeletionsNow()
      return true
    } catch (error) {
      if (!(error instanceof ProjectDeletionRecoveryError)) throw error
      if (error.affectsAny(new Set(projectIds))) throw error
      return false
    }
  }

  private async recoverEveryPendingDeletion(): Promise<void> {
    const { projectIds, retainedProjectIds, failures } = await this.runPendingDeletionRecovery()
    failures.push(
      ...(await this.adoptLegacyProjectSessionTombstones(
        new Set([...projectIds, ...retainedProjectIds])
      ))
    )
    if (failures.length > 0) throw new ProjectDeletionRecoveryError(failures)
  }

  // Install the non-destructive admission fence before committing deletion intent, then persist
  // retry authority before any destructive runtime cleanup. Once the intent exists, every failure
  // remains fail-closed: the Project may still be visible, but recovery retains the fence and replays
  // quiescence before continuing durable deletion.
  private async runDeletion(projectId: string): Promise<void> {
    const project = await this.projects.get(projectId)
    if (!project) return

    await this.createDeletionIntentWithFence(projectId)
    await this.lifecycle?.beforeProjectDelete(projectId)
    await this.sessions.deleteProjectSessions(projectId)
    await this.finishDeletion(projectId)
  }

  private async createDeletionIntentWithFence(projectId: string): Promise<void> {
    try {
      await this.lifecycle?.restoreProjectDeletion?.(projectId)
      await this.projects.createDeletionIntent(projectId)
    } catch (error) {
      await this.lifecycle?.abortProjectDeletion?.(projectId)
      throw error
    }
  }

  private async prepareDeletion(projectId: string): Promise<void> {
    await this.lifecycle?.restoreProjectDeletion?.(projectId)
    await this.lifecycle?.beforeProjectDelete(projectId)
  }

  // Replays intents serially so crash recovery follows the same ordering as an online deletion.
  private async runPendingDeletionRecovery(): Promise<{
    projectIds: readonly string[]
    retainedProjectIds: Set<string>
    failures: ProjectDeletionFailure[]
  }> {
    const projectIds = await this.projects.listDeletionIntents()
    const retainedProjectIds = new Set<string>()
    const failures: ProjectDeletionFailure[] = []
    for (const projectId of projectIds) {
      try {
        await this.prepareDeletion(projectId)
        // An absent Project plus an unmarked tombstone identifies a cross-version orphan adoption.
        // Re-derive its conservative policy from durable state so a crash immediately after intent
        // creation cannot turn the next retry into authority-creating normal deletion. Any rejection
        // naturally retains the intent because runtime cleanup may already have removed resources.
        const requireExistingUploadAuthority =
          !(await this.projects.get(projectId)) &&
          (await this.sessions.getProjectSessionDeletionState(projectId)) === 'legacy-committed'
        const result: ProjectSessionDeletionResult = requireExistingUploadAuthority
          ? await this.sessions.deleteProjectSessions(projectId, {
              requireExistingUploadAuthority: true
            })
          : await this.sessions.deleteProjectSessions(projectId)
        if (result.status === 'orphan-retained') {
          await this.projects.deleteDeletionIntent(projectId)
          await this.lifecycle?.abortProjectDeletion?.(projectId)
          retainedProjectIds.add(projectId)
          continue
        }
        await this.finishDeletion(projectId)
      } catch (error) {
        failures.push({ projectId, error })
      }
    }
    return { projectIds, retainedProjectIds, failures }
  }

  // Older releases could remove the Project row and intent before their best-effort physical
  // tombstone cleanup. Adopt every surviving unmarked tombstone into the durable intent protocol
  // before its Session migration can write a prepared marker or create new Version authority.
  private async adoptLegacyProjectSessionTombstones(
    skippedProjectIds: ReadonlySet<string>
  ): Promise<ProjectDeletionFailure[]> {
    const projectIds = await this.sessions.listLegacyProjectSessionTombstones()
    const failures: ProjectDeletionFailure[] = []
    for (const projectId of projectIds) {
      if (skippedProjectIds.has(projectId)) continue
      try {
        await this.createDeletionIntentWithFence(projectId)
        await this.lifecycle?.beforeProjectDelete(projectId)
        const result = await this.sessions.deleteProjectSessions(projectId, {
          requireExistingUploadAuthority: true
        })
        if (result.status === 'orphan-retained') {
          await this.projects.deleteDeletionIntent(projectId)
          await this.lifecycle?.abortProjectDeletion?.(projectId)
          continue
        }
        await this.finishDeletion(projectId)
      } catch (error) {
        failures.push({ projectId, error })
      }
    }
    return failures
  }

  // The Project becomes an invisible metadata tombstone only after every fallible authority cleanup
  // succeeds. Keeping it active with the deletion intent through pruning lets the renderer report a
  // failure without publishing false success; replaying this tail is idempotent.
  private async finishDeletion(projectId: string): Promise<void> {
    // Prune is transactional and idempotent. Run it before the soft delete so a Registry/database
    // failure retains the visible Project plus its durable intent for an explicit or startup retry.
    await this.permissionGrants?.prune({ kind: 'project', projectId })
    const projectDeletion = (await this.projects.get(projectId))
      ? await this.projects.delete(projectId)
      : undefined
    if (projectDeletion) {
      this.events?.publish('memory:changed', { revision: projectDeletion.memoryRevision })
    }
    // The metadata tombstone commits outside the Registry mutation queue. A remember/restore already
    // in flight may have updated its cache around that commit, so enqueue one non-failing barrier.
    await this.permissionGrants
      ?.finalizeOwnerDeletion?.({ kind: 'project', projectId })
      .catch(() => undefined)

    // Retain the durable intent on failure so startup or an explicit retry can finish cleanup.
    try {
      await this.reviews?.deleteReviewsForProject(projectId)
    } catch (error) {
      throw new AggregateError([error], 'Project derived cleanup failed: ' + projectId)
    }

    // Session deletion retains provenance, but Project deletion is terminal. This tail is replayed
    // from the durable intent after a crash, so derived SQLite rows and immutable bytes are
    // eventually removed even after the Project metadata row has become an invisible tombstone.
    await this.provenance?.deleteProjectProvenance(projectId)

    // Fallible runtime/profile cleanup must finish while the existing intent and Session tombstone
    // still provide retry authority. The completion callback below is reserved for releasing the
    // in-memory fences only after both durable markers have been removed.
    await this.lifecycle?.finalizeProjectDeletion?.(projectId)

    // The marked Session tombstone is the durable phase boundary. Remove it only after every Project
    // tail has completed, and keep the intent if physical cleanup fails so recovery retries it.
    await this.sessions.completeProjectSessionDeletion(projectId)

    // Keep the intent until all derived and tombstone cleanup has completed.
    await this.projects.deleteDeletionIntent(projectId)
    this.lifecycle?.completeProjectDeletion?.(projectId)
  }
}

export { ProjectDeletionCoordinator, ProjectDeletionRecoveryLoop }
export type {
  ProjectDeletionRecoveryLoopOptions,
  ProjectDeletionRepository,
  ProjectReviewDeletion,
  ProjectProvenanceDeletion,
  ProjectPermissionGrantDeletion,
  ProjectDeletionLifecycle,
  ProjectSessionDeletion
}
