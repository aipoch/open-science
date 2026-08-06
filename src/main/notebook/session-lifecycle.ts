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
  private readonly announcedAgentSessionIds = new Set<string>()

  constructor(private readonly options: NotebookSessionLifecycleOptions) {}

  ensure(request: NotebookSessionRequest): Promise<RuntimeSession> {
    const projectName = request.projectName ?? this.options.defaultProjectName
    return this.options.sessions.getOrCreate(request.sessionId, async () => {
      let document = await this.options.repository.loadOrCreate({
        projectName,
        sessionId: request.sessionId,
        workspaceCwd: request.workspaceCwd
      })
      if (document.runs.some((run) => run.status === 'running' || run.status === 'queued')) {
        document = await this.options.repository.reconcileInterruptedRuns(
          projectName,
          request.sessionId
        )
      }

      const ownedExecutor = this.createExecutor(request.sessionId)
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
          request.sessionId
        ),
        executionCount: document.runs.length,
        executor: ownedExecutor.executor,
        executorGeneration: ownedExecutor.generation
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

  createExecutor(sessionId: string): NotebookSessionOwnedExecutor {
    const generation = Symbol(`notebook-executor:${sessionId}`)
    const lifecycle: NotebookExecutorLifecycleCallbacks = {
      onIdleShutdown: (kind, env) => this.handleIdleShutdown(sessionId, kind, env, generation),
      onTerminated: (kind, env) => this.handleTerminated(sessionId, kind, env, generation)
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

  async shutdownSession(sessionId: string): Promise<{ sessionId: string; status: 'shutdown' }> {
    await this.options.runtimeBindings.withSessionTeardown(sessionId, async () => {
      await this.options.runtimeBindings.waitForWrites(sessionId)
      await this.options.sessions.remove(sessionId)
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
    if (source !== 'agent' || this.announcedAgentSessionIds.has(session.sessionId)) return
    this.announcedAgentSessionIds.add(session.sessionId)
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
        status
      })
    } catch {
      return
    }
  }

  private async handleIdleShutdown(
    sessionId: string,
    kind: KernelProcessKind | undefined,
    env: string | undefined,
    generation: NotebookSessionExecutorGeneration
  ): Promise<void> {
    const session = this.options.sessions.get(sessionId)
    if (!session) return
    const processKey = processKeyFor(kind, env)
    await session.runExecutorLifecycleCallback(generation, async () => {
      await this.persistKernelStatus(session, 'terminated', processKey)
      this.notifyChanged(session)
    })
  }

  private async handleTerminated(
    sessionId: string,
    kind: KernelProcessKind,
    env: string | undefined,
    generation: NotebookSessionExecutorGeneration
  ): Promise<void> {
    const session = this.options.sessions.get(sessionId)
    if (!session) return
    const processKey = processKeyFor(kind, env)
    await session.runExecutorLifecycleCallback(generation, async () => {
      session.markKernelTerminated(processKey)
      await this.persistKernelStatus(session, 'terminated', processKey)
      this.notifyChanged(session)
    })
  }
}

export { NotebookSessionLifecycleOwner }
export type {
  NotebookExecutorLifecycleCallbacks,
  NotebookSessionLifecycleCallbacks,
  NotebookSessionLifecycleOptions
}
