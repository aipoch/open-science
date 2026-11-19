import type {
  NotebookMemoryPolicyState,
  NotebookMemoryPolicyStateRequest
} from '../../shared/notebook-memory'
import type { ReplayRunIndex } from '../../shared/replay'
import type {
  NotebookProjectResources,
  NotebookProjectResourcesRequest,
  NotebookResourceRelease,
  NotebookResourceReleaseRequest,
  ReleaseNotebookSessionResourcesRequest
} from '../../shared/notebook-resources'
import type {
  NotebookProcessMonitorSnapshot,
  NotebookProcessMonitorRequest,
  TerminateNotebookProcessRequest
} from '../../shared/notebook-process-monitor'
import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookAllResult,
  ExportNotebookKernelRequest,
  ExportNotebookResult,
  AbortNotebookCodeCellRequest,
  FinishNotebookCodeCellRequest,
  NotebookCell,
  NotebookBackgroundRunLookupRequest,
  NotebookBackgroundRunResult,
  NotebookNamespaceRequest,
  NotebookNamespaceSnapshot,
  NotebookProjectActivity,
  NotebookProjectActivityRequest,
  NotebookRestartRequest,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionStateRequest,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../../shared/notebook'
import { withDataRootWrite } from '../storage/migration-state'

type BeginNotebookCodeCellResult = {
  sessionId: string
  cellId: string
  writeId: string
  status: NotebookCell['status']
}

type AppendNotebookCodeCellResult = {
  sessionId: string
  cellId: string
  writeId: string
  receivedBytes: number
}

type FinishNotebookCodeCellResult = {
  sessionId: string
  cellId: string
  code: string
  status: NotebookCell['status']
}

type NotebookShutdownResult = { sessionId: string; status: 'shutdown' }

type NotebookCommandRuntime = {
  getProjectResources(request: NotebookProjectResourcesRequest): Promise<NotebookProjectResources>
  releaseSessionResources(
    request: ReleaseNotebookSessionResourcesRequest,
    assertCurrent: () => void
  ): Promise<NotebookResourceRelease>
  getResourceRelease(request: NotebookResourceReleaseRequest): NotebookResourceRelease
  retryResourceRelease(
    request: NotebookResourceReleaseRequest,
    assertCurrent: () => void
  ): Promise<NotebookResourceRelease>
  getProcessMonitor?: (
    request?: NotebookProcessMonitorRequest
  ) => Promise<NotebookProcessMonitorSnapshot>
  terminateMonitoredProcess?: (request: TerminateNotebookProcessRequest) => Promise<void>
  runIndex(request: NotebookSessionRequest): Promise<ReplayRunIndex[]>
  state(request: NotebookSessionStateRequest): Promise<NotebookSessionState>
  getMemoryPolicyState(
    request: NotebookMemoryPolicyStateRequest
  ): Promise<NotebookMemoryPolicyState>
  getProjectActivity(request: NotebookProjectActivityRequest): NotebookProjectActivity
  inspectNamespace(request: NotebookNamespaceRequest): Promise<NotebookNamespaceSnapshot>
  getSessionReference(request: NotebookSessionRequest): Promise<NotebookSessionReference | null>
  beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<BeginNotebookCodeCellResult>
  appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<AppendNotebookCodeCellResult>
  abortCodeCell(request: AbortNotebookCodeCellRequest): Promise<FinishNotebookCodeCellResult>
  finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<FinishNotebookCodeCellResult>
  runCell(request: RunNotebookCellRequest): Promise<NotebookRunSummary>
  execute(request: ExecuteNotebookCodeRequest): Promise<NotebookRunSummary>
  exportIpynb(request: ExportNotebookKernelRequest): Promise<ExportNotebookResult>
  exportIpynbAll(request: ExportNotebookAllRequest): Promise<ExportNotebookAllResult>
  restart(request: NotebookRestartRequest): Promise<NotebookSessionState>
  shutdown(request: NotebookSessionRequest): Promise<NotebookShutdownResult>
  getBackgroundRun(
    request: NotebookBackgroundRunLookupRequest
  ): Promise<NotebookBackgroundRunResult>
  cancelBackgroundRun(
    request: NotebookBackgroundRunLookupRequest
  ): Promise<NotebookBackgroundRunResult>
}

type NotebookCommandWorkflows = {
  configureResourceReleaseGuard(blockedReason: () => string | undefined): void
  projectResources(request: NotebookProjectResourcesRequest): Promise<NotebookProjectResources>
  releaseSessionResources(
    request: ReleaseNotebookSessionResourcesRequest,
    assertCurrent: () => void
  ): Promise<NotebookResourceRelease>
  resourceRelease(request: NotebookResourceReleaseRequest): Promise<NotebookResourceRelease>
  retryResourceRelease(
    request: NotebookResourceReleaseRequest,
    assertCurrent: () => void
  ): Promise<NotebookResourceRelease>
  processMonitor(request?: NotebookProcessMonitorRequest): Promise<NotebookProcessMonitorSnapshot>
  terminateMonitoredProcess(request: TerminateNotebookProcessRequest): Promise<void>
  runIndex(request: NotebookSessionRequest): Promise<ReplayRunIndex[]>
  state(request: NotebookSessionStateRequest): Promise<NotebookSessionState>
  memoryPolicyState(request: NotebookMemoryPolicyStateRequest): Promise<NotebookMemoryPolicyState>
  projectActivity(request: NotebookProjectActivityRequest): Promise<NotebookProjectActivity>
  inspectNamespace(request: NotebookNamespaceRequest): Promise<NotebookNamespaceSnapshot>
  reference(request: NotebookSessionRequest): Promise<NotebookSessionReference | null>
  beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<BeginNotebookCodeCellResult>
  appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<AppendNotebookCodeCellResult>
  abortCodeCell(request: AbortNotebookCodeCellRequest): Promise<FinishNotebookCodeCellResult>
  finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<FinishNotebookCodeCellResult>
  runCell(request: RunNotebookCellRequest): Promise<NotebookRunSummary>
  execute(request: ExecuteNotebookCodeRequest): Promise<NotebookRunSummary>
  exportIpynb(request: ExportNotebookKernelRequest): Promise<ExportNotebookResult>
  exportIpynbAll(request: ExportNotebookAllRequest): Promise<ExportNotebookAllResult>
  restart(request: NotebookRestartRequest): Promise<NotebookSessionState>
  shutdown(request: NotebookSessionRequest): Promise<NotebookShutdownResult>
  getBackgroundRun(
    request: NotebookBackgroundRunLookupRequest
  ): Promise<NotebookBackgroundRunResult>
  cancelBackgroundRun(
    request: NotebookBackgroundRunLookupRequest
  ): Promise<NotebookBackgroundRunResult>
}

const withoutTrustedTurnContext = <
  Request extends RunNotebookCellRequest | ExecuteNotebookCodeRequest | NotebookNamespaceRequest
>(
  request: Request
): Request => {
  const {
    provenanceContext,
    executionInvocationId,
    rootExecutionId,
    registeredInputFiles,
    registeredHelperSkillIds,
    inputRunLeaseId,
    ...publicRequest
  } = request
  void provenanceContext
  void rootExecutionId
  void executionInvocationId
  void registeredInputFiles
  void registeredHelperSkillIds
  void inputRunLeaseId
  return publicRequest as Request
}

type NotebookResourceAvailability = {
  withSessionAvailable<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result>
  isSessionResourceReadable(projectId: string, sessionId: string): Promise<boolean>
  assertSessionResourceReleaseAvailable(projectId: string, sessionId: string): void
}

const createNotebookCommandWorkflows = (
  runtime: NotebookCommandRuntime,
  resourceAvailability?: NotebookResourceAvailability
): NotebookCommandWorkflows => {
  let releaseBlockedReason = (): string | undefined => 'application-unavailable'
  const assertReleaseAvailable = (): void => {
    const reason = releaseBlockedReason()
    if (reason) throw new Error(`Notebook resources cannot be released: ${reason}`)
  }
  const available = (): NotebookResourceAvailability => {
    if (!resourceAvailability) throw new Error('Notebook Session authority is unavailable.')
    return resourceAvailability
  }
  const readableRelease = async (
    release: NotebookResourceRelease
  ): Promise<NotebookResourceRelease> => {
    const continuations = await Promise.all(
      release.continuations.map(async (continuation) =>
        (await available().isSessionResourceReadable(
          continuation.projectId,
          continuation.sessionId
        ))
          ? continuation
          : undefined
      )
    )
    return { ...release, continuations: continuations.filter((entry) => entry !== undefined) }
  }
  const mutate = async <
    Request extends ReleaseNotebookSessionResourcesRequest | NotebookResourceReleaseRequest
  >(
    request: Request,
    assertCurrent: () => void,
    operation: (assertCurrent: () => void) => Promise<NotebookResourceRelease>
  ): Promise<NotebookResourceRelease> => {
    const authority = available()
    assertCurrent()
    assertReleaseAvailable()
    const result = await authority.withSessionAvailable(
      request.projectId,
      request.sessionId,
      async () => ({
        operation: await operation(() => {
          assertCurrent()
          assertReleaseAvailable()
          authority.assertSessionResourceReleaseAvailable(request.projectId, request.sessionId)
        })
      })
    )
    const release = await readableRelease(await result.operation)
    assertCurrent()
    return release
  }
  return {
    processMonitor: (request) =>
      runtime.getProcessMonitor?.(request) ??
      Promise.reject(new Error('Process monitoring is unavailable.')),
    terminateMonitoredProcess: (request) =>
      withDataRootWrite(
        () =>
          runtime.terminateMonitoredProcess?.(request) ??
          Promise.reject(new Error('Process termination is unavailable.'))
      ),
    configureResourceReleaseGuard: (guard) => {
      releaseBlockedReason = guard
    },
    projectResources: async (request) => {
      const view = await runtime.getProjectResources(request)
      const scopes = new Map(
        [
          ...view.groups,
          ...view.pendingDecisions,
          ...view.releases,
          ...view.releases.flatMap((release) => release.continuations)
        ].map((scope) => [JSON.stringify([scope.projectId, scope.sessionId]), scope])
      )
      const allowed = new Set(
        (
          await Promise.all(
            [...scopes.entries()].map(async ([key, scope]) =>
              (await available().isSessionResourceReadable(scope.projectId, scope.sessionId))
                ? key
                : undefined
            )
          )
        ).filter((key) => key !== undefined)
      )
      const readable = (scope: { projectId: string; sessionId: string }): boolean =>
        allowed.has(JSON.stringify([scope.projectId, scope.sessionId]))
      return {
        groups: view.groups.filter(readable).map((group) => {
          let reason = group.releaseBlockedReason ?? releaseBlockedReason()
          if (!reason) {
            try {
              available().assertSessionResourceReleaseAvailable(group.projectId, group.sessionId)
            } catch {
              reason = 'session-unavailable'
            }
          }
          return { ...group, releaseBlockedReason: reason }
        }),
        pendingDecisions: view.pendingDecisions.filter(readable),
        releases: view.releases.filter(readable).map((release) => ({
          ...release,
          continuations: release.continuations.filter(readable)
        }))
      }
    },
    releaseSessionResources: (request, assertCurrent) =>
      mutate(request, assertCurrent, (assert) => runtime.releaseSessionResources(request, assert)),
    resourceRelease: async (request) => {
      if (!(await available().isSessionResourceReadable(request.projectId, request.sessionId)))
        throw new Error('Notebook release operation is unavailable for this Session.')
      return readableRelease(runtime.getResourceRelease(request))
    },
    retryResourceRelease: (request, assertCurrent) =>
      mutate(request, assertCurrent, (assert) => runtime.retryResourceRelease(request, assert)),
    // These projections can initialize a previously unseen Notebook session and persist run.json,
    // so they share the same data-root admission as explicit mutation commands.
    runIndex: (request) => runtime.runIndex(request),
    state: (request) => withDataRootWrite(() => runtime.state(request)),
    memoryPolicyState: (request) => runtime.getMemoryPolicyState(request),
    projectActivity: async (request) => runtime.getProjectActivity(request),
    inspectNamespace: (request) =>
      withDataRootWrite(() => runtime.inspectNamespace(withoutTrustedTurnContext(request))),
    reference: (request) => runtime.getSessionReference(request),
    beginCodeCell: (request) => withDataRootWrite(() => runtime.beginCodeCell(request)),
    appendCodeCell: (request) => withDataRootWrite(() => runtime.appendCodeCell(request)),
    abortCodeCell: (request) => withDataRootWrite(() => runtime.abortCodeCell(request)),
    finishCodeCell: (request) => withDataRootWrite(() => runtime.finishCodeCell(request)),
    runCell: (request) =>
      withDataRootWrite(() => runtime.runCell(withoutTrustedTurnContext(request))),
    execute: (request) =>
      withDataRootWrite(() => runtime.execute(withoutTrustedTurnContext(request))),
    exportIpynb: (request) => runtime.exportIpynb(request),
    exportIpynbAll: (request) => runtime.exportIpynbAll(request),
    restart: (request) => withDataRootWrite(() => runtime.restart(request)),
    shutdown: (request) => withDataRootWrite(() => runtime.shutdown(request)),
    getBackgroundRun: (request) => runtime.getBackgroundRun(request),
    cancelBackgroundRun: (request) => withDataRootWrite(() => runtime.cancelBackgroundRun(request))
  }
}

export { createNotebookCommandWorkflows }
export type { NotebookCommandRuntime, NotebookCommandWorkflows, NotebookResourceAvailability }
