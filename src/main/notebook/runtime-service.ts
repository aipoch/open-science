import { randomUUID } from 'node:crypto'

import type {
  NotebookCell,
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  FinishNotebookCodeCellRequest,
  NotebookOutput,
  NotebookRunRecord,
  NotebookRunSource,
  NotebookRunStatus,
  NotebookRunSummary,
  NotebookSessionRequest,
  NotebookSessionReference,
  NotebookSessionState,
  RunNotebookCellRequest,
  NotebookWorkingFile,
  NotebookWriteLock
} from '../../shared/notebook'
import { NotebookPythonExecutor } from './python-executor'
import { NotebookRunRepository, getNotebookRunJsonPath, getRuntimeRoot } from './repository'
import { getAppClaudeConfigDir } from '../settings/provider-env'

type NotebookExecutionRequest = {
  code: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  // App-owned directories the kernel must not read (e.g. the CLAUDE_CONFIG_DIR with skill files).
  protectedDirs?: string[]
  timeoutMs?: number
  // Connector RPC connection injected into the kernel spawn env for host.mcp().
  mcpRpcEndpoint?: string
  mcpRpcToken?: string
}

type NotebookExecutionResult = {
  status: Extract<NotebookRunStatus, 'completed' | 'failed' | 'timeout'>
  stdout: string
  stderr: string
  traceback: string
  cwdAfter: string
  outputs: NotebookOutput[]
  workingFiles?: NotebookWorkingFile[]
}

type NotebookExecutor = {
  execute: (request: NotebookExecutionRequest) => Promise<NotebookExecutionResult>
  shutdown: () => Promise<void>
}

type NotebookRuntimeServiceCallbacks = {
  onNotebookAvailable?: (event: NotebookSessionReference) => void
  onNotebookChanged?: (event: NotebookSessionReference) => void
}

// The connector RPC endpoint/token injected into a kernel's spawn env for host.mcp(). The token is
// stable for the lifetime of the local RPC server that issues it, so resolving it again on every run
// is cheap and always yields the same value the already-spawned kernel captured at its own spawn time.
type McpRpcConnection = { endpoint: string; token: string }

type NotebookRuntimeServiceOptions = {
  storageRoot: string
  projectName: string
  repository?: NotebookRunRepository
  executorFactory?: (sessionId: string) => NotebookExecutor
  callbacks?: NotebookRuntimeServiceCallbacks
  // Resolves the connector RPC connection to inject into the kernel spawn env. Usually set after
  // construction via setMcpRpcConnectionResolver, since the RPC server is constructed with this
  // service as a dependency (constructing them in the other order would cycle).
  getMcpRpcConnection?: () => Promise<McpRpcConnection>
}

type RuntimeSession = {
  id: string
  sessionId: string
  projectName: string
  cwd: string
  notebookSessionRoot: string
  dataRoot: string
  runtimeRoot: string
  runJsonPath: string
  cells: NotebookCell[]
  activeWrite?: NotebookWriteLock
  activeRunId?: string
  executionCount: number
  executor: NotebookExecutor
}

// Builds the compact plain text output list shown in the preview panel.
const outputPlainText = (stdout: string, stderr: string): string[] =>
  [stdout, stderr].filter((text) => text.trim().length > 0)

// Turns unexpected executor exceptions into ordinary run results for the agent to inspect.
const errorToExecutionResult = (error: unknown, cwd: string): NotebookExecutionResult => {
  const message = error instanceof Error ? error.message : String(error)

  return {
    status: 'failed',
    stdout: '',
    stderr: message,
    traceback: message,
    cwdAfter: cwd,
    outputs: [
      {
        type: 'error',
        message,
        traceback: message
      }
    ]
  }
}

// Finds an editable in-memory cell or fails with a clear notebook-domain error.
const findCell = (session: RuntimeSession, cellId: string): NotebookCell => {
  const cell = session.cells.find((candidate) => candidate.id === cellId)

  if (!cell) {
    throw new Error(`Notebook cell not found: ${cellId}`)
  }

  return cell
}

// Coordinates notebook cells, shared interpreters, persisted run history, and UI notifications.
class NotebookRuntimeService {
  private readonly repository: NotebookRunRepository
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly announcedAgentSessionIds = new Set<string>()
  private runSequence = 0
  private mcpRpcConnectionResolver: (() => Promise<McpRpcConnection>) | undefined

  constructor(private readonly options: NotebookRuntimeServiceOptions) {
    this.repository = options.repository ?? new NotebookRunRepository(options.storageRoot)
    this.mcpRpcConnectionResolver = options.getMcpRpcConnection
  }

  // Wires the connector RPC connection lookup after construction (the local RPC server that provides
  // it is itself constructed with this service as a dependency, so it cannot be passed in up front).
  setMcpRpcConnectionResolver(resolver: () => Promise<McpRpcConnection>): void {
    this.mcpRpcConnectionResolver = resolver
  }

  // Starts an exclusive agent/user write stream into a cell and locks notebook editing.
  async beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    writeId: string
    status: NotebookCell['status']
  }> {
    const session = await this.ensureSession(request)

    if (session.activeWrite) {
      throw new Error(`Notebook cell is already receiving code: ${session.activeWrite.cellId}`)
    }

    const cellId = request.cellId ?? `cell-${randomUUID()}`
    let cell = session.cells.find((candidate) => candidate.id === cellId)

    // Existing cells are reused for explicit cell ids; new cells are appended for one-shot runs.
    if (!cell) {
      cell = {
        id: cellId,
        language: 'python',
        code: '',
        status: 'receiving-code'
      }
      session.cells.push(cell)
    } else {
      cell.status = 'receiving-code'
      cell.code = ''
    }

    const writeId = `write-${randomUUID()}`

    cell.writeId = writeId
    session.activeWrite = {
      writeId,
      cellId,
      source: request.source ?? 'agent',
      startedAt: Date.now()
    }

    this.notifyNotebookAvailable(session, session.activeWrite.source)
    this.notifyNotebookChanged(session)

    return { sessionId: session.sessionId, cellId, writeId, status: cell.status }
  }

  // Appends raw code text to the locked cell and streams the change to the preview.
  async appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    writeId: string
    receivedBytes: number
  }> {
    const session = await this.ensureSession(request)
    const cell = findCell(session, request.cellId)

    this.assertActiveWrite(session, request.writeId, request.cellId)
    cell.code += request.delta
    this.notifyNotebookChanged(session)

    return {
      sessionId: session.sessionId,
      cellId: cell.id,
      writeId: request.writeId,
      receivedBytes: Buffer.byteLength(cell.code, 'utf8')
    }
  }

  // Releases a write lock so the completed cell can be run by the same shared interpreter.
  async finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<{
    sessionId: string
    cellId: string
    code: string
    status: NotebookCell['status']
  }> {
    const session = await this.ensureSession(request)
    const cell = findCell(session, request.cellId)

    this.assertActiveWrite(session, request.writeId, request.cellId)
    session.activeWrite = undefined
    cell.writeId = undefined
    cell.status = 'idle'
    this.notifyNotebookChanged(session)

    return { sessionId: session.sessionId, cellId: cell.id, code: cell.code, status: cell.status }
  }

  // Persists a running run, executes the cell, then updates the same history entry with results.
  async runCell(request: RunNotebookCellRequest): Promise<NotebookRunSummary> {
    const session = await this.ensureSession(request)
    const cell = findCell(session, request.cellId)

    if (session.activeWrite?.cellId === cell.id) {
      throw new Error(`Notebook cell is still receiving code: ${cell.id}`)
    }

    this.notifyNotebookAvailable(session, request.source ?? 'agent')
    this.runSequence += 1
    session.executionCount += 1
    const runId = `notebook-run-${Date.now()}-${this.runSequence}`
    const startedAt = Date.now()
    const cwdBefore = session.cwd

    // Mark the cell as running before execution so the preview can show immediate progress.
    session.activeRunId = runId
    cell.status = 'running'
    cell.executionCount = session.executionCount
    cell.latestRunId = runId
    const runningRun: NotebookRunRecord = {
      runId,
      cellId: cell.id,
      source: request.source ?? 'agent',
      inputKind: request.inputKind ?? 'cell',
      script: cell.code,
      status: 'running',
      startedAt,
      cwdBefore,
      executionCount: session.executionCount,
      text: {
        stdout: '',
        stderr: '',
        traceback: '',
        plain: []
      },
      outputs: [],
      artifacts: [],
      workingFiles: []
    }

    // The initial history entry lets users see in-progress runs even before Python returns.
    await this.repository.appendRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      run: runningRun
    })
    this.notifyNotebookChanged(session)
    // Resolved fresh per run, but backed by the RPC server's cached start promise so it settles to the
    // same stable {endpoint, token} an already-spawned kernel captured at its own spawn time.
    const mcpRpc = await this.resolveMcpRpcConnection()
    // Every execution result, including errors, is normalized into data for agent analysis.
    const result = await session.executor
      .execute({
        code: cell.code,
        cwd: cwdBefore,
        notebookSessionRoot: session.notebookSessionRoot,
        dataRoot: session.dataRoot,
        runtimeRoot: session.runtimeRoot,
        protectedDirs: [getAppClaudeConfigDir(this.options.storageRoot)],
        timeoutMs: request.timeoutMs,
        mcpRpcEndpoint: mcpRpc?.endpoint,
        mcpRpcToken: mcpRpc?.token
      })
      .catch((error: unknown) => errorToExecutionResult(error, cwdBefore))
    // Replace the running record instead of appending so each run id has one durable entry.
    const completedRun: NotebookRunRecord = {
      ...runningRun,
      status: result.status,
      endedAt: Date.now(),
      cwdAfter: result.cwdAfter,
      text: {
        stdout: result.stdout,
        stderr: result.stderr,
        traceback: result.traceback,
        plain: outputPlainText(result.stdout, result.stderr)
      },
      outputs: [
        ...result.outputs,
        ...(result.traceback
          ? [
              {
                type: 'error' as const,
                traceback: result.traceback
              }
            ]
          : [])
      ],
      artifacts: [],
      workingFiles: result.workingFiles ?? []
    }
    const document = await this.repository.updateRun({
      projectName: session.projectName,
      sessionId: session.sessionId,
      run: completedRun
    })
    const run = document.runs.find((candidate) => candidate.runId === runId)

    if (!run) {
      throw new Error(`Notebook run not found after update: ${runId}`)
    }

    // The next run starts in whatever directory the shared interpreter ended in.
    session.cwd = result.cwdAfter
    session.activeRunId = undefined
    cell.status = result.status === 'completed' ? 'completed' : 'failed'
    this.notifyNotebookChanged(session)

    return this.toRunSummary(session, run)
  }

  // Convenience path used by the terminal and MCP to write a temporary cell and run it.
  async execute(request: ExecuteNotebookCodeRequest): Promise<NotebookRunSummary> {
    const begin = await this.beginCodeCell(request)

    await this.appendCodeCell({
      ...request,
      writeId: begin.writeId,
      cellId: begin.cellId,
      delta: request.code
    })
    await this.finishCodeCell({
      ...request,
      writeId: begin.writeId,
      cellId: begin.cellId
    })

    return this.runCell({
      ...request,
      cellId: begin.cellId
    })
  }

  // Returns the current in-memory cells plus the complete persisted run history.
  async state(request: NotebookSessionRequest): Promise<NotebookSessionState> {
    const session = await this.ensureSession(request)
    const document = await this.repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd
    })

    return {
      id: session.id,
      sessionId: session.sessionId,
      cwd: session.cwd,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      pythonPath: document.kernel.pythonPath,
      kernelStatus: document.kernel.lastKnownStatus,
      runJsonPath: session.runJsonPath,
      cells: [...session.cells],
      activeWrite: session.activeWrite,
      activeRunId: session.activeRunId,
      runs: document.runs,
      recentRuns: document.runs.slice(-20)
    }
  }

  // Resolves the durable reference for a session, preferring the live runtime session but falling
  // back to persisted run.json so notebook entries survive an app relaunch without re-running code.
  async getSessionReference(
    request: NotebookSessionRequest
  ): Promise<NotebookSessionReference | null> {
    const existing = this.sessions.get(request.sessionId)

    if (existing) {
      return this.toSessionReference(existing)
    }

    const projectName = request.projectName ?? this.options.projectName
    const document = await this.repository.findExisting(projectName, request.sessionId)

    if (!document) {
      return null
    }

    // Roots come from run.json normalization so a rehydrated entry matches the live one exactly.
    return {
      sessionId: request.sessionId,
      projectName,
      workspaceCwd: document.workspaceCwd,
      notebookSessionRoot: document.notebookSessionRoot,
      dataRoot: document.dataRoot,
      runtimeRoot: document.kernel.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(this.options.storageRoot, projectName, request.sessionId)
    }
  }

  // Replaces the interpreter process while preserving cells and durable run history.
  async restart(request: NotebookSessionRequest): Promise<NotebookSessionState> {
    const session = await this.ensureSession(request)

    await session.executor.shutdown()
    session.executor = this.createExecutor(session.sessionId)
    this.notifyNotebookChanged(session)

    return this.state(request)
  }

  // Shuts down one session executor and removes its in-memory routing state.
  async shutdown(
    request: NotebookSessionRequest
  ): Promise<{ sessionId: string; status: 'shutdown' }> {
    const session = this.sessions.get(request.sessionId)

    if (session) {
      await session.executor.shutdown()
      this.sessions.delete(request.sessionId)
    }

    return { sessionId: request.sessionId, status: 'shutdown' }
  }

  // Shuts down every live interpreter, used by app-level cleanup paths.
  async shutdownAll(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.values()).map((session) => session.executor.shutdown())
    )
    this.sessions.clear()
  }

  // Creates or returns the runtime session bound to an ACP/chat session id.
  private async ensureSession(request: NotebookSessionRequest): Promise<RuntimeSession> {
    const projectName = request.projectName ?? this.options.projectName
    const existing = this.sessions.get(request.sessionId)

    if (existing) {
      return existing
    }

    const document = await this.repository.loadOrCreate({
      projectName,
      sessionId: request.sessionId,
      workspaceCwd: request.workspaceCwd
    })
    // Runtime session roots come from run.json normalization so UI, MCP, and Python agree.
    const session: RuntimeSession = {
      id: `notebook-session-${request.sessionId}`,
      sessionId: request.sessionId,
      projectName,
      cwd: request.workspaceCwd,
      notebookSessionRoot: document.notebookSessionRoot,
      dataRoot: document.dataRoot,
      runtimeRoot: document.kernel.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(this.options.storageRoot, projectName, request.sessionId),
      cells: [],
      executionCount: document.runs.length,
      executor: this.createExecutor(request.sessionId)
    }

    this.sessions.set(request.sessionId, session)

    return session
  }

  // Builds the interpreter backend, allowing tests to inject a fake executor.
  private createExecutor(sessionId: string): NotebookExecutor {
    return this.options.executorFactory?.(sessionId) ?? new NotebookPythonExecutor()
  }

  // Best-effort lookup of the connector RPC connection: host.mcp() is unavailable (rather than the
  // whole cell failing) when no resolver is wired or the RPC server fails to start.
  private async resolveMcpRpcConnection(): Promise<McpRpcConnection | undefined> {
    if (!this.mcpRpcConnectionResolver) return undefined

    try {
      return await this.mcpRpcConnectionResolver()
    } catch {
      return undefined
    }
  }

  // Verifies that streamed writes are still targeting the currently locked cell.
  private assertActiveWrite(session: RuntimeSession, writeId: string, cellId: string): void {
    if (session.activeWrite?.writeId !== writeId || session.activeWrite.cellId !== cellId) {
      throw new Error('Notebook write lock is not active for this cell.')
    }
  }

  // Creates the small event payload used by renderer listeners and preview tabs.
  private toSessionReference(session: RuntimeSession): NotebookSessionReference {
    return {
      sessionId: session.sessionId,
      projectName: session.projectName,
      workspaceCwd: session.cwd,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      runJsonPath: session.runJsonPath
    }
  }

  // Announces notebook availability only once per agent-started session.
  private notifyNotebookAvailable(session: RuntimeSession, source: NotebookRunSource): void {
    if (source !== 'agent' || this.announcedAgentSessionIds.has(session.sessionId)) return

    this.announcedAgentSessionIds.add(session.sessionId)
    this.options.callbacks?.onNotebookAvailable?.(this.toSessionReference(session))
  }

  // Broadcasts state invalidation so the renderer can reload run.json and in-memory cell data.
  private notifyNotebookChanged(session: RuntimeSession): void {
    this.options.callbacks?.onNotebookChanged?.(this.toSessionReference(session))
  }

  // Adds notebook roots and kernel metadata to the run returned to MCP callers.
  private toRunSummary(session: RuntimeSession, run: NotebookRunRecord): NotebookRunSummary {
    return {
      ...run,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: getRuntimeRoot(this.options.storageRoot),
      kernelName: 'python3'
    }
  }
}

export { NotebookRuntimeService }
export type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookExecutor,
  NotebookRuntimeServiceCallbacks,
  NotebookRuntimeServiceOptions
}
