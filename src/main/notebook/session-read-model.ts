import type {
  NotebookCell,
  NotebookEnvironmentStatus,
  NotebookKernelMetadata,
  NotebookLanguage,
  NotebookRunRecord,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionState
} from '../../shared/notebook'
import type { NotebookRuntimeBinding, NotebookRuntimeBindings } from '../../shared/notebook-runtime'
import {
  getNotebookDataRoot,
  getNotebookRunJsonPath,
  getNotebookSessionRoot,
  getRuntimeRoot,
  NotebookRunRepository
} from './repository'
import type { NotebookSessionSnapshot } from './session-aggregate'
import type { NotebookLaneIdentity } from './lane-identity'

type NotebookHandoffContext = {
  activeRunId?: string
  activeWriteCellId?: string
  executionCount: number
  cells: Array<{
    id: string
    language: NotebookLanguage
    status: NotebookCell['status']
    executionCount?: number
    latestRunId?: string
  }>
  kernels: Array<{
    kind: NotebookLanguage | 'repl'
    status: NotebookKernelMetadata['lastKnownStatus']
  }>
  runtimes: Array<{
    language: NotebookLanguage
    label: string
    version?: string
    status?: NotebookRuntimeBinding['status']
    reason?: NotebookRuntimeBinding['reason']
  }>
}

type NotebookSessionReadSource = {
  readonly id: string
  readonly sessionId: string
  readonly projectName: string
  readonly cwd: string
  readonly notebookSessionRoot: string
  readonly dataRoot: string
  readonly runtimeRoot: string
  readonly runJsonPath: string
  readonly lane: NotebookLaneIdentity
  snapshot: () => NotebookSessionSnapshot
  kernelStatusEntries: () => Array<[string, NotebookKernelMetadata['lastKnownStatus']]>
  runtimeBindingEntries: () => Array<[NotebookLanguage, NotebookRuntimeBinding]>
}

type NotebookSessionReadModelOptions<Session extends NotebookSessionReadSource> = {
  storageRoot: string
  defaultProjectName: string
  repository: NotebookRunRepository
  findSession: (sessionId: string) => Session | undefined
  runtimeBindings: (session: Session) => NotebookRuntimeBindings
  isRestartRecommended: (processKey: string) => boolean
}

// Projects live Session Aggregate state and durable run history without owning either source.
class NotebookSessionReadModel<Session extends NotebookSessionReadSource> {
  constructor(private readonly options: NotebookSessionReadModelOptions<Session>) {}

  // A handoff peek must never create a Session or read disk: absent/non-actionable live state is absent.
  peekHandoffContext(sessionId: string): NotebookHandoffContext | undefined {
    const session = this.options.findSession(sessionId)
    if (!session) return undefined

    const snapshot = session.snapshot()
    const kernels: NotebookHandoffContext['kernels'] = snapshot.kernelStatuses
      .filter(([, status]) => status !== 'terminated')
      .slice(-6)
      .map(([processKey, status]) => ({
        kind: processKey === 'repl' ? 'repl' : processKey.startsWith('r:') ? 'r' : 'python',
        status
      }))
    const runtimes = session
      .runtimeBindingEntries()
      .slice(-4)
      .map(([language, binding]) => ({
        language,
        label: binding.label,
        ...(binding.version ? { version: binding.version } : {}),
        ...(binding.status ? { status: binding.status } : {}),
        ...(binding.reason ? { reason: binding.reason } : {})
      }))
    const cells = snapshot.cells.slice(-6).map((cell) => ({
      id: cell.id,
      language: cell.language,
      status: cell.status,
      ...(cell.executionCount === undefined ? {} : { executionCount: cell.executionCount }),
      ...(cell.latestRunId ? { latestRunId: cell.latestRunId } : {})
    }))

    if (
      snapshot.executionCount === 0 &&
      !snapshot.activeRunId &&
      !snapshot.activeWrite &&
      cells.length === 0 &&
      kernels.length === 0 &&
      runtimes.length === 0
    ) {
      return undefined
    }

    return {
      executionCount: snapshot.executionCount,
      ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
      ...(snapshot.activeWrite ? { activeWriteCellId: snapshot.activeWrite.cellId } : {}),
      cells,
      kernels,
      runtimes
    }
  }

  async state(
    session: Session
  ): Promise<NotebookSessionState & { runtimeBindings: NotebookRuntimeBindings }> {
    const document = await this.options.repository.loadOrCreate({
      projectName: session.projectName,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd,
      lane: session.lane
    })
    const snapshot = session.snapshot()
    const runs = await this.options.repository.readSessionRuns(
      session.projectName,
      session.sessionId
    )

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
      cells: snapshot.cells.map((cell) => ({ ...cell })),
      activeWrite: snapshot.activeWrite ? { ...snapshot.activeWrite } : undefined,
      activeRunId: snapshot.activeRunId,
      runs: runs.map((run) => this.toPublicRunRecord(run)),
      recentRuns: runs.slice(-20).map((run) => this.toPublicRunRecord(run)),
      environments: this.environmentStatuses(session),
      runtimeBindings: this.options.runtimeBindings(session)
    }
  }

  async getSessionReference(
    request: NotebookSessionRequest
  ): Promise<NotebookSessionReference | null> {
    const live = this.options.findSession(request.sessionId)
    if (live) return this.toSessionReference(live)

    const projectName = request.projectName ?? this.options.defaultProjectName
    const document = await this.options.repository.findAnyExisting(projectName, request.sessionId)
    if (!document) return null

    const rootDocument = await this.options.repository.findExisting(projectName, request.sessionId)
    const notebookSessionRoot = getNotebookSessionRoot(
      this.options.storageRoot,
      projectName,
      request.sessionId
    )

    return {
      sessionId: request.sessionId,
      projectName,
      workspaceCwd: rootDocument?.workspaceCwd ?? request.workspaceCwd,
      notebookSessionRoot,
      dataRoot: getNotebookDataRoot(this.options.storageRoot, projectName, request.sessionId),
      runtimeRoot: document.kernel.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(this.options.storageRoot, projectName, request.sessionId)
    }
  }

  toSessionReference(session: Session): NotebookSessionReference {
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

  toRunSummary(session: Session, run: NotebookRunRecord): NotebookRunSummary {
    const inputFiles = (run.inputFiles ?? []).map((input) => {
      const publicInput = { ...input } as Partial<typeof input>
      delete publicInput.storageKey
      return publicInput as NotebookRunSummary['inputFiles'][number]
    })
    return {
      ...this.toPublicRunRecord(run),
      inputFiles,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: getRuntimeRoot(this.options.storageRoot),
      kernelName: 'python3'
    }
  }

  private environmentStatuses(session: Session): NotebookEnvironmentStatus[] {
    return session.kernelStatusEntries().map(([processKey, status]) => {
      if (processKey === 'repl') return { processKey, kind: 'repl', status }
      const separator = processKey.indexOf(':')
      return {
        processKey,
        kind: processKey.slice(0, separator) === 'r' ? 'r' : 'python',
        environment: processKey.slice(separator + 1),
        status,
        restartRecommended: this.options.isRestartRecommended(processKey)
      }
    })
  }

  private toPublicRunRecord(run: NotebookRunRecord): NotebookRunRecord {
    const inputFiles = (run.inputFiles ?? []).map((input) => {
      const publicInput = { ...input } as Partial<typeof input>
      delete publicInput.storageKey
      return publicInput
    })
    return { ...run, inputFiles } as NotebookRunRecord
  }
}

export { NotebookSessionReadModel }
export type { NotebookHandoffContext, NotebookSessionReadModelOptions, NotebookSessionReadSource }
