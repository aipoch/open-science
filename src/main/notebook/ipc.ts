import { ipcMainHandle } from '../ipc-handler-registry'
import { createLogger, diagnosticErrorFields } from '../logger'

import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookKernelRequest,
  AbortNotebookCodeCellRequest,
  FinishNotebookCodeCellRequest,
  NotebookNamespaceRequest,
  NotebookRestartRequest,
  NotebookSessionRequest,
  NotebookSessionStateRequest,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { NotebookCommandWorkflows } from './notebook-workflows'

const log = createLogger('notebook:ipc')

// Registers renderer-callable notebook commands on the main-process IPC bus.
const registerNotebookIpcHandlers = (handlers: NotebookCommandWorkflows): void => {
  ipcMainHandle('notebook:state', (_event, request: NotebookSessionStateRequest) =>
    handlers.state(request)
  )
  ipcMainHandle('notebook:inspect-namespace', (_event, request: NotebookNamespaceRequest) =>
    handlers.inspectNamespace(request)
  )
  ipcMainHandle('notebook:reference', (_event, request: NotebookSessionRequest) =>
    handlers.reference(request)
  )
  ipcMainHandle('notebook:begin-code-cell', (_event, request: BeginNotebookCodeCellRequest) =>
    handlers.beginCodeCell(request)
  )
  ipcMainHandle('notebook:append-code-cell', (_event, request: AppendNotebookCodeCellRequest) =>
    handlers.appendCodeCell(request)
  )
  ipcMainHandle('notebook:abort-code-cell', (_event, request: AbortNotebookCodeCellRequest) =>
    handlers.abortCodeCell(request)
  )
  ipcMainHandle('notebook:finish-code-cell', (_event, request: FinishNotebookCodeCellRequest) =>
    handlers.finishCodeCell(request)
  )
  ipcMainHandle('notebook:run-cell', (_event, request: RunNotebookCellRequest) =>
    handlers.runCell(request)
  )
  ipcMainHandle('notebook:execute', async (_event, request: ExecuteNotebookCodeRequest) => {
    try {
      const result = await handlers.execute(request)
      if (
        request.source === 'user' &&
        request.inputKind === 'terminal' &&
        result.status !== 'completed'
      ) {
        log.error('user terminal execution failed', {
          sessionId: request.sessionId,
          projectId: request.projectId,
          language: request.language ?? 'python',
          environment: result.environment,
          runId: result.runId,
          status: result.status
        })
      }
      return result
    } catch (error) {
      if (request.source === 'user' && request.inputKind === 'terminal') {
        log.error('user terminal submission failed', {
          sessionId: request.sessionId,
          projectId: request.projectId,
          language: request.language ?? 'python',
          codeLength: request.code.length,
          ...diagnosticErrorFields(error)
        })
      }
      throw error
    }
  })
  ipcMainHandle('notebook:export-ipynb', (_event, request: ExportNotebookKernelRequest) =>
    handlers.exportIpynb(request)
  )
  ipcMainHandle('notebook:export-ipynb-all', (_event, request: ExportNotebookAllRequest) =>
    handlers.exportIpynbAll(request)
  )
  ipcMainHandle('notebook:restart', (_event, request: NotebookRestartRequest) =>
    handlers.restart(request)
  )
  ipcMainHandle('notebook:shutdown', (_event, request: NotebookSessionRequest) =>
    handlers.shutdown(request)
  )
}

export { registerNotebookIpcHandlers }
export type { NotebookCommandWorkflows as NotebookHandlers }
