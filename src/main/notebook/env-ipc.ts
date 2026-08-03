import { BrowserWindow } from 'electron'

import type { NotebookLanguage } from '../../shared/notebook'
import { ipcMainHandle } from '../ipc-handler-registry'
import { serializeProvisioner } from './environment-operation-foundation'
import { createNotebookEnvironmentLifecycle } from './environment-lifecycle-workflows'
import type { ProvisionProgress, RuntimeProvisioner } from './provisioner'

// Broadcasts a progress event to every live renderer window.
export const broadcastNotebookEnvProgress = (progress: ProvisionProgress): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('notebook-env:progress', progress)
  }
}

// Registers the stable renderer surface while lifecycle ordering and state stay behind the workflow
// interface. An unavailable provisioner still yields registered handlers with actionable results.
export const registerNotebookEnvIpcHandlers = (
  provisioner: RuntimeProvisioner | undefined,
  root: string,
  waitForRecovery?: () => Promise<void>,
  assertProvisionAllowed?: (language: NotebookLanguage) => void,
  onRepairCompleted?: (language: NotebookLanguage) => Promise<void> | void
): void => {
  const lifecycle = createNotebookEnvironmentLifecycle({
    provisioner,
    root,
    projectProgress: broadcastNotebookEnvProgress,
    waitForRecovery,
    assertProvisionAllowed,
    onRepairCompleted
  })

  ipcMainHandle('notebook-env:status', () => lifecycle.status())
  ipcMainHandle('notebook-env:provision', (_event, language: NotebookLanguage) =>
    lifecycle.provision(language)
  )
  ipcMainHandle('notebook-env:repair', (_event, language: NotebookLanguage) =>
    lifecycle.repair(language)
  )
  ipcMainHandle('notebook-env:cancel', (_event, language?: NotebookLanguage) =>
    lifecycle.cancel(language)
  )
  void lifecycle.startup()
}

// Preserve the composition-root import until N7e owns construction at the application seam.
export { serializeProvisioner }
