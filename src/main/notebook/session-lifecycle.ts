import type {
  NotebookChangedEvent,
  NotebookKernelInstanceIdentity,
  NotebookKernelMetadata,
  NotebookNamespaceRequest,
  NotebookNamespaceSnapshot,
  NotebookRunSource,
  NotebookSessionReference,
  NotebookSessionRequest
} from '../../shared/notebook'
import { parseNotebookLanguage } from '../../shared/notebook'
import { NotebookKernelExecutor, type NotebookKernelExecutorOptions } from './kernel-executor'
import {
  NotebookRunRepository,
  getNotebookFileEvidenceLocation,
  getNotebookRunJsonPath
} from './repository'
import {
  NotebookSessionAggregate,
  type NotebookSessionExecutor,
  type NotebookSessionExecutorGeneration,
  type NotebookSessionOwnedExecutor
} from './session-aggregate'
import { NotebookSessionRegistry } from './session-registry'
import type { NotebookRuntimeBindingOwner } from './runtime-binding'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV, resolveEnvName } from '@aipoch/environment'
import type { KernelProcessKind, NotebookKernelTerminationDiagnostic } from './kernel-executor'
import {
  createFrameNotebookLane,
  createRootNotebookLane,
  notebookLaneKey,
  notebookLaneScope,
  type NotebookLaneIdentity
} from './lane-identity'
import { resolveProjectId } from '../../shared/project-scope'
import { reconcileWorkingFileEvidence } from './working-file-observer'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import type { KernelProcessLifecycleOwner } from './kernel-process-lifecycle.windows-posix'
import type { NotebookExecutionOwner } from './execution-owner'
import { assertResearchSessionWritable } from '../storage/session-package-state'
import type { IdleInterpreter } from './idle-reclamation'
import type { NotebookOwnedResource } from './owned-resources'

type RuntimeSession = NotebookSessionAggregate
type PendingOperation<Result> = Promise<Result> & { resource: NotebookOwnedResource }
const log = createLogger('notebook:file-evidence-lifecycle')

type NotebookExecutorLifecycleCallbacks = {
  onIdleShutdown: (kind?: KernelProcessKind, env?: string, kernelEpochId?: string) => Promise<void>
  onTerminated: (
    kind: KernelProcessKind,
    env?: string,
    diagnostic?: NotebookKernelTerminationDiagnostic,
    kernelEpochId?: string
  ) => Promise<void>
}

type NotebookSessionLifecycleCallbacks = {
  onNotebookAvailable?: (event: NotebookSessionReference) => void
  onNotebookChanged?: (event: NotebookChangedEvent) => void
}

type NotebookKernelStatusPersistenceFailure = {
  operation: 'idle-shutdown' | 'terminated' | 'recovered-idle'
  lane: NotebookLaneIdentity
  kind?: KernelProcessKind
  env?: string
  error: unknown
}

type NotebookSessionLifecycleOptions = {
  onActivityChanged?: (sessionId?: string) => void
  observeSession?: (sessionId: string) => () => void
  isSessionBusy?: (projectId: string, sessionId: string) => boolean | Promise<boolean>
  admitSessionWork?: (projectId: string, sessionId: string, observation?: boolean) => () => void
  storageRoot: string
  defaultProjectId: string
  repository: NotebookRunRepository
  sessions: NotebookSessionRegistry<RuntimeSession>
  runtimeBindings: NotebookRuntimeBindingOwner
  shellExecution: Pick<NotebookExecutionOwner, 'fenceShellRuns' | 'cancelShellRuns'>
  waitForRevocationDrains: () => Promise<void>
  ensureProcessRecovery: (laneKey: string) => Promise<void>
  processLifecycle: KernelProcessLifecycleOwner
  executorFactory?: (
    sessionId: string,
    lifecycle: NotebookExecutorLifecycleCallbacks
  ) => NotebookSessionExecutor
  defaultExecutorOptions: () => NotebookKernelExecutorOptions
  platform?: NodeJS.Platform
  callbacks?: NotebookSessionLifecycleCallbacks
  toSessionReference: (session: RuntimeSession) => NotebookSessionReference
  onKernelStatusPersistenceFailure?: (failure: NotebookKernelStatusPersistenceFailure) => void
  finalizeKernelEpochs?: (request: {
    projectId: string
    sessionId: string
    kernelEpochIds: readonly string[]
  }) => Promise<void>
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

const DEFAULT_KERNEL_PROCESS_KEY = processKeyFor('python', DEFAULT_PY_ENV)

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
  private readonly idleTeardowns = new Map<string, Promise<boolean>>()
  private readonly retainedReleaseHolds = new Set<string>()
  private readonly retainedReleases = new Map<
    string,
    { projectId: string; sessionId: string; operation: Promise<void> }
  >()

  resourceReleaseBlockedReason(scope: {
    projectId: string
    sessionId: string
  }): string | undefined {
    if (this.terminal || this.shutdownAllPromise) return 'application-stopping'
    if (
      this.deletingProjectIds.has(scope.projectId) ||
      this.deletingSessionIds.has(scope.sessionId)
    )
      return 'session-unavailable'
    if (this.retainedReleaseHolds.has(JSON.stringify([scope.projectId, scope.sessionId])))
      return 'release-in-progress'
    return this.idleTeardowns.has(scope.sessionId) ? 'cleanup-in-progress' : undefined
  }

  holdSessionResources(scope: { projectId: string; sessionId: string }): () => void {
    const key = JSON.stringify([scope.projectId, scope.sessionId])
    this.assertScopeAvailable(scope.projectId, scope.sessionId)
    if (this.shutdownAllPromise || this.idleTeardowns.has(scope.sessionId))
      throw new Error(
        'Notebook teardown is already in progress. Refresh before releasing resources.'
      )
    this.retainedReleaseHolds.add(key)
    return () => this.retainedReleaseHolds.delete(key)
  }

  observeSessionRelease(
    scope: { projectId: string; sessionId: string },
    operation: Promise<void>
  ): void {
    const key = JSON.stringify([scope.projectId, scope.sessionId])
    const entry = { ...scope, operation }
    this.retainedReleases.set(key, entry)
    void operation
      .finally(() => {
        if (this.retainedReleases.get(key) === entry) this.retainedReleases.delete(key)
      })
      .catch(() => undefined)
  }

  async waitForSessionTeardown(
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<void> {
    await Promise.allSettled([
      ...[...this.retainedReleases.entries()].flatMap(([key, entry]) => {
        const [, sessionId] = JSON.parse(key) as [string, string]
        return (scope.projectId === undefined || scope.projectId === entry.projectId) &&
          (scope.sessionId === undefined || scope.sessionId === sessionId)
          ? [entry.operation]
          : []
      }),
      ...(scope.sessionId
        ? [this.idleTeardowns.get(scope.sessionId)].filter((entry) => entry !== undefined)
        : [...this.idleTeardowns.values()])
    ])
  }

  resources(scope: { projectId?: string; sessionId?: string } = {}): NotebookOwnedResource[] {
    const matches = (resource: { projectId?: string; sessionId?: string }): boolean =>
      (scope.projectId === undefined || resource.projectId === scope.projectId) &&
      (scope.sessionId === undefined || resource.sessionId === scope.sessionId)
    const pending = new Set<PendingOperation<unknown>>([
      ...Array.from(this.pendingEnsuresByProject.values()).flatMap((entries) => [...entries]),
      ...Array.from(this.pendingOperationsByProject.values()).flatMap((entries) => [...entries])
    ])
    return [
      ...Array.from(this.options.sessions.values())
        .filter(matches)
        .flatMap((session) =>
          session.resources(async (resource) => {
            if (this.options.sessions.get(session.lane) !== session) return
            if (resource.processKey)
              await this.persistKernelStatus(session, 'terminated', resource.processKey)
            this.notifyChanged(session)
          })
        ),
      ...Array.from(pending, ({ resource }) => resource).filter(matches)
    ]
  }

  hasPendingWork(sessionId: string): boolean {
    return (
      this.terminal ||
      Boolean(
        this.shutdownAllPromise ||
        [...this.retainedReleases.values()].some((entry) => entry.sessionId === sessionId) ||
        this.pendingOperationsBySession.get(sessionId)?.size ||
        this.pendingEnsuresBySession.get(sessionId)?.size
      )
    )
  }

  idleInterpreters(): IdleInterpreter[] {
    return [...this.options.sessions.values()].flatMap((session) =>
      session.idleProcesses().map((process) => ({
        identity: process.identity,
        executionDomain: process.executionDomain,
        projectId: session.projectId,
        sessionId: session.sessionId,
        group: process.processKey === 'repl' ? ('repl' as const) : ('data' as const),
        lastUsedAt:
          session.kernelActivityEntries().find(([key]) => key === process.processKey)?.[2] ?? 0,
        release: (stillIdle) =>
          this.reclaimIdleInterpreter(
            {
              ...process,
              projectId: session.projectId,
              sessionId: session.sessionId,
              release: () =>
                this.options.runtimeBindings.withSessionTeardown(
                  notebookLaneKey(session.lane),
                  async () => {
                    await this.options.runtimeBindings.waitForWrites(notebookLaneKey(session.lane))
                    await this.options.waitForRevocationDrains()
                    if (await this.options.isSessionBusy?.(session.projectId, session.sessionId))
                      return false
                    if (!stillIdle() || this.hasPendingWork(session.sessionId)) return false
                    if (this.options.sessions.get(session.lane) !== session) return false
                    const owned = this.resources({
                      projectId: session.projectId,
                      sessionId: session.sessionId
                    }).find((resource) => resource.identity === process.identity)
                    if (!owned) {
                      const stopped = await process.release()
                      if (stopped) {
                        const instance = kernelInstanceForProcessKey(process.processKey)
                        await this.projectKernelIdleShutdown(
                          session.lane,
                          instance.kind,
                          'environment' in instance ? instance.environment : undefined
                        )
                      }
                      return stopped
                    }
                    owned.retainForRelease?.()
                    const result = await owned.release()
                    if (result.projection === 'failed') throw result.error
                    return result.reaped
                  }
                )
            },
            stillIdle
          )
      }))
    )
  }

  reclaimIdleInterpreter(
    resource: Pick<IdleInterpreter, 'projectId' | 'sessionId' | 'release'>,
    stillIdle: () => boolean
  ): Promise<boolean> {
    if (
      this.terminal ||
      this.deletingSessionIds.has(resource.sessionId) ||
      this.deletingProjectIds.has(resource.projectId) ||
      this.hasPendingWork(resource.sessionId) ||
      this.idleTeardowns.has(resource.sessionId) ||
      !stillIdle()
    )
      return Promise.resolve(false)
    // Install the gate synchronously. New Notebook work waits, rather than racing a terminating tree.
    const teardown = Promise.resolve()
      .then(async () => {
        if (await this.options.isSessionBusy?.(resource.projectId, resource.sessionId)) return false
        if (this.hasPendingWork(resource.sessionId) || !stillIdle() || this.terminal) return false
        return resource.release(stillIdle)
      })
      .finally(() => {
        if (this.idleTeardowns.get(resource.sessionId) === teardown)
          this.idleTeardowns.delete(resource.sessionId)
      })
    this.idleTeardowns.set(resource.sessionId, teardown)
    return teardown
  }
  private readonly announcedAgentLaneKeys = new Set<string>()
  private readonly deletingProjectIds = new Set<string>()
  private readonly deletingSessionIds = new Set<string>()
  private readonly pendingEnsuresByProject = new Map<
    string,
    Set<PendingOperation<RuntimeSession>>
  >()
  private readonly pendingEnsuresBySession = new Map<
    string,
    Set<PendingOperation<RuntimeSession>>
  >()
  private readonly pendingOperationsByProject = new Map<string, Set<PendingOperation<unknown>>>()
  private readonly pendingOperationsBySession = new Map<string, Set<PendingOperation<unknown>>>()
  private readonly operationAbortControllersByProject = new Map<string, Set<AbortController>>()
  private readonly operationAbortControllersBySession = new Map<string, Set<AbortController>>()
  private terminal = false
  private shutdownAllPromise: Promise<{ reaped: boolean }> | undefined
  private disposalPromise: Promise<{ reaped: boolean }> | undefined

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

  ensure(request: NotebookSessionRequest, admissionHeld = false): Promise<RuntimeSession> {
    const idleTeardown = this.idleTeardowns.get(request.sessionId)
    if (idleTeardown) return idleTeardown.then(() => this.ensure(request, admissionHeld))
    const projectId = resolveProjectId(request, this.options.defaultProjectId)
    const lane = this.laneForRequest(request)
    let releaseAdmission: (() => void) | undefined
    try {
      this.assertScopeAvailable(projectId, request.sessionId)
      // History reconciliation runs inside an admitted observation, including while export drains it.
      if (!admissionHeld)
        releaseAdmission = this.options.admitSessionWork?.(projectId, request.sessionId)
    } catch (error) {
      return Promise.reject(error)
    }
    const controller = new AbortController()
    const assertCreationAvailable = (): void => {
      this.assertDeletionAvailable(projectId, request.sessionId)
      if (controller.signal.aborted)
        throw new Error('Notebook session initialization was cancelled.')
    }
    const ensuring = this.options.sessions.getOrCreate(lane, async () => {
      await this.options.ensureProcessRecovery(notebookLaneKey(lane))
      assertCreationAvailable()
      await assertResearchSessionWritable(this.options.storageRoot, projectId, request.sessionId)
      let document = await this.options.repository.loadSessionInitialization({
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
      const fileEvidenceLocation = getNotebookFileEvidenceLocation(
        this.options.storageRoot,
        projectId,
        request.sessionId,
        lane
      )
      await reconcileWorkingFileEvidence(
        {
          storageRoot: this.options.storageRoot,
          root: fileEvidenceLocation.root,
          storageKeyPrefix: fileEvidenceLocation.storageKeyPrefix
        },
        document.runs
      ).catch((error) => {
        log.warn('Notebook file-evidence reconciliation failed closed', {
          projectId,
          sessionId: request.sessionId,
          lane: notebookLaneKey(lane),
          ...diagnosticErrorFields(error)
        })
      })

      assertCreationAvailable()
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
        lane,
        onKernelEpochsRetired: async (epochs) => {
          await this.options.finalizeKernelEpochs?.({
            projectId,
            sessionId: request.sessionId,
            kernelEpochIds: epochs.map(({ id }) => id)
          })
        }
      })

      try {
        await this.options.runtimeBindings.reload(session, document.runtimeBindings)
        assertCreationAvailable()
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
    }) as PendingOperation<RuntimeSession>
    ensuring.resource ??= {
      identity: ensuring,
      group: 'operation',
      kind: 'ensure',
      phase: 'starting',
      startedAt: Date.now(),
      projectId,
      sessionId: request.sessionId,
      laneKey: notebookLaneKey(lane),
      release: async () => {
        controller.abort()
        await ensuring.catch(() => undefined)
        return { reaped: true }
      }
    }
    const pending =
      this.pendingEnsuresByProject.get(projectId) ?? new Set<PendingOperation<RuntimeSession>>()
    pending.add(ensuring)
    this.pendingEnsuresByProject.set(projectId, pending)
    const sessionPending =
      this.pendingEnsuresBySession.get(request.sessionId) ??
      new Set<PendingOperation<RuntimeSession>>()
    sessionPending.add(ensuring)
    this.pendingEnsuresBySession.set(request.sessionId, sessionPending)
    void ensuring
      .finally(() => {
        releaseAdmission?.()
        pending.delete(ensuring)
        if (pending.size === 0 && this.pendingEnsuresByProject.get(projectId) === pending) {
          this.pendingEnsuresByProject.delete(projectId)
        }
        sessionPending.delete(ensuring)
        if (
          sessionPending.size === 0 &&
          this.pendingEnsuresBySession.get(request.sessionId) === sessionPending
        ) {
          this.pendingEnsuresBySession.delete(request.sessionId)
        }
      })
      .catch(() => undefined)
    return ensuring
  }

  runProjectOperation<Result>(
    request: NotebookSessionRequest,
    operation: (deletionSignal: AbortSignal) => Promise<Result>,
    trackActivity = true
  ): Promise<Result> {
    if (trackActivity) this.options.onActivityChanged?.(request.sessionId)
    const idleTeardown = this.idleTeardowns.get(request.sessionId)
    if (idleTeardown)
      return idleTeardown.then(() => this.runProjectOperation(request, operation, trackActivity))
    const projectId = resolveProjectId(request, this.options.defaultProjectId)
    let releaseAdmission: (() => void) | undefined
    try {
      this.assertScopeAvailable(projectId, request.sessionId)
      releaseAdmission = this.options.admitSessionWork?.(
        projectId,
        request.sessionId,
        !trackActivity
      )
    } catch (error) {
      return Promise.reject(error)
    }
    const releaseObservation = trackActivity
      ? undefined
      : this.options.observeSession?.(request.sessionId)
    const controller = new AbortController()
    const controllers =
      this.operationAbortControllersByProject.get(projectId) ?? new Set<AbortController>()
    controllers.add(controller)
    this.operationAbortControllersByProject.set(projectId, controllers)
    const sessionControllers =
      this.operationAbortControllersBySession.get(request.sessionId) ?? new Set<AbortController>()
    sessionControllers.add(controller)
    this.operationAbortControllersBySession.set(request.sessionId, sessionControllers)
    let resolveRunning!: (value: Result | PromiseLike<Result>) => void
    let rejectRunning!: (reason?: unknown) => void
    const running = new Promise<Result>((resolve, reject) => {
      resolveRunning = resolve
      rejectRunning = reject
    }) as PendingOperation<Result>
    running.resource = {
      identity: running,
      group: 'operation',
      kind: 'session-work',
      phase: 'running',
      startedAt: Date.now(),
      projectId,
      sessionId: request.sessionId,
      laneKey: notebookLaneKey(this.laneForRequest(request)),
      release: async () => {
        controller.abort(new Error('Notebook operation was released.'))
        await running.catch(() => undefined)
        return { reaped: true }
      }
    }
    const pending =
      this.pendingOperationsByProject.get(projectId) ?? new Set<PendingOperation<unknown>>()
    pending.add(running)
    this.pendingOperationsByProject.set(projectId, pending)
    const sessionPending =
      this.pendingOperationsBySession.get(request.sessionId) ?? new Set<PendingOperation<unknown>>()
    sessionPending.add(running)
    this.pendingOperationsBySession.set(request.sessionId, sessionPending)
    // Register before invoking the operation so a synchronous teardown can observe the lease, while
    // preserving the existing guarantee that callers start work before the method returns.
    try {
      void operation(controller.signal).then(resolveRunning, rejectRunning)
    } catch (error) {
      rejectRunning(error)
    }
    void running
      .finally(() => {
        releaseAdmission?.()
        controllers.delete(controller)
        if (
          controllers.size === 0 &&
          this.operationAbortControllersByProject.get(projectId) === controllers
        ) {
          this.operationAbortControllersByProject.delete(projectId)
        }
        sessionControllers.delete(controller)
        if (
          sessionControllers.size === 0 &&
          this.operationAbortControllersBySession.get(request.sessionId) === sessionControllers
        ) {
          this.operationAbortControllersBySession.delete(request.sessionId)
        }
        pending.delete(running)
        if (pending.size === 0 && this.pendingOperationsByProject.get(projectId) === pending) {
          this.pendingOperationsByProject.delete(projectId)
        }
        sessionPending.delete(running)
        if (
          sessionPending.size === 0 &&
          this.pendingOperationsBySession.get(request.sessionId) === sessionPending
        ) {
          this.pendingOperationsBySession.delete(request.sessionId)
        }
        this.options.onActivityChanged?.(trackActivity ? request.sessionId : undefined)
        releaseObservation?.()
      })
      .catch(() => undefined)
    return running
  }

  inspectNamespace(request: NotebookNamespaceRequest): Promise<NotebookNamespaceSnapshot> {
    return this.runProjectOperation(
      request,
      async (deletionSignal) => {
        const language = parseNotebookLanguage(request.language)
        const environment = resolveEnvName(language, request.environment)
        const processKey = processKeyFor(language, environment)
        const session = this.options.sessions.get(this.laneForRequest(request))
        if (!session) return { status: 'unavailable', reason: 'kernel-not-live' }

        const kernelEpochId = session.currentKernelEpochId(processKey)
        if (!kernelEpochId) return { status: 'unavailable', reason: 'kernel-not-live' }

        try {
          const result = await session.enqueueExecution(
            processKey,
            () =>
              session.inspectNamespace({
                language,
                environment,
                includePrivate: request.includePrivate === true
              }),
            deletionSignal
          )
          if (session.currentKernelEpochId(processKey) !== kernelEpochId) {
            return { status: 'unavailable', reason: 'kernel-restarted' }
          }
          if (result.status === 'unavailable') {
            return { status: 'unavailable', reason: 'kernel-not-live' }
          }
          return { ...result, language, environment, kernelEpochId }
        } catch (error) {
          if (session.currentKernelEpochId(processKey) !== kernelEpochId) {
            return { status: 'unavailable', reason: 'kernel-restarted' }
          }
          throw error
        }
      },
      false
    )
  }

  createExecutor(lane: NotebookLaneIdentity): NotebookSessionOwnedExecutor {
    const { sessionId } = notebookLaneScope(lane)
    const generation = Symbol(`notebook-executor:${notebookLaneKey(lane)}`)
    const lifecycle: NotebookExecutorLifecycleCallbacks = {
      onIdleShutdown: (kind, env, kernelEpochId) =>
        this.handleIdleShutdown(lane, kind, env, generation, kernelEpochId),
      onTerminated: (kind, env, _diagnostic, kernelEpochId) =>
        this.handleTerminated(lane, kind, env, generation, kernelEpochId)
    }
    const injected = this.options.executorFactory
    if (injected) return { executor: injected(sessionId, lifecycle), generation }

    return {
      generation,
      executor: new NotebookKernelExecutor({
        ...this.options.defaultExecutorOptions(),
        // Session-aware reclamation owns production idleness, including model/background activity.
        idleTimeoutMs: 0,
        platform: this.options.platform,
        processLifecycle: this.options.processLifecycle,
        laneKey: notebookLaneKey(lane),
        onIdleShutdown: (kind, env, kernelEpochId) => {
          void lifecycle.onIdleShutdown(kind, env, kernelEpochId).catch((error: unknown) => {
            this.options.onKernelStatusPersistenceFailure?.({
              operation: 'idle-shutdown',
              lane,
              kind,
              env,
              error
            })
          })
        },
        onTerminated: (kind, env, diagnostic, kernelEpochId) => {
          if (diagnostic) {
            log.warn('Notebook kernel process terminated', {
              lane,
              kind,
              env,
              ...diagnostic
            })
          }
          void lifecycle
            .onTerminated(kind, env, diagnostic, kernelEpochId)
            .catch((error: unknown) => {
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
    const laneKey = notebookLaneKey(this.laneForRequest(request))
    return this.withShellTeardown(
      { laneKey },
      new Error('Notebook Session is shutting down.'),
      () => this.shutdownLane(this.laneForRequest(request))
    )
  }

  async shutdownSession(sessionId: string): Promise<{ sessionId: string; status: 'shutdown' }> {
    return this.withShellTeardown(
      { sessionId },
      new Error('Notebook Session is shutting down.'),
      async () => {
        this.deletingSessionIds.add(sessionId)
        const reason = new Error('Session is being deleted.')
        for (const controller of this.operationAbortControllersBySession.get(sessionId) ?? []) {
          controller.abort(reason)
        }
        await Promise.allSettled([
          ...(this.pendingEnsuresBySession.get(sessionId) ?? []),
          ...(this.pendingOperationsBySession.get(sessionId) ?? [])
        ])
        const lanes = Array.from(this.options.sessions.values())
          .filter((session) => session.sessionId === sessionId)
          .map((session) => session.lane)
        const results = await Promise.allSettled(lanes.map((lane) => this.shutdownLane(lane)))
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        )
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Notebook Session cleanup failed: ' + sessionId)
        }
        return { sessionId, status: 'shutdown' as const }
      }
    )
  }

  async shutdownProject(projectId: string): Promise<void> {
    this.beginProjectDeletion(projectId)
    return this.withShellTeardown(
      { projectId },
      new Error('Notebook Project is shutting down.'),
      async () => {
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
    )
  }

  private async withShellTeardown<T>(
    scope: { projectId?: string; sessionId?: string; laneKey?: string },
    reason: Error,
    cleanup: () => Promise<T>
  ): Promise<T> {
    const releaseFence = this.options.shellExecution.fenceShellRuns(scope)
    try {
      await this.waitForSessionTeardown(scope)
      await this.options.shellExecution.cancelShellRuns(scope, reason)
      return await cleanup()
    } finally {
      releaseFence()
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
    const result = await this.options.runtimeBindings.withSessionTeardown(key, async () => {
      await this.options.runtimeBindings.waitForWrites(key)
      // A non-forced runtime revoke releases its binding write after scheduling kernel termination.
      // Holding the lane teardown gate while waiting closes both sides of the race: an earlier revoke
      // must finish before removal, while a later revoke cannot enter until the lane is already gone.
      await this.options.waitForRevocationDrains()
      const session = this.options.sessions.get(lane)
      const removed = await this.options.sessions.remove(lane)
      // Registry removal invalidates activity even when process reaping remains unconfirmed.
      if (session) this.notifyChanged(session)
      return removed
    })
    if (!result.reaped) {
      throw new Error(
        `Notebook lane ${key} persistent process tree was not reaped; destructive teardown remains fenced.`
      )
    }
    return { sessionId, status: 'shutdown' }
  }

  private assertScopeAvailable(projectId: string, sessionId: string): void {
    if (this.terminal) throw new Error('Notebook runtime is disposed.')
    this.assertDeletionAvailable(projectId, sessionId)
    if (this.retainedReleaseHolds.has(JSON.stringify([projectId, sessionId])))
      throw new Error('Notebook resources are being released. Start a new execution after cleanup.')
  }

  private assertDeletionAvailable(projectId: string, sessionId: string): void {
    if (this.deletingProjectIds.has(projectId)) {
      throw new Error('Project is being deleted.')
    }
    if (this.deletingSessionIds.has(sessionId)) {
      throw new Error('Session is being deleted.')
    }
  }

  shutdownAll(afterShutdown?: () => Promise<void>): Promise<{ reaped: boolean }> {
    if (this.shutdownAllPromise) {
      if (afterShutdown)
        return Promise.reject(
          new Error('Notebook shutdown is already in progress. Retry the settings change.')
        )
      return this.shutdownAllPromise
    }
    this.abortAllOperations(new Error('Notebook runtime is shutting down.'))
    const stop = (): Promise<{ reaped: boolean }> =>
      this.options.runtimeBindings.withGlobalTeardown(async () => {
        const result = await this.options.sessions.shutdownAll()
        if (afterShutdown) {
          if (!result.reaped)
            throw new Error(
              'Notebook processes could not be stopped. Folder policy was not changed.'
            )
          await afterShutdown()
        }
        return result
      })
    const shutdown = this.waitForSessionTeardown()
      .then(stop)
      .finally(() => {
        if (this.shutdownAllPromise === shutdown) this.shutdownAllPromise = undefined
      })
    this.shutdownAllPromise = shutdown
    return shutdown
  }

  dispose(): Promise<{ reaped: boolean }> {
    if (this.disposalPromise) return this.disposalPromise
    this.beginDisposal()
    const stop = (): Promise<{ reaped: boolean }> =>
      this.options.runtimeBindings.withGlobalTeardown(() => this.options.sessions.dispose())
    const disposal = this.waitForSessionTeardown().then(stop)
    this.disposalPromise = disposal
    return disposal
  }

  beginDisposal(): void {
    if (this.terminal) return
    this.terminal = true
    this.abortAllOperations(new Error('Notebook runtime is disposed.'))
  }

  private abortAllOperations(reason: Error): void {
    for (const controllers of this.operationAbortControllersByProject.values()) {
      for (const controller of controllers) controller.abort(reason)
    }
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

  notifyChanged(
    session: RuntimeSession,
    change?: Pick<NotebookChangedEvent, 'codeAppendOnly' | 'codeWriteOnly'>
  ): void {
    this.options.callbacks?.onNotebookChanged?.({
      ...this.options.toSessionReference(session),
      ...change
    })
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
      } else if (
        processKey === DEFAULT_KERNEL_PROCESS_KEY &&
        !session.hasAnyDurableKernelTermination()
      ) {
        // The coarse status represents only the default Python kernel. Persist its recovery from an
        // error, but never overwrite termination evidence owned by another exact target.
        await this.options.repository.updateKernelStatus({
          projectId: session.projectId,
          sessionId: session.sessionId,
          lane: session.lane,
          status
        })
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
    await session.retireKernelEpoch(processKey)
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
    await session.retireKernelEpoch(processKey)
    await this.persistKernelStatus(session, 'terminated', processKey)
    this.notifyChanged(session)
  }

  private async handleIdleShutdown(
    lane: NotebookLaneIdentity,
    kind: KernelProcessKind | undefined,
    env: string | undefined,
    generation: NotebookSessionExecutorGeneration,
    kernelEpochId?: string
  ): Promise<void> {
    const session = this.options.sessions.get(lane)
    if (!session) return
    const processKey = processKeyFor(kind, env)
    // Production callbacks carry their original process epoch. Legacy injected executors still
    // fence a callback queued behind another lifecycle projection to the epoch seen at arrival.
    const expectedEpochId = kernelEpochId ?? session.currentKernelEpochId(processKey)
    const projection = session.runExecutorLifecycleCallback(generation, async () => {
      if (session.currentKernelEpochId(processKey) !== expectedEpochId) return
      await this.projectKernelIdleShutdown(lane, kind, env)
    })
    session.blockKernelExecutionUntil(processKey, projection)
    await projection
  }

  private async handleTerminated(
    lane: NotebookLaneIdentity,
    kind: KernelProcessKind,
    env: string | undefined,
    generation: NotebookSessionExecutorGeneration,
    kernelEpochId?: string
  ): Promise<void> {
    const session = this.options.sessions.get(lane)
    if (!session) return
    const processKey = processKeyFor(kind, env)
    // Production callbacks carry their original process epoch. Legacy injected executors still
    // fence a callback queued behind another lifecycle projection to the epoch seen at arrival.
    const expectedEpochId = kernelEpochId ?? session.currentKernelEpochId(processKey)
    const projection = session.runExecutorLifecycleCallback(generation, async () => {
      if (session.currentKernelEpochId(processKey) !== expectedEpochId) return
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
