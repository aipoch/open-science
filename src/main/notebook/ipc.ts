import { ipcMainHandle } from '../ipc-handler-registry'
import { createLogger, diagnosticErrorFields } from '@aipoch/diagnostics/node'
import { callerContextForEvent, canSatisfyHumanApproval } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
import { withNotebookUserOperation } from './execution-intent'
import type {
  NotebookProjectResourcesRequest,
  NotebookResourceReleaseRequest,
  ReleaseNotebookSessionResourcesRequest
} from '../../shared/notebook-resources'

import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookKernelRequest,
  AbortNotebookCodeCellRequest,
  FinishNotebookCodeCellRequest,
  NotebookBackgroundRunLookupRequest,
  NotebookNamespaceRequest,
  NotebookProjectActivityRequest,
  NotebookRestartRequest,
  NotebookSessionRequest,
  NotebookSessionStateRequest,
  RunNotebookCellRequest
} from '../../shared/notebook'
import type { NotebookCommandWorkflows } from './notebook-workflows'
import type {
  NotebookProcessMonitorRequest,
  TerminateNotebookProcessRequest
} from '../../shared/notebook-process-monitor'

const log = createLogger('notebook:ipc')

// Registers renderer-callable notebook commands on the main-process IPC bus.
const registerNotebookIpcHandlers = (handlers: NotebookCommandWorkflows): void => {
  const human = (event: Electron.IpcMainInvokeEvent): (() => void) => {
    const caller = callerContextForEvent(event)
    const lease = callerLeaseForEvent(event)
    return () => {
      if (
        !canSatisfyHumanApproval(caller) ||
        lease.signal.aborted ||
        !lease.isCurrent() ||
        event.sender.isDestroyed()
      )
        throw new Error('Only a current human caller can manage Notebook resources.')
    }
  }
  ipcMainHandle(
    'notebook:project-resources',
    async (event, request: NotebookProjectResourcesRequest) => {
      const assertCurrent = human(event)
      assertCurrent()
      const result = await handlers.projectResources(request)
      assertCurrent()
      return result
    }
  )
  ipcMainHandle(
    'notebook:release-session-resources',
    (event, request: ReleaseNotebookSessionResourcesRequest) =>
      handlers.releaseSessionResources(request, human(event))
  )
  ipcMainHandle(
    'notebook:resource-release',
    async (event, request: NotebookResourceReleaseRequest) => {
      const assertCurrent = human(event)
      assertCurrent()
      const result = await handlers.resourceRelease(request)
      assertCurrent()
      return result
    }
  )
  ipcMainHandle(
    'notebook:retry-resource-release',
    (event, request: NotebookResourceReleaseRequest) =>
      handlers.retryResourceRelease(request, human(event))
  )
  ipcMainHandle('notebook:process-monitor', (_event, request?: NotebookProcessMonitorRequest) =>
    handlers.processMonitor(request)
  )
  ipcMainHandle(
    'notebook:terminate-monitored-process',
    (_event, request: TerminateNotebookProcessRequest) =>
      handlers.terminateMonitoredProcess(request)
  )
  ipcMainHandle('notebook:run-index', (_event, request: NotebookSessionRequest) =>
    handlers.runIndex(request)
  )
  ipcMainHandle('notebook:state', (_event, request: NotebookSessionStateRequest) =>
    handlers.state(request)
  )
  ipcMainHandle(
    'notebook:memory-policy-state',
    (_event, request: import('../../shared/notebook-memory').NotebookMemoryPolicyStateRequest) =>
      handlers.memoryPolicyState(request)
  )
  ipcMainHandle('notebook:project-activity', (_event, request: NotebookProjectActivityRequest) =>
    handlers.projectActivity(request)
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
  ipcMainHandle('notebook:execute', async (event, request: ExecuteNotebookCodeRequest) => {
    try {
      if (request.source === 'user' && request.inputKind === 'terminal') {
        const assertCurrent = human(event)
        assertCurrent()
        request = withNotebookUserOperation(request, { assertCurrent })
      }
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
  ipcMainHandle('notebook:background-run', (_event, request: NotebookBackgroundRunLookupRequest) =>
    handlers.getBackgroundRun(request)
  )
  ipcMainHandle(
    'notebook:cancel-background-run',
    (_event, request: NotebookBackgroundRunLookupRequest) => handlers.cancelBackgroundRun(request)
  )
}

export { registerNotebookIpcHandlers }
export type { NotebookCommandWorkflows as NotebookHandlers }
