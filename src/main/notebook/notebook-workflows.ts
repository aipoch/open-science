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
  NotebookNamespaceRequest,
  NotebookNamespaceSnapshot,
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
  state(request: NotebookSessionStateRequest): Promise<NotebookSessionState>
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
}

type NotebookCommandWorkflows = {
  state(request: NotebookSessionStateRequest): Promise<NotebookSessionState>
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
}

const withoutTrustedTurnContext = <
  Request extends RunNotebookCellRequest | ExecuteNotebookCodeRequest | NotebookNamespaceRequest
>(
  request: Request
): Request => {
  const {
    provenanceContext,
    executionInvocationId,
    registeredInputFiles,
    registeredHelperSkillIds,
    inputRunLeaseId,
    ...publicRequest
  } = request
  void provenanceContext
  void executionInvocationId
  void registeredInputFiles
  void registeredHelperSkillIds
  void inputRunLeaseId
  return publicRequest as Request
}

const createNotebookCommandWorkflows = (
  runtime: NotebookCommandRuntime
): NotebookCommandWorkflows => ({
  // These projections can initialize a previously unseen Notebook session and persist run.json,
  // so they share the same data-root admission as explicit mutation commands.
  state: (request) => withDataRootWrite(() => runtime.state(request)),
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
  shutdown: (request) => withDataRootWrite(() => runtime.shutdown(request))
})

export { createNotebookCommandWorkflows }
export type { NotebookCommandRuntime, NotebookCommandWorkflows }
