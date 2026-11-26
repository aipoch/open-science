import { DEFAULT_PY_ENV, DEFAULT_R_ENV } from '@aipoch/environment'
import {
  unavailableNotebookDependencyProjection,
  type NotebookDependencyAnalyzer,
  type NotebookDependencyProjection
} from '@aipoch/notebook-analysis'
import type {
  NotebookBackgroundTaskSnapshot,
  NotebookRunEvidenceSnapshot,
  NotebookRunFigureRequest,
  NotebookCell,
  NotebookEnvironmentStatus,
  NotebookKernelInstanceIdentity,
  NotebookKernelMetadata,
  NotebookRunCursor,
  NotebookRunDocument,
  NotebookRunRecord,
  NotebookRunStaleness,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionState
} from '../../shared/notebook'
import { NOTEBOOK_STATE_HISTORY_PAGE_LIMIT } from '../../shared/notebook'
import type { NotebookLanguage } from '../../shared/notebook-language-contract'
import type { NotebookRuntimeBinding, NotebookRuntimeBindings } from '../../shared/notebook-runtime'
import { resolveProjectId } from '../../shared/project-scope'
import { NOTEBOOK_RENDERER_RUN_LIMIT } from './content-limits'
import type { NotebookLaneIdentity } from './lane-identity'
import {
  getNotebookDataRoot,
  getNotebookRunJsonPath,
  getNotebookSessionRoot,
  getRuntimeRoot,
  NotebookRunRepository,
  type NotebookHistorySnapshot
} from './repository'
import type { NotebookSessionSnapshot } from './session-aggregate'

const DEFAULT_HISTORY_BYTES = 63 * 1024 * 1024
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
  isRestartRecommended: (processKey: string, session: Session) => boolean
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

  private loadSessionKernel(session: Session): Promise<NotebookKernelMetadata> {
    return this.options.repository.loadSessionKernel({
      projectId: session.projectId,
      sessionId: session.sessionId,
      workspaceCwd: session.cwd,
      lane: session.lane
    })
  }

  private async historyWindow(
    projectId: string,
    sessionId: string,
    limit: number,
    runIds: readonly string[],
    frameId?: string,
    before?: NotebookRunCursor,
    session?: Session,
    budget?: { bytes: number; includeRecent: boolean },
    evidenceOnly = false
  ): Promise<NotebookHistorySnapshot> {
    const trim = budget && !runIds.length && frameId === undefined ? budget : undefined
    const cached = await this.options.repository.readCachedHistoryWindow(projectId, sessionId, {
      limit,
      runIds,
      frameId,
      before,
      lane: session?.lane,
      ...(evidenceOnly ? { evidenceOnly: true } : {}),
      retain: trim && this.runBudget(trim.includeRecent, trim.bytes)
    })
    if (cached) return cached
    const kernel = session ? await this.loadSessionKernel(session) : undefined
    const window = await this.options.repository.readSessionRunWindow(
      projectId,
      sessionId,
      limit,
      runIds,
      frameId,
      before
    )
    return {
      kernel,
      window: trim ? this.limitRunWindow(window, trim.includeRecent, trim.bytes) : window
    }
  }

  async runFigure(
    projectId: string,
    sessionId: string,
    request: NotebookRunFigureRequest,
    session?: Session
  ): Promise<string | null> {
    const { window } = await this.historyWindow(
      projectId,
      sessionId,
      0,
      [request.runId],
      undefined,
      undefined,
      session
    )
    const output = window.runs.find((run) => run.runId === request.runId)?.outputs[
      request.outputIndex
    ]
    return output?.type === 'display' && Object.hasOwn(output.data, request.mimeType)
      ? output.data[request.mimeType]
      : null
  }

  async runEvidence(
    projectId: string,
    sessionId: string,
    runId: string,
    session?: Session
  ): Promise<NotebookRunEvidenceSnapshot | null> {
    const { window } = await this.historyWindow(
      projectId,
      sessionId,
      0,
      [runId],
      undefined,
      undefined,
      session,
      undefined,
      true
    )
    const run = window.runs.find((item) => item.runId === runId)
    if (!run) return null
    const {
      kernelEpochId,
      environmentCapture,
      environmentManifestChecksum,
      environmentManifest,
      helperEvidenceStatus
    } = this.toPublicRunRecord(run, true)
    return {
      runId,
      kernelEpochId,
      environmentCapture,
      environmentManifestChecksum,
      environmentManifest,
      helperEvidenceStatus
    }
  }

  async backgroundTasks(
    projectId: string,
    sessionId: string,
    session?: Session
  ): Promise<NotebookBackgroundTaskSnapshot> {
    const foregroundOnly = (): Promise<boolean> =>
      this.options.repository.hasCachedForegroundOnlyHistory(projectId, sessionId, session?.lane)
    if (await foregroundOnly()) return { runs: [] }
    const readCached = (): Promise<NotebookHistorySnapshot | undefined> =>
      this.options.repository.readCachedHistoryWindow(projectId, sessionId, {
        limit: NOTEBOOK_STATE_HISTORY_PAGE_LIMIT,
        runIds: [],
        lane: session?.lane,
        backgroundTaskMetadata: true,
        retain: this.runBudget(true, DEFAULT_HISTORY_BYTES)
      })
    let window = (await readCached())?.window
    if (!window && session) {
      // Loading the kernel waits for pending writes, including updates to background Runs.
      await this.loadSessionKernel(session)
      if (await foregroundOnly()) return { runs: [] }
      window = (await readCached())?.window
    }
    if (!window) {
      window = await this.options.repository.readSessionRunWindow(
        projectId,
        sessionId,
        NOTEBOOK_STATE_HISTORY_PAGE_LIMIT
      )
      if (!window.runs.some((run) => run.executionMode === 'background')) return { runs: [] }
      window = this.limitRunWindow(window, true)
    }
    return {
      runs: window.runs
        .filter((run) => run.executionMode === 'background')
        .map((run) => ({
          runId: run.runId,
          agentFrameId: run.agentFrameId,
          title:
            run.script
              .split(/\r?\n/u)
              .find((line) => line.trim())
              ?.trim()
              .slice(0, 80) || run.runId,
          status: run.status,
          kernelKind: run.kernelKind,
          environment: run.environment,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          cancellationRequestedAt: run.cancellationRequestedAt,
          shellConcurrency: run.shellConcurrency
        }))
    }
  }

  async state(
    session: Session,
    includeRunIds: readonly string[] = [],
    historySummaryFrameId?: string,
    historyBefore?: NotebookRunCursor,
    historyLimit = NOTEBOOK_RENDERER_RUN_LIMIT,
    historyByteLimit?: number,
    deferImages = false
  ): Promise<NotebookSessionState & { runtimeBindings: NotebookRuntimeBindings }> {
    const targetedRunRead = includeRunIds.length > 0
    const summaryOnlyRead = historySummaryFrameId !== undefined && !targetedRunRead
    const pagedHistoryRead = historyBefore !== undefined
    const sparseRunRead = targetedRunRead || summaryOnlyRead || pagedHistoryRead
    const { window: runWindow, kernel } = await this.historyWindow(
      session.projectId,
      session.sessionId,
      targetedRunRead || summaryOnlyRead ? 0 : historyLimit,
      includeRunIds,
      historySummaryFrameId,
      historyBefore,
      session,
      { bytes: historyByteLimit ?? DEFAULT_HISTORY_BYTES, includeRecent: !sparseRunRead }
    )
    if (!kernel) throw new Error('Missing live Notebook kernel metadata.')
    const snapshot = session.snapshot()
    const dependencyProjection = await this.options.dependencyAnalyzer
      .project({ projectId: session.projectId, sessionId: session.sessionId })
      .catch(() => unavailableNotebookDependencyProjection(runWindow.runs))
    const terminatedKernelInstances = kernel.terminatedKernelInstances
    const defaultKernelTerminated = terminatedKernelInstances?.some(
      (instance) => kernelInstanceProcessKey(instance) === DEFAULT_KERNEL_PROCESS_KEY
    )
    const legacyUnknownKernelTerminated =
      kernel.lastKnownStatus === 'terminated' && terminatedKernelInstances === undefined
    const onlyNonDefaultKernelTerminated =
      kernel.lastKnownStatus === 'terminated' &&
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
      pythonPath: kernel.pythonPath,
      // Backward-compatible coarse status represents only the default Python environment. Exact
      // named-environment/R/REPL terminations are projected through `environments` instead. Legacy
      // coarse terminations have unknown ownership and remain visible until an explicit restart.
      kernelStatus:
        liveDefaultKernelStatus ??
        (defaultKernelTerminated || legacyUnknownKernelTerminated
          ? 'terminated'
          : onlyNonDefaultKernelTerminated
            ? 'idle'
            : kernel.lastKnownStatus),
      runJsonPath: session.runJsonPath,
      cells: sparseRunRead
        ? []
        : snapshot.cells.slice(-NOTEBOOK_RENDERER_RUN_LIMIT).map((cell) => ({ ...cell })),
      activeWrite: snapshot.activeWrite ? { ...snapshot.activeWrite } : undefined,
      activeRunId: snapshot.activeRunId,
      runCount: runWindow.total,
      agentSummaries: runWindow.agentSummaries,
      latestRunEnvironments: runWindow.latestRunEnvironments,
      executionEnvironments: {
        python: this.options.runtimeEnvironment?.(session, 'python') ?? DEFAULT_PY_ENV,
        r: this.options.runtimeEnvironment?.(session, 'r') ?? DEFAULT_R_ENV
      },
      ...(runWindow.historySummary ? { historySummary: runWindow.historySummary } : {}),
      ...(!targetedRunRead && !summaryOnlyRead && runWindow.historyPage
        ? { historyPage: runWindow.historyPage }
        : {}),
      runs: runWindow.runs.map((run) => this.toPublicRunRecord(run, targetedRunRead, deferImages)),
      recentRuns: sparseRunRead
        ? []
        : runWindow.runs.slice(-20).map((run) => this.toPublicRunRecord(run, false, deferImages)),
      runStaleness: projectVisibleRunStaleness(dependencyProjection, runWindow.runs),
      environments: this.environmentStatuses(session, terminatedKernelInstances),
      runtimeBindings: this.options.runtimeBindings(session)
    }
  }

  async importedState(
    request: NotebookSessionRequest,
    runIds: readonly string[],
    historySummaryFrameId: string | undefined,
    historyBefore: NotebookRunCursor | undefined,
    historyLimit: number,
    historyByteLimit?: number,
    deferImages = false
  ): Promise<NotebookSessionState & { runtimeBindings: NotebookRuntimeBindings }> {
    const projectId = resolveProjectId(request, this.options.defaultProjectId)
    const { window } = await this.historyWindow(
      projectId,
      request.sessionId,
      runIds.length && deferImages ? 0 : historyLimit,
      runIds,
      historySummaryFrameId,
      historyBefore,
      undefined,
      { bytes: historyByteLimit ?? DEFAULT_HISTORY_BYTES, includeRecent: true }
    )
    const root = getNotebookSessionRoot(this.options.storageRoot, projectId, request.sessionId)
    const runs = window.runs.map((run) =>
      this.toPublicRunRecord(run, runIds.length > 0, deferImages)
    )
    return {
      id: request.sessionId,
      sessionId: request.sessionId,
      cwd: root,
      notebookSessionRoot: root,
      dataRoot: getNotebookDataRoot(this.options.storageRoot, projectId, request.sessionId),
      runtimeRoot: getRuntimeRoot(this.options.storageRoot),
      runJsonPath: getNotebookRunJsonPath(this.options.storageRoot, projectId, request.sessionId),
      kernelStatus: 'idle',
      cells: [],
      runCount: window.total,
      agentSummaries: window.agentSummaries,
      latestRunEnvironments: window.latestRunEnvironments,
      ...(window.historySummary ? { historySummary: window.historySummary } : {}),
      ...(window.historyPage ? { historyPage: window.historyPage } : {}),
      runs,
      recentRuns: runIds.length && deferImages ? [] : runs.slice(-20),
      environments: [],
      runtimeBindings: {}
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

    const document = await this.options.repository.findReferenceHeader(projectId, request.sessionId)
    if (!document) return null

    const notebookSessionRoot = getNotebookSessionRoot(
      this.options.storageRoot,
      projectId,
      request.sessionId
    )

    return {
      sessionId: request.sessionId,
      projectId,
      workspaceCwd:
        document.notebookSessionRoot === notebookSessionRoot
          ? (document.workspaceCwd ?? request.workspaceCwd)
          : request.workspaceCwd,
      notebookSessionRoot,
      dataRoot: getNotebookDataRoot(this.options.storageRoot, projectId, request.sessionId),
      runtimeRoot: getRuntimeRoot(this.options.storageRoot),
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
      ...this.toPublicRunRecord(run, true),
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

  toRunSummaryFromDocument(
    document: Pick<NotebookRunDocument, 'notebookSessionRoot' | 'dataRoot' | 'kernel'>,
    run: NotebookRunRecord
  ): NotebookRunSummary {
    const inputFiles = (run.inputFiles ?? []).map((input) => {
      const publicInput = { ...input } as Partial<typeof input>
      delete publicInput.storageKey
      return publicInput as NotebookRunSummary['inputFiles'][number]
    })
    return {
      ...this.toPublicRunRecord(run, true),
      inputFiles,
      notebookSessionRoot: document.notebookSessionRoot,
      dataRoot: document.dataRoot,
      runtimeRoot: getRuntimeRoot(this.options.storageRoot),
      kernelName: document.kernel.kernelName ?? 'python3'
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
        restartRecommended: this.options.isRestartRecommended(processKey, session)
      }
    })
  }

  private runBudget(includeRecent: boolean, limit: number) {
    let bytes = 0
    return (run: NotebookRunRecord, index: number, count: number, omittedBytes = 0) => {
      const runBytes = Buffer.byteLength(JSON.stringify(this.toPublicRunRecord(run))) + omittedBytes
      bytes += runBytes * (includeRecent && index >= count - 20 ? 2 : 1)
      return index === count - 1 || bytes <= limit
    }
  }

  private limitRunWindow(
    window: Awaited<ReturnType<NotebookRunRepository['readSessionRunWindow']>>,
    includeRecentRuns: boolean,
    byteLimit = DEFAULT_HISTORY_BYTES
  ): Awaited<ReturnType<NotebookRunRepository['readSessionRunWindow']>> {
    const retain = this.runBudget(includeRecentRuns, byteLimit)
    let start = window.runs.length
    for (let index = window.runs.length - 1; index >= 0; index--) {
      if (!retain(window.runs[index], index, window.runs.length)) break
      start = index
    }
    if (start === 0) return window
    const runs = window.runs.slice(start)
    return {
      ...window,
      runs,
      historyPage: {
        hasEarlierRuns: true,
        oldestCursor: { runId: runs[0].runId, startedAt: runs[0].startedAt }
      }
    }
  }

  private toPublicRunRecord(
    run: NotebookRunRecord,
    includeEnvironmentManifest = false,
    deferImages = false
  ): NotebookRunRecord {
    const publicRun = { ...run } as Partial<NotebookRunRecord>
    if (deferImages) {
      publicRun.outputs = run.outputs.map((output) => {
        if (output.type !== 'display') return output
        const deferredImageTypes = Object.keys(output.data).filter((mime) =>
          mime.startsWith('image/')
        )
        if (!deferredImageTypes.length) return output
        return {
          ...output,
          deferredImageTypes,
          data: Object.fromEntries(
            Object.entries(output.data).filter(([mime]) => !mime.startsWith('image/'))
          )
        }
      })
    }
    delete publicRun.runtimeId
    delete publicRun.helperModules
    delete publicRun.submissionIdentity
    delete publicRun.submissionFingerprint
    delete publicRun.admittedAt
    delete publicRun.frozenRuntimeTarget
    delete publicRun.frozenPermissionScope
    const environmentManifestChecksum =
      publicRun.environmentManifestChecksum ??
      (publicRun.environmentCapture?.state === 'available' ||
      publicRun.environmentCapture?.state === 'partial'
        ? publicRun.environmentCapture.manifestChecksum
        : undefined)
    if (!includeEnvironmentManifest && environmentManifestChecksum)
      delete publicRun.environmentManifest
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
