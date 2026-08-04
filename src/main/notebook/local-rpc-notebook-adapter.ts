import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExecuteNotebookControlRequest,
  ExecuteShellRequest,
  FinishNotebookCodeCellRequest,
  NotebookLanguage,
  NotebookSessionRequest,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { ManageEnvironmentsRequest, ManageEnvironmentsResult } from '../../shared/notebook-env'
import type { InstallRequest, InstallResult } from './package-manager'

type InspectPackagesRequest = NotebookSessionRequest & {
  language: NotebookLanguage
  packages: string[]
}

type NotebookRuntimeBindingRequest = NotebookSessionRequest & {
  language: NotebookLanguage
  runtimeId: string
}

type NotebookLocalRpcCapability = {
  beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<unknown>
  appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<unknown>
  finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<unknown>
  runCell(request: RunNotebookCellRequest): Promise<unknown>
  execute(request: ExecuteNotebookCodeRequest): Promise<unknown>
  executeControl(request: ExecuteNotebookControlRequest): Promise<unknown>
  executeShell(request: ExecuteShellRequest): Promise<unknown>
  state(request: NotebookSessionRequest): Promise<unknown>
  restart(request: NotebookSessionRequest): Promise<unknown>
  shutdown(request: NotebookSessionRequest): Promise<unknown>
  inspectPackages(request: InspectPackagesRequest): Promise<unknown>
  managePackages(request: InstallRequest): Promise<InstallResult>
  manageEnvironments(request: ManageEnvironmentsRequest): Promise<ManageEnvironmentsResult>
  listRuntimes(request: NotebookSessionRequest): Promise<unknown>
  bindRuntime(request: NotebookRuntimeBindingRequest): Promise<unknown>
  switchRuntime(request: NotebookRuntimeBindingRequest): Promise<unknown>
}

const NOTEBOOK_LOCAL_RPC_METHODS = [
  'beginCodeCell',
  'appendCodeCell',
  'finishCodeCell',
  'runCell',
  'execute',
  'executeControl',
  'executeShell',
  'state',
  'restart',
  'shutdown',
  'inspectPackages',
  'managePackages',
  'manageEnvironments',
  'listRuntimes',
  'bindRuntime',
  'switchRuntime'
] as const

type NotebookLocalRpcMethod = (typeof NOTEBOOK_LOCAL_RPC_METHODS)[number]
type NotebookLocalRpcHandler = (request: Record<string, unknown>) => Promise<unknown>

const NOTEBOOK_LOCAL_RPC_METHOD_SET = new Set<string>(NOTEBOOK_LOCAL_RPC_METHODS)
const NOTEBOOK_INPUT_RUN_METHODS = new Set<NotebookLocalRpcMethod>([
  'runCell',
  'execute',
  'executeControl',
  'executeShell'
])

const isNotebookLocalRpcMethod = (method: unknown): method is NotebookLocalRpcMethod =>
  typeof method === 'string' && NOTEBOOK_LOCAL_RPC_METHOD_SET.has(method)

const opensNotebookInputRun = (method: unknown): method is NotebookLocalRpcMethod =>
  isNotebookLocalRpcMethod(method) && NOTEBOOK_INPUT_RUN_METHODS.has(method)

const assertSessionParams = (params: Record<string, unknown>): void => {
  if (typeof params.sessionId !== 'string' || typeof params.workspaceCwd !== 'string') {
    throw new Error('Notebook RPC params must include sessionId and workspaceCwd.')
  }
}

const resolveNotebookLocalRpcHandler = (
  capability: NotebookLocalRpcCapability,
  method: string,
  params: Record<string, unknown>
): NotebookLocalRpcHandler => {
  assertSessionParams(params)

  if (!isNotebookLocalRpcMethod(method)) {
    throw new Error(`Unknown notebook RPC method: ${method}`)
  }

  switch (method) {
    case 'beginCodeCell':
      return (request) => capability.beginCodeCell(request as BeginNotebookCodeCellRequest)
    case 'appendCodeCell':
      return (request) => capability.appendCodeCell(request as AppendNotebookCodeCellRequest)
    case 'finishCodeCell':
      return (request) => capability.finishCodeCell(request as FinishNotebookCodeCellRequest)
    case 'runCell':
      return (request) => capability.runCell(request as RunNotebookCellRequest)
    case 'execute':
      return (request) => capability.execute(request as ExecuteNotebookCodeRequest)
    case 'executeControl':
      return (request) => capability.executeControl(request as ExecuteNotebookControlRequest)
    case 'executeShell':
      return (request) => capability.executeShell(request as ExecuteShellRequest)
    case 'state':
      return (request) => capability.state(request as NotebookSessionRequest)
    case 'restart':
      return (request) => capability.restart(request as NotebookSessionRequest)
    case 'shutdown':
      return (request) => capability.shutdown(request as NotebookSessionRequest)
    case 'inspectPackages':
      return (request) => capability.inspectPackages(request as InspectPackagesRequest)
    case 'managePackages':
      return (request) => capability.managePackages(request as unknown as InstallRequest)
    case 'manageEnvironments':
      return (request) =>
        capability.manageEnvironments(request as unknown as ManageEnvironmentsRequest)
    case 'listRuntimes':
      return (request) => capability.listRuntimes(request as NotebookSessionRequest)
    case 'bindRuntime':
      return (request) => capability.bindRuntime(request as NotebookRuntimeBindingRequest)
    case 'switchRuntime':
      return (request) => capability.switchRuntime(request as NotebookRuntimeBindingRequest)
  }
}

export {
  NOTEBOOK_LOCAL_RPC_METHODS,
  isNotebookLocalRpcMethod,
  opensNotebookInputRun,
  resolveNotebookLocalRpcHandler
}
export type { NotebookLocalRpcCapability, NotebookLocalRpcHandler, NotebookLocalRpcMethod }
