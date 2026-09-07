import type {
  NotebookCell,
  NotebookEnvironmentStatus,
  NotebookKernelInstanceIdentity,
  NotebookKernelMetadata,
  NotebookLanguage,
  NotebookRunRecord,
  NotebookRunCursor,
  NotebookRunStaleness,
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
import { resolveProjectId } from '../../shared/project-scope'
import { NOTEBOOK_RENDERER_RUN_LIMIT } from './content-limits'
import { DEFAULT_PY_ENV, DEFAULT_R_ENV } from './runtime-paths'
import {
  unavailableNotebookDependencyProjection,
  type NotebookDependencyAnalyzer,
  type NotebookDependencyProjection
} from './dependency-analysis'

const DEFAULT_KERNEL_PROCESS_KEY = `python:${DEFAULT_PY_ENV}`

const kernelInstanceProcessKey = (instance: NotebookKernelInstanceIdentity): string =>
  instance.kind === 'repl' ? 'repl' : `${instance.kind}:${instance.environment}`

const projectVisibleRunStaleness = (
  projection: NotebookDependencyProjection,
  runs: readonly NotebookRunRecord[]
): Record<string, NotebookRunStaleness> => {
  const visibleRunIds = new Set(runs.map((run) => run.runId))
  const result: Record<string, NotebookRunStaleness> = {}
  for (const run of runs) {
    const staleness = projection.stalenessByRunId[run.runId]
    if (!staleness) continue
    result[run.runId] =
      staleness.state === 'stale'
        ? { ...staleness, path: staleness.path.filter((runId) => visibleRunIds.has(runId)) }
        : staleness
  }
  return result
}

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
  readonly projectId: string
  readonly cwd: string
  readonly notebookSessionRoot: string
  readonly dataRoot: string
  readonly runtimeRoot: string
  readonly runJsonPath: string
  readonly lane: NotebookLaneIdentity
  snapshot: () => NotebookSessionSnapshot
  kernelStatus: (processKey: string) => NotebookKernelMetadata['lastKnownStatus'] | undefined
  kernelStatusEntries: () => Array<[string, NotebookKernelMetadata['lastKnownStatus']]>
  runtimeBindingEntries: () => Array<[NotebookLanguage, NotebookRuntimeBinding]>
}

type NotebookSessionReadModelOptions<Session extends NotebookSessionReadSource> = {
  storageRoot: string
  defaultProjectId: string
  repository: NotebookRunRepository
  dependencyAnalyzer: Pick<NotebookDependencyAnalyzer, 'project'>
  findSession: (projectId: string, sessionId: string) => Session | undefined
  runtimeBindings: (session: Session) => NotebookRuntimeBindings
  runtimeEnvironment?: (session: Session, language: NotebookLanguage) => string
  isRestartRecommended: (processKey: string) => boolean
}

// Projects live Session Aggregate state and durable run history without owning either source.
class NotebookSessionReadModel<Session extends NotebookSessionReadSource> {
  constructor(private readonly options: NotebookSessionReadModelOptions<Session>) {}

  // A handoff peek must never create a Session or read disk: absent/non-actionable live state is absent.
  peekHandoffContext(sessionId: string): NotebookHandoffContext | undefined {
    const session = this.options.findSession(this.options.defaultProjectId, sessionId)
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
    session: Session,
    includeRunIds: readonly string[] = [],
    historySummaryFrameId?: string,
    historyBefore?: NotebookRunCursor,
    historyLimit = NOTEBOOK_RENDERER_RUN_LIMIT
  ): Promise<NotebookSessionState & { runtimeBindings: NotebookRuntimeBindings }> {
    const document = await this.options.repository.loadOrCreate({
      projectId: session.projectId,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd,
      lane: session.lane
    })
    const snapshot = session.snapshot()
    const targetedRunRead = includeRunIds.length > 0
    const summaryOnlyRead = historySummaryFrameId !== undefined && !targetedRunRead
    const pagedHistoryRead = historyBefore !== undefined
    const sparseRunRead = targetedRunRead || summaryOnlyRead || pagedHistoryRead
    const runWindow = await this.options.repository.readSessionRunWindow(
      session.projectId,
      session.sessionId,
      targetedRunRead || summaryOnlyRead ? 0 : historyLimit,
      includeRunIds,
      historySummaryFrameId,
      historyBefore
    )
    const dependencyProjection = await this.options.dependencyAnalyzer
      .project({ projectId: session.projectId, sessionId: session.sessionId })
      .catch(() => unavailableNotebookDependencyProjection(runWindow.runs))
    const terminatedKernelInstances = document.kernel.terminatedKernelInstances
    const defaultKernelTerminated = terminatedKernelInstances?.some(
      (instance) => kernelInstanceProcessKey(instance) === DEFAULT_KERNEL_PROCESS_KEY
    )
    const legacyUnknownKernelTerminated =
      document.kernel.lastKnownStatus === 'terminated' && terminatedKernelInstances === undefined
    const onlyNonDefaultKernelTerminated =
      document.kernel.lastKnownStatus === 'terminated' &&
      terminatedKernelInstances !== undefined &&
      !defaultKernelTerminated
    const liveDefaultKernelStatus = session.kernelStatus(DEFAULT_KERNEL_PROCESS_KEY)

    return {
      id: session.id,
      sessionId: session.sessionId,
      cwd: session.cwd,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      pythonPath: document.kernel.pythonPath,
      // Backward-compatible coarse status represents only the default Python environment. Exact
      // named-environment/R/REPL terminations are projected through `environments` instead. Legacy
      // coarse terminations have unknown ownership and remain visible until an explicit restart.
      kernelStatus:
        liveDefaultKernelStatus ??
        (defaultKernelTerminated || legacyUnknownKernelTerminated
          ? 'terminated'
          : onlyNonDefaultKernelTerminated
            ? 'idle'
            : document.kernel.lastKnownStatus),
      runJsonPath: session.runJsonPath,
      cells: sparseRunRead
        ? []
        : snapshot.cells.slice(-NOTEBOOK_RENDERER_RUN_LIMIT).map((cell) => ({ ...cell })),
      activeWrite: snapshot.activeWrite ? { ...snapshot.activeWrite } : undefined,
      activeRunId: snapshot.activeRunId,
      runCount: runWindow.total,
      latestRunEnvironments: runWindow.latestRunEnvironments,
      executionEnvironments: {
        python: this.options.runtimeEnvironment?.(session, 'python') ?? DEFAULT_PY_ENV,
        r: this.options.runtimeEnvironment?.(session, 'r') ?? DEFAULT_R_ENV
      },
      ...(runWindow.historySummary ? { historySummary: runWindow.historySummary } : {}),
      ...(!targetedRunRead && !summaryOnlyRead && runWindow.historyPage
        ? { historyPage: runWindow.historyPage }
        : {}),
      runs: runWindow.runs.map((run) => this.toPublicRunRecord(run)),
      recentRuns: sparseRunRead
        ? []
        : runWindow.runs.slice(-20).map((run) => this.toPublicRunRecord(run)),
      runStaleness: projectVisibleRunStaleness(dependencyProjection, runWindow.runs),
      environments: this.environmentStatuses(session, terminatedKernelInstances),
      runtimeBindings: this.options.runtimeBindings(session)
    }
  }

  async getSessionReference(
    request: NotebookSessionRequest
  ): Promise<NotebookSessionReference | null> {
    const projectId = resolveProjectId(request, this.options.defaultProjectId)
    const live = this.options.findSession(projectId, request.sessionId)
    if (live?.projectId === projectId && live.sessionId === request.sessionId) {
      return this.toSessionReference(live)
    }

    const document = await this.options.repository.findAnyExisting(projectId, request.sessionId)
    if (!document) return null

    const rootDocument = await this.options.repository.findExisting(projectId, request.sessionId)
    const notebookSessionRoot = getNotebookSessionRoot(
      this.options.storageRoot,
      projectId,
      request.sessionId
    )

    return {
      sessionId: request.sessionId,
      projectId,
      workspaceCwd: rootDocument?.workspaceCwd ?? request.workspaceCwd,
      notebookSessionRoot,
      dataRoot: getNotebookDataRoot(this.options.storageRoot, projectId, request.sessionId),
      runtimeRoot: document.kernel.runtimeRoot,
      runJsonPath: getNotebookRunJsonPath(this.options.storageRoot, projectId, request.sessionId)
    }
  }

  toSessionReference(session: Session): NotebookSessionReference {
    return {
      sessionId: session.sessionId,
      projectId: session.projectId,
      workspaceCwd: session.cwd,
      notebookSessionRoot: session.notebookSessionRoot,
      dataRoot: session.dataRoot,
      runtimeRoot: session.runtimeRoot,
      runJsonPath: session.runJsonPath
    }
  }

  toRunSummary(
    session: Session,
    run: NotebookRunRecord,
    dependencyProjection?: NotebookDependencyProjection
  ): NotebookRunSummary {
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
      kernelName: 'python3',
      ...(dependencyProjection?.stalenessByRunId[run.runId]
        ? { staleness: dependencyProjection.stalenessByRunId[run.runId] }
        : {}),
      ...(dependencyProjection?.invalidatedByRunId[run.runId]?.length
        ? { invalidatedRuns: dependencyProjection.invalidatedByRunId[run.runId] }
        : {})
    }
  }

  private environmentStatuses(
    session: Session,
    terminatedKernelInstances: NotebookKernelInstanceIdentity[] | undefined
  ): NotebookEnvironmentStatus[] {
    const statuses = new Map(session.kernelStatusEntries())
    for (const instance of terminatedKernelInstances ?? []) {
      const processKey = kernelInstanceProcessKey(instance)
      if (!statuses.has(processKey)) statuses.set(processKey, 'terminated')
    }
    return Array.from(statuses, ([processKey, status]) => {
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
    const publicRun = { ...run } as Partial<NotebookRunRecord>
    delete publicRun.kernelDispatched
    delete publicRun.runtimeId
    delete publicRun.helperModules
    const inputFiles = (run.inputFiles ?? []).map((input) => {
      const publicInput = { ...input } as Partial<typeof input>
      delete publicInput.storageKey
      return publicInput
    })
    return { ...publicRun, inputFiles } as NotebookRunRecord
  }
}

export { NotebookSessionReadModel }
export type { NotebookHandoffContext, NotebookSessionReadModelOptions, NotebookSessionReadSource }
