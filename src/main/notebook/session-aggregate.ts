import type {
  NotebookCell,
  NotebookEnvironmentManifest,
  NotebookKernelMetadata,
  NotebookLanguage,
  NotebookLiveEnvironmentOverlay,
  NotebookOutput,
  NotebookRunEnvironmentCapture,
  NotebookRunSource,
  NotebookRunStatus,
  NotebookWorkingFile,
  NotebookWriteLock
} from '../../shared/notebook'
import type { NotebookRuntimeBinding } from '../../shared/notebook-runtime'
import type { TrustedControlInvocationIdentity } from '../../shared/agents-contract'
import { notebookLaneScope, type NotebookLaneIdentity } from './lane-identity'

export type NotebookSessionResolvedInterpreter = {
  command: string
  args?: string[]
  condaPrefix?: string
}

export type NotebookSessionRuntimeBinding = NotebookRuntimeBinding & {
  resolvedInterpreter?: NotebookSessionResolvedInterpreter
  envName?: string
}

export type NotebookSessionExecutionRequest = {
  code: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  protectedDirs?: string[]
  timeoutMs?: number
  language?: NotebookLanguage
  environment?: string
  resolvedInterpreter?: NotebookSessionResolvedInterpreter
  kind?: 'repl'
  mcpRpcEndpoint?: string
  mcpRpcSocketPath?: string
  mcpRpcToken?: string
  sessionId?: string
  projectName?: string
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
  workingFiles?: NotebookWorkingFile[]
  environmentOverlay?: NotebookLiveEnvironmentOverlay
  environmentCapture?: NotebookRunEnvironmentCapture
  environmentManifest?: NotebookEnvironmentManifest
  environmentManifestChecksum?: string
}

export type NotebookSessionExecutor<
  Request = NotebookSessionExecutionRequest,
  Result = NotebookSessionExecutionResult
> = {
  execute: (request: Request) => Promise<Result>
  shutdown: () => Promise<{ reaped: boolean }>
  restart?: () => Promise<void>
  terminate?: (kind: 'python' | 'r' | 'repl', env: string) => Promise<void>
}

export type NotebookSessionExecutorGeneration = symbol

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
  release?: () => void
}

export type NotebookSessionAggregateInit<
  Request = NotebookSessionExecutionRequest,
  Result = NotebookSessionExecutionResult
> = {
  sessionId: string
  projectName: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  runJsonPath: string
  executionCount: number
  executor: NotebookSessionExecutor<Request, Result>
  executorGeneration: NotebookSessionExecutorGeneration
  lane: NotebookLaneIdentity
}

export type NotebookSessionSnapshot = Readonly<{
  id: string
  sessionId: string
  projectName: string
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
  readonly projectName: string
  readonly notebookSessionRoot: string
  readonly dataRoot: string
  readonly runtimeRoot: string
  readonly runJsonPath: string
  readonly lane: NotebookLaneIdentity

  private cwdValue: string
  private readonly cells = new Map<string, NotebookCell>()
  private activeWriteValue: NotebookWriteLock | undefined
  private activeRunIdValue: string | undefined
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
  private readonly runtimeBindings = new Map<NotebookLanguage, NotebookSessionRuntimeBinding>()
  private readonly forceStoppedKeys = new Set<string>()

  constructor(init: NotebookSessionAggregateInit<Request, Result>) {
    this.id = `notebook-session-${init.sessionId}`
    this.sessionId = init.sessionId
    this.projectName = init.projectName
    this.cwdValue = init.cwd
    this.notebookSessionRoot = init.notebookSessionRoot
    this.dataRoot = init.dataRoot
    this.runtimeRoot = init.runtimeRoot
    this.runJsonPath = init.runJsonPath
    this.lane = init.lane
    notebookLaneScope(this.lane)
    this.executionCountValue = init.executionCount
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
      projectName: this.projectName,
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

  beginCellWrite(input: BeginCellWrite): Readonly<NotebookCell> {
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
    return cloneCell(cell)
  }

  appendCellCode(cellId: string, writeId: string, delta: string): Readonly<NotebookCell> {
    const cell = this.requireCell(cellId)
    this.assertActiveWrite(writeId, cellId)
    cell.code += delta
    return cloneCell(cell)
  }

  finishCellWrite(cellId: string, writeId: string): Readonly<NotebookCell> {
    const cell = this.requireCell(cellId)
    this.assertActiveWrite(writeId, cellId)
    this.activeWriteValue = undefined
    cell.writeId = undefined
    cell.status = 'idle'
    return cloneCell(cell)
  }

  cellView(cellId: string): Readonly<NotebookCell> {
    return this.requireCell(cellId)
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
    this.activeRunIdValue = runId
    cell.status = 'running'
    cell.executionCount = executionCount
    cell.latestRunId = runId
  }

  completeCellRun(
    cellId: string,
    status: NotebookSessionExecutionResult['status'],
    cwdAfter: string
  ): void {
    const cell = this.requireCell(cellId)
    this.cwdValue = cwdAfter
    this.activeRunIdValue = undefined
    cell.status = status === 'completed' ? 'completed' : 'failed'
  }

  hasActiveRun(): boolean {
    return this.activeRunIdValue !== undefined
  }

  enqueueExecution<T>(processKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.executionQueues.get(processKey) ?? Promise.resolve()
    const run = previous.then(task)
    this.executionQueues.set(
      processKey,
      run.catch(() => undefined)
    )
    return run
  }

  async drainExecution(processKey: string): Promise<void> {
    await (this.executionQueues.get(processKey) ?? Promise.resolve()).catch(() => undefined)
  }

  enqueueControl<T>(task: () => Promise<T>): Promise<T> {
    const run = this.controlQueue.then(task)
    this.controlQueue = run.catch(() => undefined)
    return run
  }

  clearProcessState(processKey: string): void {
    this.kernelStatuses.delete(processKey)
    this.terminatedKernels.delete(processKey)
    this.executionQueues.delete(processKey)
  }

  kernelStatus(processKey: string): NotebookKernelMetadata['lastKnownStatus'] | undefined {
    return this.kernelStatuses.get(processKey)
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
    return this.executorValue.terminate?.(kind, env) ?? Promise.resolve()
  }

  async restartExecutor(
    replacement: () => NotebookSessionOwnedExecutor<Request, Result>
  ): Promise<void> {
    if (this.executorValue.restart) {
      await this.executorValue.restart()
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
  }

  shutdownExecutor(): Promise<{ reaped: boolean }> {
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
        }) => Promise<NotebookSessionMcpRpcConnection>)
      | undefined
  ): Promise<NotebookSessionMcpRpcConnection | undefined> {
    if (this.mcpRpcConnection) return this.mcpRpcConnection
    if (!resolver) return undefined
    try {
      const lane = notebookLaneScope(this.lane)
      this.mcpRpcConnection = await resolver({
        sessionId: this.sessionId,
        projectId: this.projectName,
        agentFrameId: lane.agentFrameId,
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
