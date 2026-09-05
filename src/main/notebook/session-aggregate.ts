import { randomUUID } from 'node:crypto'

import type {
  NotebookCell,
  NotebookEnvironmentManifest,
  NotebookHelperModuleEvidence,
  NotebookHelperEvidenceStatus,
  NotebookKernelInstanceIdentity,
  NotebookKernelMetadata,
  NotebookLanguage,
  NotebookLiveEnvironmentOverlay,
  NotebookNamespaceVariable,
  NotebookOutput,
  NotebookRunEnvironmentCapture,
  NotebookRunSource,
  NotebookRunStatus,
  NotebookWorkingFile,
  NotebookWriteLock
} from '../../shared/notebook'
import type { ExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
import type { NotebookRuntimeBinding } from '../../shared/notebook-runtime'
import type { TrustedControlInvocationIdentity } from '../../shared/agents-contract'
import type { TransientViewImage } from './host-view-image-service'
import { resolveProjectId, type ProjectIdScope } from '../../shared/project-scope'
import { notebookLaneScope, type NotebookLaneIdentity } from './lane-identity'
import type { NotebookHelperModuleInjection } from './helper-module-host'

export type NotebookSessionResolvedInterpreter = {
  command: string
  args?: string[]
  condaPrefix?: string
}

export const notebookInterpreterIdentity = (
  interpreter: NotebookSessionResolvedInterpreter | undefined
): string =>
  interpreter
    ? [interpreter.command, ...(interpreter.args ?? []), interpreter.condaPrefix ?? ''].join('\n')
    : ''

export type NotebookSessionRuntimeBinding = NotebookRuntimeBinding & {
  resolvedInterpreter?: NotebookSessionResolvedInterpreter
  envName?: string
}

export type NotebookSessionExecutionRequest = {
  // App-owned identity used to seal per-run file evidence. Optional keeps injected executors and
  // direct tests source-compatible; production execution always supplies it.
  runId?: string
  code: string
  helperModules?: readonly NotebookHelperModuleInjection[]
  cwd: string
  notebookSessionRoot: string
  inputRoot?: string
  dataRoot: string
  fileEvidenceStorageRoot?: string
  fileEvidenceRoot?: string
  fileEvidenceStoragePrefix?: string
  runtimeRoot: string
  protectedDirs?: string[]
  timeoutMs?: number
  signal?: AbortSignal
  language?: NotebookLanguage
  environment?: string
  resolvedInterpreter?: NotebookSessionResolvedInterpreter
  kind?: 'repl'
  mcpRpcEndpoint?: string
  mcpRpcSocketPath?: string
  mcpRpcToken?: string
  sessionId?: string
  projectId?: string
  inputRunLeaseId?: string
  // Opaque per-control invocation identity forwarded through the REPL request frame. It binds a
  // host.agents.switch approval to this exact outer repl_execute completion.
  controlInvocationId?: string
}

export type NotebookSessionExecutionResult = {
  status: Extract<NotebookRunStatus, 'completed' | 'failed' | 'timeout' | 'cancelled'>
  stdout: string
  stderr: string
  traceback: string
  cwdAfter: string
  outputs: NotebookOutput[]
  truncated?: boolean
  workingFiles?: NotebookWorkingFile[]
  fileEvidence?: ExecutionFileEvidenceSummary
  environmentOverlay?: NotebookLiveEnvironmentOverlay
  environmentCapture?: NotebookRunEnvironmentCapture
  environmentManifest?: NotebookEnvironmentManifest
  environmentManifestChecksum?: string
  // Internal execution evidence persisted onto data runs. Optional keeps injected/legacy executors
  // source-compatible; the execution owner treats a missing value after dispatch conservatively.
  kernelDispatched?: boolean
  // Exact helper initializations acknowledged by the persistent loop before producer dispatch.
  // The host uses this even when the producer later fails, so same-epoch retries stay idempotent.
  helperModulesInitialized?: readonly string[]
  helperModules?: NotebookHelperModuleEvidence[]
  helperEvidenceStatus?: NotebookHelperEvidenceStatus
}

export type NotebookSessionNamespaceRequest = {
  language: NotebookLanguage
  environment: string
  includePrivate?: boolean
}

export type NotebookSessionNamespaceResult =
  | {
      status: 'available'
      variableCount: number
      variablesTruncated: boolean
      variables: NotebookNamespaceVariable[]
    }
  | { status: 'unavailable' }

export type NotebookSessionExecutor<
  Request = NotebookSessionExecutionRequest,
  Result = NotebookSessionExecutionResult
> = {
  execute: (request: Request) => Promise<Result>
  inspectNamespace?: (
    request: NotebookSessionNamespaceRequest
  ) => Promise<NotebookSessionNamespaceResult>
  shutdown: () => Promise<{ reaped: boolean }>
  restart?: () => Promise<void>
  terminate?: (kind: 'python' | 'r' | 'repl', env: string) => Promise<void>
}

export type NotebookSessionExecutorGeneration = symbol

// Stable object identity owned by the Aggregate for exactly one concrete process epoch. Host-owned
// kernel extensions key their volatile state by this object, so retiring a process cannot accidentally
// reuse loaded state even if a caller retains the printable UUID.
export type NotebookKernelEpochOwnership = Readonly<{
  id: string
  processKey: string
}>

type NotebookKernelEpochSlot = {
  ownership: NotebookKernelEpochOwnership
  interpreterIdentity?: string
}

export type NotebookSessionOwnedExecutor<
  Request = NotebookSessionExecutionRequest,
  Result = NotebookSessionExecutionResult
> = {
  executor: NotebookSessionExecutor<Request, Result>
  generation: NotebookSessionExecutorGeneration
}

export type NotebookSessionMcpRpcConnection = {
  endpoint: string
  socketPath?: string
  token: string
  beginControlInvocation?: (context: TrustedControlInvocationIdentity) => () => void
  completeControlInvocation?: (
    controlInvocationId: string
  ) => Promise<readonly TransientViewImage[]>
  discardControlInvocation?: (controlInvocationId: string) => void
  release?: () => void
}

export type NotebookSessionAggregateInit<
  Request = NotebookSessionExecutionRequest,
  Result = NotebookSessionExecutionResult
> = ProjectIdScope & {
  sessionId: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  runJsonPath: string
  executionCount: number
  initialKernelStatus?: NotebookKernelMetadata['lastKnownStatus']
  initialTerminatedKernelInstances?: readonly NotebookKernelInstanceIdentity[]
  executor: NotebookSessionExecutor<Request, Result>
  executorGeneration: NotebookSessionExecutorGeneration
  lane: NotebookLaneIdentity
}

export type NotebookSessionSnapshot = Readonly<{
  id: string
  sessionId: string
  projectId: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  runJsonPath: string
  cells: ReadonlyArray<Readonly<NotebookCell>>
  activeWrite?: Readonly<NotebookWriteLock>
  activeRunId?: string
  executionCount: number
  kernelStatuses: ReadonlyArray<readonly [string, NotebookKernelMetadata['lastKnownStatus']]>
}>

type BeginCellWrite = {
  cellId: string
  language: NotebookLanguage
  writeId: string
  source: NotebookRunSource
  startedAt: number
}

const cloneCell = (cell: NotebookCell): NotebookCell => ({ ...cell })

const cloneBinding = (binding: NotebookSessionRuntimeBinding): NotebookSessionRuntimeBinding => ({
  ...binding,
  resolvedInterpreter: binding.resolvedInterpreter
    ? { ...binding.resolvedInterpreter, args: binding.resolvedInterpreter.args?.slice() }
    : undefined
})

export class NotebookSessionAggregate<
  Request = NotebookSessionExecutionRequest,
  Result = NotebookSessionExecutionResult
> {
  readonly id: string
  readonly sessionId: string
  readonly projectId: string
  readonly notebookSessionRoot: string
  readonly dataRoot: string
  readonly runtimeRoot: string
  readonly runJsonPath: string
  readonly lane: NotebookLaneIdentity

  private cwdValue: string
  private readonly cells = new Map<string, NotebookCell>()
  private writeCancellationCleanup: (() => void) | undefined
  private readonly cellExecutions = new Map<string, number>()
  private activeWriteValue: NotebookWriteLock | undefined
  private readonly activeRunIds = new Set<string>()
  private activeRunIdValue: string | undefined
  private cwdOwnerRunId: string | undefined
  private executionCountValue: number
  private executorValue: NotebookSessionExecutor<Request, Result>
  private executorGenerationValue: NotebookSessionExecutorGeneration
  private executorGenerationActive = true
  // Serializes lifecycle callback commits with executor teardown. Teardown synchronously closes
  // admission, then drains the callbacks that already proved ownership before replacing/removing the
  // executor, so their persistence cannot land on a successor.
  private executorLifecycleQueue: Promise<void> = Promise.resolve()
  private readonly executionQueues = new Map<string, Promise<unknown>>()
  private controlQueue: Promise<unknown> = Promise.resolve()
  private mcpRpcConnection: NotebookSessionMcpRpcConnection | undefined
  private readonly terminatedKernels = new Set<string>()
  private readonly kernelStatuses = new Map<string, NotebookKernelMetadata['lastKnownStatus']>()
  private readonly restoredKernelStatusValue?: NotebookKernelMetadata['lastKnownStatus']
  private readonly durableTerminatedKernelKeys = new Set<string>()
  private durableUnknownKernelTermination: boolean
  private readonly runtimeBindings = new Map<NotebookLanguage, NotebookSessionRuntimeBinding>()
  private readonly forceStoppedKeys = new Set<string>()
  private readonly kernelEpochs = new Map<string, NotebookKernelEpochSlot>()

  constructor(init: NotebookSessionAggregateInit<Request, Result>) {
    this.id = `notebook-session-${init.sessionId}`
    this.sessionId = init.sessionId
    this.projectId = resolveProjectId(init)
    this.cwdValue = init.cwd
    this.notebookSessionRoot = init.notebookSessionRoot
    this.dataRoot = init.dataRoot
    this.runtimeRoot = init.runtimeRoot
    this.runJsonPath = init.runJsonPath
    this.lane = init.lane
    notebookLaneScope(this.lane)
    this.executionCountValue = init.executionCount
    for (const instance of init.initialTerminatedKernelInstances ?? []) {
      this.durableTerminatedKernelKeys.add(
        instance.kind === 'repl' ? 'repl' : `${instance.kind}:${instance.environment}`
      )
    }
    this.durableUnknownKernelTermination =
      init.initialKernelStatus === 'terminated' &&
      init.initialTerminatedKernelInstances === undefined
    this.restoredKernelStatusValue = init.initialKernelStatus
    this.executorValue = init.executor
    this.executorGenerationValue = init.executorGeneration
  }

  get cwd(): string {
    return this.cwdValue
  }

  snapshot(): NotebookSessionSnapshot {
    return {
      id: this.id,
      sessionId: this.sessionId,
      projectId: this.projectId,
      cwd: this.cwdValue,
      notebookSessionRoot: this.notebookSessionRoot,
      dataRoot: this.dataRoot,
      runtimeRoot: this.runtimeRoot,
      runJsonPath: this.runJsonPath,
      cells: Array.from(this.cells.values(), cloneCell),
      activeWrite: this.activeWriteValue ? { ...this.activeWriteValue } : undefined,
      activeRunId: this.activeRunIdValue,
      executionCount: this.executionCountValue,
      kernelStatuses: Array.from(
        this.kernelStatuses.entries(),
        ([key, status]) => [key, status] as const
      )
    }
  }

  beginCellWrite(
    input: BeginCellWrite,
    cancellation?: { signal: AbortSignal; onAbort: () => void }
  ): Readonly<NotebookCell> {
    cancellation?.signal.throwIfAborted()
    if (this.cellExecutions.has(input.cellId)) {
      throw new Error(`Notebook cell is queued or running: ${input.cellId}`)
    }
    if (this.activeWriteValue) {
      throw new Error(`Notebook cell is already receiving code: ${this.activeWriteValue.cellId}`)
    }

    const existing = this.cells.get(input.cellId)
    const cell: NotebookCell = existing ?? {
      id: input.cellId,
      language: input.language,
      code: '',
      status: 'receiving-code'
    }
    cell.status = 'receiving-code'
    cell.code = ''
    cell.writeId = input.writeId
    this.cells.set(input.cellId, cell)
    this.activeWriteValue = {
      writeId: input.writeId,
      cellId: input.cellId,
      source: input.source,
      startedAt: input.startedAt
    }
    if (cancellation) {
      const abort = (): void => {
        this.abortCellWrite(input.cellId, input.writeId)
        cancellation.onAbort()
      }
      cancellation.signal.addEventListener('abort', abort, { once: true })
      this.writeCancellationCleanup = () => cancellation.signal.removeEventListener('abort', abort)
    }
    return cloneCell(cell)
  }

  appendCellCode(cellId: string, writeId: string, delta: string): Readonly<NotebookCell> {
    const cell = this.requireCell(cellId)
    this.assertActiveWrite(writeId, cellId)
    cell.code += delta
    return cloneCell(cell)
  }

  abortCellWrite(cellId: string, writeId: string): Readonly<NotebookCell> {
    const cell = this.requireCell(cellId)
    this.assertActiveWrite(writeId, cellId)
    this.writeCancellationCleanup?.()
    this.writeCancellationCleanup = undefined
    this.activeWriteValue = undefined
    cell.writeId = undefined
    cell.code = ''
    cell.status = 'idle'
    return cloneCell(cell)
  }

  finishCellWrite(cellId: string, writeId: string): Readonly<NotebookCell> {
    const cell = this.requireCell(cellId)
    this.assertActiveWrite(writeId, cellId)
    this.writeCancellationCleanup?.()
    this.writeCancellationCleanup = undefined
    this.activeWriteValue = undefined
    cell.writeId = undefined
    cell.status = 'idle'
    return cloneCell(cell)
  }

  cellView(cellId: string): Readonly<NotebookCell> {
    return cloneCell(this.requireCell(cellId))
  }

  // Hold editing from admission through queueing and settlement. Count submissions so repeated
  // runs of the same cell retain the write restriction until the last one settles or is cancelled.
  async withCellExecution<T>(
    cellId: string,
    execute: (cell: Readonly<NotebookCell>) => Promise<T>
  ): Promise<T> {
    const cell = this.cellView(cellId)
    if (this.isCellReceiving(cellId)) {
      throw new Error(`Notebook cell is still receiving code: ${cellId}`)
    }
    this.cellExecutions.set(cellId, (this.cellExecutions.get(cellId) ?? 0) + 1)
    try {
      return await execute(cell)
    } finally {
      const remaining = this.cellExecutions.get(cellId)! - 1
      if (remaining === 0) this.cellExecutions.delete(cellId)
      else this.cellExecutions.set(cellId, remaining)
    }
  }

  isCellReceiving(cellId: string): boolean {
    return this.activeWriteValue?.cellId === cellId
  }

  nextExecutionCount(): number {
    this.executionCountValue += 1
    return this.executionCountValue
  }

  markCellRunning(cellId: string, runId: string, executionCount: number): void {
    const cell = this.requireCell(cellId)
    this.activeRunIds.add(runId)
    this.activeRunIdValue = runId
    this.cwdOwnerRunId = runId
    cell.status = 'running'
    cell.executionCount = executionCount
    cell.latestRunId = runId
  }

  completeCellRun(
    cellId: string,
    status: Exclude<NotebookRunStatus, 'queued' | 'running'>,
    cwdAfter: string
  ): void {
    const cell = this.requireCell(cellId)
    const runId = cell.latestRunId
    if (runId) {
      this.activeRunIds.delete(runId)
      if (this.cwdOwnerRunId === runId) this.cwdValue = cwdAfter
      if (this.activeRunIdValue === runId) {
        this.activeRunIdValue = Array.from(this.activeRunIds).at(-1)
      }
    }
    cell.status = status
  }

  hasActiveRun(): boolean {
    return this.activeRunIds.size > 0
  }

  enqueueExecution<T>(
    processKey: string,
    task: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const previous = this.executionQueues.get(processKey) ?? Promise.resolve()
    if (!signal) {
      const run = previous.then(task)
      this.executionQueues.set(
        processKey,
        run.catch(() => undefined)
      )
      return run
    }

    signal.throwIfAborted()
    let started = false
    let resolveResult!: (result: T | PromiseLike<T>) => void
    let rejectResult!: (reason?: unknown) => void
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const onAbort = (): void => {
      if (!started) rejectResult(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const run = previous.then(async () => {
      if (signal.aborted) return
      started = true
      signal.removeEventListener('abort', onAbort)
      try {
        resolveResult(await task())
      } catch (error) {
        rejectResult(error)
      }
    })
    this.executionQueues.set(
      processKey,
      run.catch(() => undefined)
    )
    return result
  }

  async drainExecution(processKey: string): Promise<void> {
    await (this.executionQueues.get(processKey) ?? Promise.resolve()).catch(() => undefined)
  }

  enqueueControl<T>(task: () => Promise<T>): Promise<T> {
    const run = this.controlQueue.then(task)
    this.controlQueue = run.catch(() => undefined)
    return run
  }

  // Reserves the next execution turn behind an executor lifecycle projection without making the
  // current execution wait on its own queue tail. This matters for onTerminated callbacks fired from
  // inside execute(): the callback may be awaited by an injected executor, while later work must not
  // start until its durable kernel-state transition settles.
  blockKernelExecutionUntil(processKey: string, transition: Promise<unknown>): void {
    const current =
      processKey === 'repl'
        ? this.controlQueue
        : (this.executionQueues.get(processKey) ?? Promise.resolve())
    const barrier = Promise.all([current, transition]).then(
      () => undefined,
      () => undefined
    )
    if (processKey === 'repl') this.controlQueue = barrier
    else this.executionQueues.set(processKey, barrier)
  }

  clearProcessState(processKey: string): void {
    this.kernelStatuses.delete(processKey)
    this.terminatedKernels.delete(processKey)
    this.executionQueues.delete(processKey)
    this.kernelEpochs.delete(processKey)
  }

  kernelStatus(processKey: string): NotebookKernelMetadata['lastKnownStatus'] | undefined {
    return this.kernelStatuses.get(processKey)
  }

  restoredKernelStatus(): NotebookKernelMetadata['lastKnownStatus'] | undefined {
    return this.restoredKernelStatusValue
  }

  kernelStatusEntries(): Array<[string, NotebookKernelMetadata['lastKnownStatus']]> {
    return Array.from(this.kernelStatuses.entries())
  }

  kernelProcessKeys(): string[] {
    return Array.from(this.kernelStatuses.keys())
  }

  setKernelStatus(processKey: string, status: NotebookKernelMetadata['lastKnownStatus']): void {
    this.kernelStatuses.set(processKey, status)
  }

  markKernelTerminated(processKey: string): void {
    this.terminatedKernels.add(processKey)
  }

  clearKernelTerminated(processKey: string): void {
    this.terminatedKernels.delete(processKey)
  }

  isKernelTerminated(processKey: string): boolean {
    return this.terminatedKernels.has(processKey)
  }

  hasDurableKernelTermination(processKey: string): boolean {
    return this.durableTerminatedKernelKeys.has(processKey)
  }

  hasAnyDurableKernelTermination(): boolean {
    return this.durableUnknownKernelTermination || this.durableTerminatedKernelKeys.size > 0
  }

  markDurableKernelTermination(processKey: string): void {
    this.durableTerminatedKernelKeys.add(processKey)
  }

  clearDurableKernelTermination(processKey: string): void {
    this.durableTerminatedKernelKeys.delete(processKey)
  }

  hasUnknownDurableKernelTermination(): boolean {
    return this.durableUnknownKernelTermination
  }

  clearAllDurableKernelTerminations(): void {
    this.durableTerminatedKernelKeys.clear()
    this.durableUnknownKernelTermination = false
  }

  runtimeBinding(language: NotebookLanguage): NotebookSessionRuntimeBinding | undefined {
    const binding = this.runtimeBindings.get(language)
    return binding ? cloneBinding(binding) : undefined
  }

  setRuntimeBinding(language: NotebookLanguage, binding: NotebookSessionRuntimeBinding): void {
    this.runtimeBindings.set(language, cloneBinding(binding))
  }

  runtimeBindingEntries(): Array<[NotebookLanguage, NotebookSessionRuntimeBinding]> {
    return Array.from(this.runtimeBindings, ([language, binding]) => [
      language,
      cloneBinding(binding)
    ])
  }

  markForceStopped(processKey: string): void {
    this.forceStoppedKeys.add(processKey)
  }

  consumeForceStopped(processKey: string): boolean {
    return this.forceStoppedKeys.delete(processKey)
  }

  execute(request: Request): Promise<Result> {
    return this.executorValue.execute(request)
  }

  inspectNamespace(
    request: NotebookSessionNamespaceRequest
  ): Promise<NotebookSessionNamespaceResult> {
    return (
      this.executorValue.inspectNamespace?.(request) ?? Promise.resolve({ status: 'unavailable' })
    )
  }

  kernelEpochId(processKey: string, reset = false): string {
    return this.kernelEpoch(processKey, reset).id
  }

  kernelEpoch(
    processKey: string,
    reset = false,
    interpreterIdentity?: string
  ): NotebookKernelEpochOwnership {
    if (reset) this.kernelEpochs.delete(processKey)
    const existing = this.kernelEpochs.get(processKey)
    if (existing) {
      if (interpreterIdentity === undefined) return existing.ownership
      if (existing.interpreterIdentity === undefined) {
        existing.interpreterIdentity = interpreterIdentity
        return existing.ownership
      }
      if (existing.interpreterIdentity === interpreterIdentity) return existing.ownership
    }
    const ownership = { id: randomUUID(), processKey }
    this.kernelEpochs.set(processKey, { ownership, interpreterIdentity })
    return ownership
  }

  currentKernelEpochId(processKey: string): string | undefined {
    return this.kernelEpochs.get(processKey)?.ownership.id
  }

  retireKernelEpoch(processKey: string): void {
    this.kernelEpochs.delete(processKey)
  }

  ownsExecutorGeneration(generation: NotebookSessionExecutorGeneration): boolean {
    return this.executorGenerationActive && this.executorGenerationValue === generation
  }

  // Commits one executor-owned callback only while its generation still owns this Aggregate. A stale
  // callback still joins the queue, but resolves as a no-op before it can mutate, persist, or notify.
  runExecutorLifecycleCallback<T>(
    generation: NotebookSessionExecutorGeneration,
    callback: () => Promise<T>
  ): Promise<T | undefined> {
    const run = this.executorLifecycleQueue.then(() => {
      if (!this.ownsExecutorGeneration(generation)) return undefined
      return callback()
    })
    this.executorLifecycleQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  terminateExecutor(kind: 'python' | 'r' | 'repl', env: string): Promise<void> {
    const processKey = kind === 'repl' ? 'repl' : `${kind}:${env}`
    return (this.executorValue.terminate?.(kind, env) ?? Promise.resolve()).then(() => {
      this.kernelEpochs.delete(processKey)
    })
  }

  async restartExecutor(
    replacement: () => NotebookSessionOwnedExecutor<Request, Result>
  ): Promise<void> {
    if (this.executorValue.restart) {
      await this.executorValue.restart()
      this.kernelEpochs.clear()
      return
    }
    this.executorGenerationActive = false
    const lifecycleDrain = this.executorLifecycleQueue
    await lifecycleDrain
    await this.executorValue.shutdown()
    const next = replacement()
    this.executorValue = next.executor
    this.executorGenerationValue = next.generation
    this.executorGenerationActive = true
    this.kernelEpochs.clear()
  }

  shutdownExecutor(): Promise<{ reaped: boolean }> {
    if (this.activeWriteValue) {
      this.abortCellWrite(this.activeWriteValue.cellId, this.activeWriteValue.writeId)
    }
    const executor = this.executorValue
    this.executorGenerationActive = false
    const lifecycleDrain = this.executorLifecycleQueue
    return lifecycleDrain.then(() => executor.shutdown())
  }

  async resolveMcpRpcConnection(
    resolver:
      | ((binding: {
          sessionId: string
          projectId: string
          agentFrameId: string
          attemptId?: string
          executionCwd: string
        }) => Promise<NotebookSessionMcpRpcConnection>)
      | undefined
  ): Promise<NotebookSessionMcpRpcConnection | undefined> {
    if (this.mcpRpcConnection) return this.mcpRpcConnection
    if (!resolver) return undefined
    try {
      const lane = notebookLaneScope(this.lane)
      this.mcpRpcConnection = await resolver({
        sessionId: this.sessionId,
        projectId: this.projectId,
        agentFrameId: lane.agentFrameId,
        executionCwd: this.dataRoot,
        ...(lane.attemptId ? { attemptId: lane.attemptId } : {})
      })
      return this.mcpRpcConnection
    } catch {
      return undefined
    }
  }

  releaseMcpRpcConnection(): void {
    const connection = this.mcpRpcConnection
    this.mcpRpcConnection = undefined
    connection?.release?.()
  }

  completeControlInvocation(controlInvocationId: string): Promise<readonly TransientViewImage[]> {
    return (
      this.mcpRpcConnection?.completeControlInvocation?.(controlInvocationId) ?? Promise.resolve([])
    )
  }

  discardControlInvocation(controlInvocationId: string): void {
    this.mcpRpcConnection?.discardControlInvocation?.(controlInvocationId)
  }

  private requireCell(cellId: string): NotebookCell {
    const cell = this.cells.get(cellId)
    if (!cell) throw new Error(`Notebook cell not found: ${cellId}`)
    return cell
  }

  private assertActiveWrite(writeId: string, cellId: string): void {
    if (this.activeWriteValue?.writeId !== writeId || this.activeWriteValue.cellId !== cellId) {
      throw new Error('Notebook write lock is not active for this cell.')
    }
  }
}
