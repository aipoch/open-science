import { ipcMain } from 'electron'

import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  FinishNotebookCodeCellRequest,
  NotebookRunSummary,
  NotebookSessionRequest,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { NotebookRuntimeService } from './runtime-service'

type NotebookHandlers = {
  state: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
  beginCodeCell: (
    request: BeginNotebookCodeCellRequest
  ) => ReturnType<NotebookRuntimeService['beginCodeCell']>
  appendCodeCell: (
    request: AppendNotebookCodeCellRequest
  ) => ReturnType<NotebookRuntimeService['appendCodeCell']>
  finishCodeCell: (
    request: FinishNotebookCodeCellRequest
  ) => ReturnType<NotebookRuntimeService['finishCodeCell']>
  runCell: (request: RunNotebookCellRequest) => Promise<NotebookRunSummary>
  execute: (request: ExecuteNotebookCodeRequest) => Promise<NotebookRunSummary>
  restart: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
  shutdown: (request: NotebookSessionRequest) => ReturnType<NotebookRuntimeService['shutdown']>
}

// Builds a small delegating surface so tests can validate IPC behavior without Electron wiring.
const createNotebookHandlers = (service: NotebookRuntimeService): NotebookHandlers => ({
  state: (request) => service.state(request),
  beginCodeCell: (request) => service.beginCodeCell(request),
  appendCodeCell: (request) => service.appendCodeCell(request),
  finishCodeCell: (request) => service.finishCodeCell(request),
  runCell: (request) => service.runCell(request),
  execute: (request) => service.execute(request),
  restart: (request) => service.restart(request),
  shutdown: (request) => service.shutdown(request)
})

// Registers renderer-callable notebook commands on the main-process IPC bus.
const registerNotebookIpcHandlers = (service: NotebookRuntimeService): void => {
  const handlers = createNotebookHandlers(service)

  ipcMain.handle('notebook:state', (_event, request: NotebookSessionRequest) =>
    handlers.state(request)
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
  ipcMain.handle('notebook:restart', (_event, request: NotebookSessionRequest) =>
    handlers.restart(request)
  )
  ipcMain.handle('notebook:shutdown', (_event, request: NotebookSessionRequest) =>
    handlers.shutdown(request)
  )
}

export { createNotebookHandlers, registerNotebookIpcHandlers }
export type { NotebookHandlers }
