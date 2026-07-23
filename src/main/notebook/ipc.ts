import { ipcMain } from 'electron'

import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookAllResult,
  ExportNotebookKernelRequest,
  ExportNotebookResult,
  FinishNotebookCodeCellRequest,
  ImportNotebookResult,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { NotebookRuntimeService } from './runtime-service'

type NotebookHandlers = {
  state: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
  reference: (request: NotebookSessionRequest) => Promise<NotebookSessionReference | null>
  beginCodeCell: (
    request: BeginNotebookCodeCellRequest
  ) => ReturnType<NotebookRuntimeService['beginCodeCell']>
  appendCodeCell: (
    request: AppendNotebookCodeCellRequest
  ) => ReturnType<NotebookRuntimeService['appendCodeCell']>
  finishCodeCell: (
    request: FinishNotebookCodeCellRequest
  ) => ReturnType<NotebookRuntimeService['finishCodeCell']>
  runCell: (request: RunNotebookCellRequest) => ReturnType<NotebookRuntimeService['runCell']>
  execute: (request: ExecuteNotebookCodeRequest) => Promise<NotebookRunSummary>
  exportIpynb: (request: ExportNotebookKernelRequest) => Promise<ExportNotebookResult>
  exportIpynbAll: (request: ExportNotebookAllRequest) => Promise<ExportNotebookAllResult>
  importIpynb: (request: NotebookSessionRequest) => Promise<ImportNotebookResult>
  restart: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
  shutdown: (request: NotebookSessionRequest) => ReturnType<NotebookRuntimeService['shutdown']>
}

// Builds a small delegating surface so tests can validate IPC behavior without Electron wiring.
const createNotebookHandlers = (service: NotebookRuntimeService): NotebookHandlers => ({
  state: (request) => service.state(request),
  reference: (request) => service.getSessionReference(request),
  beginCodeCell: (request) => service.beginCodeCell(request),
  appendCodeCell: (request) => service.appendCodeCell(request),
  finishCodeCell: (request) => service.finishCodeCell(request),
  runCell: (request) => service.runCell(request),
  execute: (request) => service.execute(request),
  exportIpynb: (request) => service.exportIpynb(request),
  exportIpynbAll: (request) => service.exportIpynbAll(request),
  importIpynb: (request) => service.importIpynb(request),
  restart: (request) => service.restart(request),
  shutdown: (request) => service.shutdown(request)
})

// Registers renderer-callable notebook commands on the main-process IPC bus.
const registerNotebookIpcHandlers = (service: NotebookRuntimeService): void => {
  const handlers = createNotebookHandlers(service)

  ipcMain.handle('notebook:state', (_event, request: NotebookSessionRequest) =>
    handlers.state(request)
  )
  ipcMain.handle('notebook:reference', (_event, request: NotebookSessionRequest) =>
    handlers.reference(request)
  )
  ipcMain.handle('notebook:begin-code-cell', (_event, request: BeginNotebookCodeCellRequest) =>
    handlers.beginCodeCell(request)
  )
  ipcMain.handle('notebook:append-code-cell', (_event, request: AppendNotebookCodeCellRequest) =>
    handlers.appendCodeCell(request)
  )
  ipcMain.handle('notebook:finish-code-cell', (_event, request: FinishNotebookCodeCellRequest) =>
    handlers.finishCodeCell(request)
  )
  ipcMain.handle('notebook:run-cell', (_event, request: RunNotebookCellRequest) =>
    handlers.runCell(request)
  )
  ipcMain.handle('notebook:execute', (_event, request: ExecuteNotebookCodeRequest) =>
    handlers.execute(request)
  )
  ipcMain.handle('notebook:export-ipynb', (_event, request: ExportNotebookKernelRequest) =>
    handlers.exportIpynb(request)
  )
  ipcMain.handle('notebook:export-ipynb-all', (_event, request: ExportNotebookAllRequest) =>
    handlers.exportIpynbAll(request)
  )
  ipcMain.handle('notebook:import-ipynb', (_event, request: NotebookSessionRequest) =>
    handlers.importIpynb(request)
  )
  ipcMain.handle('notebook:restart', (_event, request: NotebookSessionRequest) =>
    handlers.restart(request)
  )
  ipcMain.handle('notebook:shutdown', (_event, request: NotebookSessionRequest) =>
    handlers.shutdown(request)
  )
}

export { createNotebookHandlers, registerNotebookIpcHandlers }
export type { NotebookHandlers }
