import { BrowserWindow, ipcMain } from 'electron'

import type {
  DeleteProviderRequest,
  InstallClaudeRequest,
  RefreshProviderModelsRequest,
  SetActiveProviderRequest,
  UpsertProviderRequest,
  ValidateProviderRequest
} from '../../shared/settings'
import { createDefaultSettingsService, SettingsService } from './service'

// IPC channel names for the settings/onboarding surface. Kept together so preload and main agree.
const SETTINGS_INSTALL_LOG_CHANNEL = 'settings:install-log'

export type SettingsIpcOptions = {
  service?: SettingsService
  // Called after the active provider changes so the ACP runtime can drop its stale connection.
  onActiveProviderChanged?: () => void
}

// Streams one install log line to every open renderer window.
const broadcastInstallLog = (payload: unknown): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(SETTINGS_INSTALL_LOG_CHANNEL, payload)
    }
  }
}

// Registers renderer-callable settings commands. Secret handling stays entirely in the service; the
// handlers only marshal typed requests and forward install log streaming.
const registerSettingsIpcHandlers = ({
  service = createDefaultSettingsService(),
  onActiveProviderChanged
}: SettingsIpcOptions = {}): void => {
  ipcMain.handle('settings:get-preflight', () => service.getPreflight())
  ipcMain.handle('settings:get-settings', () => service.getSettingsView())
  ipcMain.handle('settings:encryption-available', () => service.isEncryptionAvailable())
  ipcMain.handle('settings:npm-available', () => service.isNpmAvailable())
  ipcMain.handle('settings:detect-claude', () => service.detectClaude())

  ipcMain.handle('settings:install-claude', (_event, request: InstallClaudeRequest) =>
    service.installClaude(request, broadcastInstallLog)
  )

  ipcMain.handle('settings:upsert-provider', async (_event, request: UpsertProviderRequest) => {
    const snapshot = await service.upsertProvider(request)

    // Editing the currently-active provider in place must also refresh the agent. The live process
    // baked its base URL / key / model in at spawn time, so without this a credential or model edit
    // would silently keep hitting the pre-edit gateway until the next manual provider switch.
    if (request.id && request.id === snapshot.activeProviderId) {
      onActiveProviderChanged?.()
    }

    return snapshot
  })
  ipcMain.handle('settings:delete-provider', (_event, request: DeleteProviderRequest) =>
    service.deleteProvider(request.id)
  )
  ipcMain.handle(
    'settings:set-active-provider',
    async (_event, request: SetActiveProviderRequest) => {
      const snapshot = await service.setActiveProvider(request.id, request.model)

      // Switching providers requires a fresh agent process so the new credentials take effect.
      onActiveProviderChanged?.()

      return snapshot
    }
  )
  ipcMain.handle('settings:validate-provider', (_event, request: ValidateProviderRequest) =>
    service.validateProvider(request)
  )
  ipcMain.handle(
    'settings:refresh-provider-models',
    (_event, request: RefreshProviderModelsRequest) => service.refreshProviderModels(request)
  )
  ipcMain.handle('settings:mark-onboarding-complete', () => service.markOnboardingComplete())
}

export { SETTINGS_INSTALL_LOG_CHANNEL, registerSettingsIpcHandlers }
