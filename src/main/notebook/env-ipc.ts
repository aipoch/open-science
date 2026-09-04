import type { NotebookLanguage } from '../../shared/notebook'
import { ipcMainHandle } from '../ipc-handler-registry'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { NotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import type { ProvisionProgress } from './provisioner'

// Publishes progress through the application event hub so Electron and Web share one ordered event.
export const broadcastNotebookEnvProgress = (progress: ProvisionProgress): void => {
  broadcastToRenderers('notebook-env:progress', progress)
}

// Registers the stable renderer surface while lifecycle ordering and state stay behind the workflow
// interface. An unavailable provisioner still yields registered handlers with actionable results.
export const registerNotebookEnvIpcHandlers = (lifecycle: NotebookEnvironmentLifecycle): void => {
  ipcMainHandle('notebook-env:status', () => lifecycle.status())
  ipcMainHandle(
    'notebook-env:provision',
    (_event, language: NotebookLanguage, operationId?: string) =>
      lifecycle.provision(language, operationId)
  )
  ipcMainHandle(
    'notebook-env:repair',
    (_event, language: NotebookLanguage, runtimeIdentity: string, operationId?: string) =>
      lifecycle.repair(language, runtimeIdentity, operationId)
  )
  ipcMainHandle('notebook-env:cancel', (_event, language?: NotebookLanguage) =>
    lifecycle.cancel(language)
  )
}
