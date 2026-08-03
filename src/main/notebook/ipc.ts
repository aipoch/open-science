import { ipcMainHandle } from '../ipc-handler-registry'

import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookKernelRequest,
  FinishNotebookCodeCellRequest,
  NotebookSessionRequest,
  RunNotebookCellRequest
} from '../../shared/notebook'
import {
  createNotebookCommandWorkflows,
  type NotebookCommandRuntime,
  type NotebookCommandWorkflows
} from './notebook-workflows'

// Builds a small delegating surface so tests can validate IPC behavior without Electron wiring.
const createNotebookHandlers = createNotebookCommandWorkflows

// Registers renderer-callable notebook commands on the main-process IPC bus.
const registerNotebookIpcHandlers = (runtime: NotebookCommandRuntime): void => {
  const handlers = createNotebookHandlers(runtime)

  ipcMainHandle('notebook:state', (_event, request: NotebookSessionRequest) =>
    handlers.state(request)
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
  ipcMainHandle('notebook:finish-code-cell', (_event, request: FinishNotebookCodeCellRequest) =>
    handlers.finishCodeCell(request)
  )
  ipcMainHandle('notebook:run-cell', (_event, request: RunNotebookCellRequest) =>
    handlers.runCell(request)
  )
  ipcMainHandle('notebook:execute', (_event, request: ExecuteNotebookCodeRequest) =>
    handlers.execute(request)
  )
  ipcMainHandle('notebook:export-ipynb', (_event, request: ExportNotebookKernelRequest) =>
    handlers.exportIpynb(request)
  )
  ipcMainHandle('notebook:export-ipynb-all', (_event, request: ExportNotebookAllRequest) =>
    handlers.exportIpynbAll(request)
  )
  ipcMainHandle('notebook:restart', (_event, request: NotebookSessionRequest) =>
    handlers.restart(request)
  )
  ipcMainHandle('notebook:shutdown', (_event, request: NotebookSessionRequest) =>
    handlers.shutdown(request)
  )
}

export { createNotebookHandlers, registerNotebookIpcHandlers }
export type { NotebookCommandWorkflows as NotebookHandlers }
