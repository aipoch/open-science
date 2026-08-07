import { BrowserWindow } from 'electron'

import type { NotebookLanguage } from '../../shared/notebook'
import { ipcMainHandle } from '../ipc-handler-registry'
import type { NotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import type { ProvisionProgress } from './provisioner'

// Broadcasts a progress event to every live renderer window.
export const broadcastNotebookEnvProgress = (progress: ProvisionProgress): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('notebook-env:progress', progress)
  }
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
  ipcMainHandle('notebook-env:repair', (_event, language: NotebookLanguage, operationId?: string) =>
    lifecycle.repair(language, operationId)
  )
  ipcMainHandle('notebook-env:cancel', (_event, language?: NotebookLanguage) =>
    lifecycle.cancel(language)
  )
}
