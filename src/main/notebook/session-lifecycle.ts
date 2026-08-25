import type {
  NotebookKernelInstanceIdentity,
  NotebookKernelMetadata,
  NotebookRunSource,
  NotebookSessionReference,
  NotebookSessionRequest
} from '../../shared/notebook'
import { NotebookKernelExecutor, type NotebookKernelExecutorOptions } from './kernel-executor'
import { NotebookRunRepository, getNotebookRunJsonPath } from './repository'
import {
  NotebookSessionAggregate,
  type NotebookSessionExecutor,
  type NotebookSessionExecutorGeneration,
  type NotebookSessionOwnedExecutor
} from './session-aggregate'
import { NotebookSessionRegistry } from './session-registry'
import type { NotebookRuntimeBindingOwner } from './runtime-binding'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV } from './runtime-paths'
import type { KernelProcessKind } from './kernel-executor'
import {
  createFrameNotebookLane,
  createRootNotebookLane,
  notebookLaneKey,
  notebookLaneScope,
  type NotebookLaneIdentity
} from './lane-identity'
import { resolveProjectId } from '../../shared/project-scope'

type RuntimeSession = NotebookSessionAggregate

type NotebookExecutorLifecycleCallbacks = {
  onIdleShutdown: (kind?: KernelProcessKind, env?: string) => Promise<void>
  onTerminated: (kind: KernelProcessKind, env?: string) => Promise<void>
}

type NotebookSessionLifecycleCallbacks = {
  onNotebookAvailable?: (event: NotebookSessionReference) => void
  onNotebookChanged?: (event: NotebookSessionReference) => void
}

type NotebookKernelStatusPersistenceFailure = {
  operation: 'idle-shutdown' | 'terminated' | 'recovered-idle'
  lane: NotebookLaneIdentity
  kind?: KernelProcessKind
  env?: string
  error: unknown
}

type NotebookSessionLifecycleOptions = {
  storageRoot: string
  defaultProjectId: string
  repository: NotebookRunRepository
  sessions: NotebookSessionRegistry<RuntimeSession>
  runtimeBindings: NotebookRuntimeBindingOwner
  waitForRevocationDrains: () => Promise<void>
  executorFactory?: (
    sessionId: string,
    lifecycle: NotebookExecutorLifecycleCallbacks
  ) => NotebookSessionExecutor
  defaultExecutorOptions: () => NotebookKernelExecutorOptions
  platform?: NodeJS.Platform
  callbacks?: NotebookSessionLifecycleCallbacks
  toSessionReference: (session: RuntimeSession) => NotebookSessionReference
  onKernelStatusPersistenceFailure?: (failure: NotebookKernelStatusPersistenceFailure) => void
}

type InternalNotebookSessionRequest = NotebookSessionRequest & {
  delegatedWorkAttemptId?: string
}

const processKeyFor = (kind: KernelProcessKind | undefined, env: string | undefined): string => {
  const resolvedKind = kind ?? 'python'
  if (resolvedKind === 'repl') return 'repl'
  const resolvedEnv =
    env && env.length > 0 ? env : resolvedKind === 'r' ? DEFAULT_R_ENV : DEFAULT_PY_ENV
  return `${resolvedKind}:${resolvedEnv}`
}

const kernelInstanceForProcessKey = (processKey: string): NotebookKernelInstanceIdentity => {
  if (processKey === 'repl') return { kind: 'repl' }
  const separator = processKey.indexOf(':')
  return {
    kind: processKey.slice(0, separator) === 'r' ? 'r' : 'python',
    environment: processKey.slice(separator + 1)
  }
}

// Orchestrates one Registry generation without duplicating Registry or Aggregate state.
class NotebookSessionLifecycleOwner {
  private readonly announcedAgentLaneKeys = new Set<string>()
  private readonly deletingProjectIds = new Set<string>()
  private readonly pendingEnsuresByProject = new Map<string, Set<Promise<RuntimeSession>>>()
  private readonly pendingOperationsByProject = new Map<string, Set<Promise<unknown>>>()
  private readonly operationAbortControllersByProject = new Map<string, Set<AbortController>>()

  constructor(private readonly options: NotebookSessionLifecycleOptions) {}

  laneForRequest(request: NotebookSessionRequest): NotebookLaneIdentity {
    const projectId = resolveProjectId(request, this.options.defaultProjectId)
    const context = request.provenanceContext
    const attemptId = (request as InternalNotebookSessionRequest).delegatedWorkAttemptId
    if (context && context.agentFrameId === context.rootFrameId) {
      return createRootNotebookLane(projectId, request.sessionId, context.agentFrameId)
    }
    return context?.agentFrameId
      ? createFrameNotebookLane(projectId, request.sessionId, context.agentFrameId, attemptId)
      : this.rootLane(request.sessionId, projectId)
  }

  rootLane(sessionId: string, projectId = this.options.defaultProjectId): NotebookLaneIdentity {
    return createRootNotebookLane(projectId, sessionId, `root-frame-${sessionId}`)
  }

  ensure(request: NotebookSessionRequest): Promise<RuntimeSession> {
    const projectId = resolveProjectId(request, this.options.defaultProjectId)
    try {
      this.assertProjectAvailable(projectId)
    } catch (error) {
      return Promise.reject(error)
    }
    const lane = this.laneForRequest(request)
    const ensuring = this.options.sessions.getOrCreate(lane, async () => {
      this.assertProjectAvailable(projectId)
      let document = await this.options.repository.loadOrCreate({
        projectId: projectId,
        sessionId: request.sessionId,
        workspaceCwd: request.workspaceCwd,
        lane
      })
      if (document.runs.some((run) => run.status === 'running' || run.status === 'queued')) {
        document = await this.options.repository.reconcileInterruptedRuns(
          projectId,
          request.sessionId,
          lane
        )
      }

      const ownedExecutor = this.createExecutor(lane)
      const session = new NotebookSessionAggregate({
        sessionId: request.sessionId,
        projectId,
        cwd: document.dataRoot,
        notebookSessionRoot: document.notebookSessionRoot,
        dataRoot: document.dataRoot,
        runtimeRoot: document.kernel.runtimeRoot,
        runJsonPath: getNotebookRunJsonPath(
          this.options.storageRoot,
          projectId,
          request.sessionId,
          lane
        ),
        executionCount: document.runs.length,
        initialKernelStatus: document.kernel.lastKnownStatus,
        initialTerminatedKernelInstances: document.kernel.terminatedKernelInstances,
        executor: ownedExecutor.executor,
        executorGeneration: ownedExecutor.generation,
        lane
      })

      try {
        await this.options.runtimeBindings.reload(session, document.runtimeBindings)
        this.assertProjectAvailable(projectId)
        return session
      } catch (error) {
        await session.shutdownExecutor().catch(() => undefined)
        try {
          session.releaseMcpRpcConnection()
        } catch {
          // Preserve the initialization failure.
        }
        throw error
      }
    })
    const pending =
      this.pendingEnsuresByProject.get(projectId) ?? new Set<Promise<RuntimeSession>>()
    pending.add(ensuring)
    this.pendingEnsuresByProject.set(projectId, pending)
    void ensuring
      .finally(() => {
        pending.delete(ensuring)
        if (pending.size === 0 && this.pendingEnsuresByProject.get(projectId) === pending) {
          this.pendingEnsuresByProject.delete(projectId)
        }
      })
      .catch(() => undefined)
    return ensuring
  }

  runProjectOperation<Result>(
    request: NotebookSessionRequest,
    operation: (deletionSignal: AbortSignal) => Promise<Result>
  ): Promise<Result> {
    const projectId = resolveProjectId(request, this.options.defaultProjectId)
    try {
      this.assertProjectAvailable(projectId)
    } catch (error) {
      return Promise.reject(error)
    }
    const controller = new AbortController()
    const controllers =
      this.operationAbortControllersByProject.get(projectId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.operationAbortControllersByProject.set(projectId, controllers)
    let resolveRunning!: (value: Result | PromiseLike<Result>) => void
    let rejectRunning!: (reason?: unknown) => void
    const running = new Promise<Result>((resolve, reject) => {
      resolveRunning = resolve
      rejectRunning = reject
    })
    const pending = this.pendingOperationsByProject.get(projectId) ?? new Set<Promise<unknown>>()
    pending.add(running)
    this.pendingOperationsByProject.set(projectId, pending)
    // Register before invoking the operation so a synchronous teardown can observe the lease, while
    // preserving the existing guarantee that callers start work before the method returns.
    try {
      void operation(controller.signal).then(resolveRunning, rejectRunning)
    } catch (error) {
      rejectRunning(error)
    }
    void running
      .finally(() => {
        controllers.delete(controller)
        if (
          controllers.size === 0 &&
          this.operationAbortControllersByProject.get(projectId) === controllers
        ) {
          this.operationAbortControllersByProject.delete(projectId)
        }
        pending.delete(running)
        if (pending.size === 0 && this.pendingOperationsByProject.get(projectId) === pending) {
          this.pendingOperationsByProject.delete(projectId)
        }
      })
      .catch(() => undefined)
    return running
  }

  createExecutor(lane: NotebookLaneIdentity): NotebookSessionOwnedExecutor {
    const { sessionId } = notebookLaneScope(lane)
    const generation = Symbol(`notebook-executor:${notebookLaneKey(lane)}`)
    const lifecycle: NotebookExecutorLifecycleCallbacks = {
      onIdleShutdown: (kind, env) => this.handleIdleShutdown(lane, kind, env, generation),
      onTerminated: (kind, env) => this.handleTerminated(lane, kind, env, generation)
    }
    const injected = this.options.executorFactory
    if (injected) return { executor: injected(sessionId, lifecycle), generation }

    return {
      generation,
      executor: new NotebookKernelExecutor({
        ...this.options.defaultExecutorOptions(),
        platform: this.options.platform,
        onIdleShutdown: (kind, env) => {
          void lifecycle.onIdleShutdown(kind, env).catch((error: unknown) => {
            this.options.onKernelStatusPersistenceFailure?.({
              operation: 'idle-shutdown',
              lane,
              kind,
              env,
              error
            })
          })
        },
        onTerminated: (kind, env) => {
          void lifecycle.onTerminated(kind, env).catch((error: unknown) => {
            this.options.onKernelStatusPersistenceFailure?.({
              operation: 'terminated',
              lane,
              kind,
              env,
              error
            })
          })
        }
      })
    }
  }

  async shutdown(
    request: NotebookSessionRequest
  ): Promise<{ sessionId: string; status: 'shutdown' }> {
    return this.shutdownLane(this.laneForRequest(request))
  }

  async shutdownSession(sessionId: string): Promise<{ sessionId: string; status: 'shutdown' }> {
    return this.shutdownLane(this.rootLane(sessionId))
  }

  async shutdownProject(projectId: string): Promise<void> {
    this.beginProjectDeletion(projectId)
    await Promise.allSettled([
      ...(this.pendingEnsuresByProject.get(projectId) ?? []),
      ...(this.pendingOperationsByProject.get(projectId) ?? [])
    ])
    const lanes = Array.from(this.options.sessions.values())
      .filter((session) => session.projectId === projectId)
      .map((session) => session.lane)
    const results = await Promise.allSettled(lanes.map((lane) => this.shutdownLane(lane)))
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Notebook Project cleanup failed: ' + projectId)
    }
  }

  beginProjectDeletion(projectId: string): void {
    this.deletingProjectIds.add(projectId)
    const reason = new Error('Project is being deleted.')
    for (const controller of this.operationAbortControllersByProject.get(projectId) ?? []) {
      controller.abort(reason)
    }
  }

  releaseProjectDeletion(projectId: string): void {
    this.deletingProjectIds.delete(projectId)
  }

  private async shutdownLane(
    lane: NotebookLaneIdentity
  ): Promise<{ sessionId: string; status: 'shutdown' }> {
    const { sessionId } = notebookLaneScope(lane)
    const key = notebookLaneKey(lane)
    await this.options.runtimeBindings.withSessionTeardown(key, async () => {
      await this.options.runtimeBindings.waitForWrites(key)
      // A non-forced runtime revoke releases its binding write after scheduling kernel termination.
      // Holding the lane teardown gate while waiting closes both sides of the race: an earlier revoke
      // must finish before removal, while a later revoke cannot enter until the lane is already gone.
      await this.options.waitForRevocationDrains()
      await this.options.sessions.remove(lane)
    })
    return { sessionId, status: 'shutdown' }
  }

  private assertProjectAvailable(projectId: string): void {
    if (this.deletingProjectIds.has(projectId)) {
      throw new Error('Project is being deleted.')
    }
  }

  shutdownAll(): Promise<{ reaped: boolean }> {
    return this.options.runtimeBindings.withGlobalTeardown(() =>
      this.options.sessions.shutdownAll()
    )
  }

  dispose(): Promise<{ reaped: boolean }> {
    return this.options.runtimeBindings.withGlobalTeardown(() => this.options.sessions.dispose())
  }

  activeSessions(): { projectId: string; sessionId: string }[] {
    return Array.from(this.options.sessions.values())
      .filter((session) => session.hasActiveRun())
      .map((session) => ({ projectId: session.projectId, sessionId: session.sessionId }))
  }

  notifyAvailable(session: RuntimeSession, source: NotebookRunSource): void {
    const laneKey = notebookLaneKey(session.lane)
    if (source !== 'agent' || this.announcedAgentLaneKeys.has(laneKey)) return
    this.announcedAgentLaneKeys.add(laneKey)
    this.options.callbacks?.onNotebookAvailable?.(this.options.toSessionReference(session))
  }

  notifyChanged(session: RuntimeSession): void {
    this.options.callbacks?.onNotebookChanged?.(this.options.toSessionReference(session))
  }

  async persistKernelStatus(
    session: RuntimeSession,
    status: NotebookKernelMetadata['lastKnownStatus'],
    processKey: string
  ): Promise<void> {
    const kernelInstance = kernelInstanceForProcessKey(processKey)
    if (status === 'terminated') {
      // A legacy coarse terminated status has unknown ownership. Keep it conservative until an
      // explicit restart instead of replacing the ambiguity with a partial known-instance set.
      if (!session.hasUnknownDurableKernelTermination()) {
        await this.options.repository.markKernelTerminated({
          projectId: session.projectId,
          sessionId: session.sessionId,
          lane: session.lane,
          kernelInstance
        })
        session.markDurableKernelTermination(processKey)
      }
    } else if (status === 'idle') {
      if (session.hasDurableKernelTermination(processKey)) {
        await this.options.repository.clearKernelTermination({
          projectId: session.projectId,
          sessionId: session.sessionId,
          lane: session.lane,
          kernelInstance
        })
        session.clearDurableKernelTermination(processKey)
      }
    } else {
      await this.options.repository.updateKernelStatus({
        projectId: session.projectId,
        sessionId: session.sessionId,
        lane: session.lane,
        status
      })
    }
    session.setKernelStatus(processKey, status)
  }

  async persistRecoveredKernelIdle(session: RuntimeSession, processKey: string): Promise<void> {
    try {
      await this.persistKernelStatus(session, 'idle', processKey)
    } catch (error) {
      const kernelInstance = kernelInstanceForProcessKey(processKey)
      this.options.onKernelStatusPersistenceFailure?.({
        operation: 'recovered-idle',
        lane: session.lane,
        kind: kernelInstance.kind,
        env: 'environment' in kernelInstance ? kernelInstance.environment : undefined,
        error
      })
    }
  }

  async clearPersistedKernelTermination(
    session: RuntimeSession,
    processKey: string
  ): Promise<void> {
    if (!session.hasDurableKernelTermination(processKey)) return
    await this.options.repository.clearKernelTermination({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lane: session.lane,
      kernelInstance: kernelInstanceForProcessKey(processKey)
    })
    session.clearDurableKernelTermination(processKey)
  }

  async projectKernelIdleShutdown(
    lane: NotebookLaneIdentity,
    kind?: KernelProcessKind,
    env?: string
  ): Promise<void> {
    const session = this.options.sessions.get(lane)
    if (!session) return
    const processKey = processKeyFor(kind, env)
    // The executor has already ended this concrete process. Rotate volatile dependency identity
    // even when the durable status projection fails, so a respawn cannot inherit the old namespace.
    session.retireKernelEpoch(processKey)
    await this.persistKernelStatus(session, 'terminated', processKey)
    this.notifyChanged(session)
  }

  async projectKernelTerminated(
    lane: NotebookLaneIdentity,
    kind: KernelProcessKind,
    env?: string
  ): Promise<void> {
    const session = this.options.sessions.get(lane)
    if (!session) return
    const processKey = processKeyFor(kind, env)
    session.markKernelTerminated(processKey)
    session.retireKernelEpoch(processKey)
    await this.persistKernelStatus(session, 'terminated', processKey)
    this.notifyChanged(session)
  }

  private async handleIdleShutdown(
    lane: NotebookLaneIdentity,
    kind: KernelProcessKind | undefined,
    env: string | undefined,
    generation: NotebookSessionExecutorGeneration
  ): Promise<void> {
    const session = this.options.sessions.get(lane)
    if (!session) return
    const processKey = processKeyFor(kind, env)
    const projection = session.runExecutorLifecycleCallback(generation, async () => {
      await this.projectKernelIdleShutdown(lane, kind, env)
    })
    session.blockKernelExecutionUntil(processKey, projection)
    await projection
  }

  private async handleTerminated(
    lane: NotebookLaneIdentity,
    kind: KernelProcessKind,
    env: string | undefined,
    generation: NotebookSessionExecutorGeneration
  ): Promise<void> {
    const session = this.options.sessions.get(lane)
    if (!session) return
    const processKey = processKeyFor(kind, env)
    const projection = session.runExecutorLifecycleCallback(generation, async () => {
      await this.projectKernelTerminated(lane, kind, env)
    })
    session.blockKernelExecutionUntil(processKey, projection)
    await projection
  }
}

export { NotebookSessionLifecycleOwner }
export type {
  NotebookExecutorLifecycleCallbacks,
  NotebookSessionLifecycleCallbacks,
  NotebookSessionLifecycleOptions
}
