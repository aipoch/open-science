import type {
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

type RuntimeSession = NotebookSessionAggregate

type NotebookExecutorLifecycleCallbacks = {
  onIdleShutdown: (kind?: KernelProcessKind, env?: string) => Promise<void>
  onTerminated: (kind: KernelProcessKind, env?: string) => Promise<void>
}

type NotebookSessionLifecycleCallbacks = {
  onNotebookAvailable?: (event: NotebookSessionReference) => void
  onNotebookChanged?: (event: NotebookSessionReference) => void
}

type NotebookSessionLifecycleOptions = {
  storageRoot: string
  defaultProjectName: string
  repository: NotebookRunRepository
  sessions: NotebookSessionRegistry<RuntimeSession>
  runtimeBindings: NotebookRuntimeBindingOwner
  executorFactory?: (
    sessionId: string,
    lifecycle: NotebookExecutorLifecycleCallbacks
  ) => NotebookSessionExecutor
  defaultExecutorOptions: () => NotebookKernelExecutorOptions
  platform?: NodeJS.Platform
  callbacks?: NotebookSessionLifecycleCallbacks
  toSessionReference: (session: RuntimeSession) => NotebookSessionReference
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

const persistsToRunJson = (processKey: string): boolean =>
  processKey === 'repl' ||
  processKey === `python:${DEFAULT_PY_ENV}` ||
  processKey === `r:${DEFAULT_R_ENV}`

// Orchestrates one Registry generation without duplicating Registry or Aggregate state.
class NotebookSessionLifecycleOwner {
  private readonly announcedAgentLaneKeys = new Set<string>()

  constructor(private readonly options: NotebookSessionLifecycleOptions) {}

  laneForRequest(request: NotebookSessionRequest): NotebookLaneIdentity {
    const projectName = request.projectName ?? this.options.defaultProjectName
    const context = request.provenanceContext
    const attemptId = (request as InternalNotebookSessionRequest).delegatedWorkAttemptId
    if (context && context.agentFrameId === context.rootFrameId) {
      return createRootNotebookLane(projectName, request.sessionId, context.agentFrameId)
    }
    return context?.agentFrameId
      ? createFrameNotebookLane(projectName, request.sessionId, context.agentFrameId, attemptId)
      : this.rootLane(request.sessionId, projectName)
  }

  rootLane(sessionId: string, projectName = this.options.defaultProjectName): NotebookLaneIdentity {
    return createRootNotebookLane(projectName, sessionId, `root-frame-${sessionId}`)
  }

  ensure(request: NotebookSessionRequest): Promise<RuntimeSession> {
    const projectName = request.projectName ?? this.options.defaultProjectName
    const lane = this.laneForRequest(request)
    return this.options.sessions.getOrCreate(lane, async () => {
      let document = await this.options.repository.loadOrCreate({
        projectName,
        sessionId: request.sessionId,
        workspaceCwd: request.workspaceCwd,
        lane
      })
      if (document.runs.some((run) => run.status === 'running' || run.status === 'queued')) {
        document = await this.options.repository.reconcileInterruptedRuns(
          projectName,
          request.sessionId,
          lane
        )
      }

      const ownedExecutor = this.createExecutor(lane)
      const session = new NotebookSessionAggregate({
        sessionId: request.sessionId,
        projectName,
        cwd: document.dataRoot,
        notebookSessionRoot: document.notebookSessionRoot,
        dataRoot: document.dataRoot,
        runtimeRoot: document.kernel.runtimeRoot,
        runJsonPath: getNotebookRunJsonPath(
          this.options.storageRoot,
          projectName,
          request.sessionId,
          lane
        ),
        executionCount: document.runs.length,
        executor: ownedExecutor.executor,
        executorGeneration: ownedExecutor.generation,
        lane
      })

      try {
        await this.options.runtimeBindings.reload(session, document.runtimeBindings)
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
        onIdleShutdown: (kind, env) => void lifecycle.onIdleShutdown(kind, env),
        onTerminated: (kind, env) => void lifecycle.onTerminated(kind, env)
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

  private async shutdownLane(
    lane: NotebookLaneIdentity
  ): Promise<{ sessionId: string; status: 'shutdown' }> {
    const { sessionId } = notebookLaneScope(lane)
    const key = notebookLaneKey(lane)
    await this.options.runtimeBindings.withSessionTeardown(key, async () => {
      await this.options.runtimeBindings.waitForWrites(key)
      await this.options.sessions.remove(lane)
    })
    return { sessionId, status: 'shutdown' }
  }

  shutdownAll(): Promise<{ reaped: boolean }> {
    return this.options.runtimeBindings.withGlobalTeardown(() =>
      this.options.sessions.shutdownAll()
    )
  }

  dispose(): Promise<{ reaped: boolean }> {
    return this.options.runtimeBindings.withGlobalTeardown(() => this.options.sessions.dispose())
  }

  activeSessions(): { projectName: string; sessionId: string }[] {
    return Array.from(this.options.sessions.values())
      .filter((session) => session.hasActiveRun())
      .map((session) => ({ projectName: session.projectName, sessionId: session.sessionId }))
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
    session.setKernelStatus(processKey, status)
    if (!persistsToRunJson(processKey)) return
    try {
      await this.options.repository.updateKernelStatus({
        projectName: session.projectName,
        sessionId: session.sessionId,
        lane: session.lane,
        status
      })
    } catch {
      return
    }
  }

  async projectKernelIdleShutdown(
    lane: NotebookLaneIdentity,
    kind?: KernelProcessKind,
    env?: string
  ): Promise<void> {
    const session = this.options.sessions.get(lane)
    if (!session) return
    await this.persistKernelStatus(session, 'terminated', processKeyFor(kind, env))
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
    await session.runExecutorLifecycleCallback(generation, async () => {
      await this.projectKernelIdleShutdown(lane, kind, env)
    })
  }

  private async handleTerminated(
    lane: NotebookLaneIdentity,
    kind: KernelProcessKind,
    env: string | undefined,
    generation: NotebookSessionExecutorGeneration
  ): Promise<void> {
    const session = this.options.sessions.get(lane)
    if (!session) return
    await session.runExecutorLifecycleCallback(generation, async () => {
      await this.projectKernelTerminated(lane, kind, env)
    })
  }
}

export { NotebookSessionLifecycleOwner }
export type {
  NotebookExecutorLifecycleCallbacks,
  NotebookSessionLifecycleCallbacks,
  NotebookSessionLifecycleOptions
}
