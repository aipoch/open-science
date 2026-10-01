import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../artifacts'

import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  NotebookAvailableEvent,
  NotebookChangedEvent,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookAllResult,
  ExportNotebookKernelRequest,
  ExportNotebookResult,
  AbortNotebookCodeCellRequest,
  FinishNotebookCodeCellRequest,
  NotebookLanguage,
  NotebookNamespaceRequest,
  NotebookNamespaceSnapshot,
  NotebookProjectActivity,
  NotebookProjectActivityRequest,
  NotebookRestartRequest,
  NotebookBackgroundRunLookupRequest,
  NotebookBackgroundRunResult,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionStateRequest,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../notebook'

import type { ProvisionProgress, ProvisionStatus } from '../notebook-env'

import {
  callable,
  LOCAL,
  type AcpListener,
  type RemoveListener,
  EVENT,
  OPTIONAL_ARGUMENT_SLOT,
  POSITIONAL
} from './definition'

export const contracts = {
  'notebook.appendCodeCell': callable<
    (request: AppendNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      writeId: string
      receivedBytes: number
    }>
  >()('notebook', ['notebook:append-code-cell']),
  'notebook.beginCodeCell': callable<
    (request: BeginNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      writeId: string
      status: string
    }>
  >()('notebook', ['notebook:begin-code-cell']),
  'notebook.execute': callable<
    (request: ExecuteNotebookCodeRequest) => Promise<NotebookRunSummary>
  >()('notebook', ['notebook:execute']),
  'notebook.getBackgroundRun': callable<
    (request: NotebookBackgroundRunLookupRequest) => Promise<NotebookBackgroundRunResult>
  >()('notebook', ['notebook:background-run']),
  'notebook.getProjectActivity': callable<
    (request: NotebookProjectActivityRequest) => Promise<NotebookProjectActivity>
  >()('notebook', ['notebook:project-activity']),
  'notebook.cancelBackgroundRun': callable<
    (request: NotebookBackgroundRunLookupRequest) => Promise<NotebookBackgroundRunResult>
  >()('notebook', ['notebook:cancel-background-run']),
  'notebook.exportIpynb': callable<
    (request: ExportNotebookKernelRequest) => Promise<ExportNotebookResult>
  >()('notebook', ['notebook:export-ipynb', LOCAL]),
  'notebook.exportIpynbAll': callable<
    (request: ExportNotebookAllRequest) => Promise<ExportNotebookAllResult>
  >()('notebook', ['notebook:export-ipynb-all', LOCAL]),
  'notebook.abortCodeCell': callable<
    (request: AbortNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      code: string
      status: string
    }>
  >()('notebook', ['notebook:abort-code-cell']),
  'notebook.finishCodeCell': callable<
    (request: FinishNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      code: string
      status: string
    }>
  >()('notebook', ['notebook:finish-code-cell']),
  'notebook.getReference': callable<
    (request: NotebookSessionRequest) => Promise<NotebookSessionReference | null>
  >()('notebook', ['notebook:reference']),
  'notebook.inspectNamespace': callable<
    (request: NotebookNamespaceRequest) => Promise<NotebookNamespaceSnapshot>
  >()('notebook', ['notebook:inspect-namespace']),
  'notebook.onAvailable': callable<
    (listener: AcpListener<NotebookAvailableEvent>) => RemoveListener
  >()('notebook', ['notebook:available', EVENT]),
  'notebook.onChanged': callable<(listener: AcpListener<NotebookChangedEvent>) => RemoveListener>()(
    'notebook',
    ['notebook:changed', EVENT]
  ),
  'notebook.readInputPreview': callable<
    (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  >()('notebook', ['notebook:read-input-preview']),
  'notebook.restart': callable<
    (request: NotebookRestartRequest) => Promise<NotebookSessionState>
  >()('notebook', ['notebook:restart']),
  'notebook.runCell': callable<(request: RunNotebookCellRequest) => Promise<NotebookRunSummary>>()(
    'notebook',
    ['notebook:run-cell']
  ),
  'notebook.shutdown': callable<
    (request: NotebookSessionRequest) => Promise<{ sessionId: string; status: 'shutdown' }>
  >()('notebook', ['notebook:shutdown']),
  'notebook.state': callable<
    (request: NotebookSessionStateRequest) => Promise<NotebookSessionState>
  >()('notebook', ['notebook:state']),
  'notebookEnv.cancel': callable<(lang?: NotebookLanguage) => Promise<void>>()(
    'notebook-environment',
    ['notebook-env:cancel', LOCAL, OPTIONAL_ARGUMENT_SLOT, POSITIONAL]
  ),
  'notebookEnv.getStatus': callable<() => Promise<ProvisionStatus>>()('notebook-environment', [
    'notebook-env:status'
  ]),
  'notebookEnv.onProgress': callable<
    (listener: (progress: ProvisionProgress) => void) => RemoveListener
  >()('notebook-environment', ['notebook-env:progress', EVENT]),
  'notebookEnv.provision': callable<
    (lang: NotebookLanguage, operationId?: string) => Promise<void>
  >()('notebook-environment', ['notebook-env:provision', LOCAL]),
  'notebookEnv.repair': callable<
    (lang: NotebookLanguage, runtimeIdentity: string, operationId?: string) => Promise<void>
  >()('notebook-environment', ['notebook-env:repair', LOCAL])
} as const
