import { BrowserWindow, ipcMain } from 'electron'

import type {
  CreateSkillRequest,
  DeleteProviderRequest,
  DeleteSkillRequest,
  ImportSkillRequest,
  ImportSkillZipRequest,
  PreviewSkillZipRequest,
  ScanRepoRequest,
  InstallClaudeRequest,
  InstallOpencodeRequest,
  ClaudeInstallEvent,
  RefreshProviderModelsRequest,
  SetActiveProviderRequest,
  SetAgentFrameworkRequest,
  AddCustomServerRequest,
  RemoveCustomServerRequest,
  SetCustomServerEnabledRequest,
  UpdateCustomServerRequest,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetNcbiCredentialsRequest,
  SetSkillEnabledRequest,
  SetToolPermissionRequest,
  UpdateSkillRequest,
  UpsertProviderRequest,
  ValidateProviderRequest
} from '../../shared/settings'
import { createDefaultSettingsService, SettingsService } from './service'
import { createLogger } from '../logger'

const log = createLogger('settings-ipc')

// IPC channel names for the settings/onboarding surface. Kept together so preload and main agree.
// Carries both log lines and progress ticks (a `ClaudeInstallEvent` discriminated union).
const SETTINGS_INSTALL_LOG_CHANNEL = 'settings:install-log'

export type SettingsIpcOptions = {
  service?: SettingsService
  // Called after the active provider changes so the ACP runtime can drop its stale connection.
  onActiveProviderChanged?: () => void
  // Called after a skill is toggled so the ACP runtime reloads skills on its next reconnect.
  onSkillsChanged?: () => void
  // Called after a connector/tool/credential change so bundled + custom skill docs re-sync.
  onConnectorsChanged?: () => void
}

// Streams one install event (log line or progress tick) to every open renderer window.
const broadcastInstallEvent = (event: ClaudeInstallEvent): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(SETTINGS_INSTALL_LOG_CHANNEL, event)
    }
  }
}

// Registers renderer-callable settings commands. Secret handling stays entirely in the service; the
// handlers only marshal typed requests and forward install log streaming.
const registerSettingsIpcHandlers = ({
  service = createDefaultSettingsService(),
  onActiveProviderChanged,
  onSkillsChanged,
  onConnectorsChanged
}: SettingsIpcOptions = {}): void => {
  ipcMain.handle('settings:get-preflight', () => service.getPreflight())
  ipcMain.handle('settings:get-settings', () => service.getSettingsView())
  ipcMain.handle('settings:encryption-available', () => service.isEncryptionAvailable())
  ipcMain.handle('settings:npm-available', () => service.isNpmAvailable())
  ipcMain.handle('settings:check-environment', () => service.checkEnvironment())
  ipcMain.handle('settings:detect-claude', () => service.detectClaude())
  ipcMain.handle('settings:detect-opencode', () => service.detectOpencode())
  ipcMain.handle('settings:install-opencode', (_event, request: InstallOpencodeRequest) =>
    service.installOpencode(request, broadcastInstallEvent)
  )

  ipcMain.handle('settings:install-claude', (_event, request: InstallClaudeRequest) =>
    service.installClaude(request, broadcastInstallEvent)
  )

  ipcMain.handle('settings:uninstall-claude', async () => {
    const { snapshot, activeBackendAffected } = await service.uninstallClaude()

    // Reconnect only when the removed runtime backed the active framework (its live agent is now stale,
    // possibly auto-switched to the other). Uninstalling the inactive runtime touches nothing the live
    // agent depends on, so it must not churn the connection.
    if (activeBackendAffected) onActiveProviderChanged?.()

    return snapshot
  })

  ipcMain.handle('settings:uninstall-opencode', async () => {
    const { snapshot, activeBackendAffected } = await service.uninstallOpencode()

    if (activeBackendAffected) onActiveProviderChanged?.()

    return snapshot
  })

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
  ipcMain.handle(
    'settings:set-agent-framework',
    async (_event, request: SetAgentFrameworkRequest) => {
      log.info('set agent framework requested', { id: request.id })
      const snapshot = await service.setAgentFramework(request.id)

      // Switching frameworks needs a fresh agent process, exactly like a provider switch — the live
      // process is a different backend binary, so the choice only takes effect on reconnect.
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

  ipcMain.handle('settings:list-skills', () => service.listSkills())
  ipcMain.handle('settings:get-skill-detail', (_event, id: string) => service.getSkillDetail(id))
  ipcMain.handle('settings:set-skill-enabled', async (_event, request: SetSkillEnabledRequest) => {
    const skills = await service.setSkillEnabled(request)

    // A toggle takes effect on the next reconnect: the runtime re-provisions (re-materializes) the
    // config dir and resumes the open session with full context on its next message.
    onSkillsChanged?.()

    return skills
  })
  ipcMain.handle('settings:create-skill', async (_event, request: CreateSkillRequest) => {
    const skills = await service.createSkill(request)
    onSkillsChanged?.()
    return skills
  })
  ipcMain.handle('settings:update-skill', async (_event, request: UpdateSkillRequest) => {
    const skills = await service.updateSkill(request)
    onSkillsChanged?.()
    return skills
  })
  ipcMain.handle('settings:delete-skill', async (_event, request: DeleteSkillRequest) => {
    const skills = await service.deleteSkill(request)
    onSkillsChanged?.()
    return skills
  })
  ipcMain.handle('settings:import-skill', async (_event, request: ImportSkillRequest) => {
    const result = await service.importSkill(request)
    onSkillsChanged?.()
    return result
  })
  ipcMain.handle('settings:import-skill-zip', async (_event, request: ImportSkillZipRequest) => {
    const result = await service.importSkillZip(request)
    onSkillsChanged?.()
    return result
  })
  ipcMain.handle('settings:preview-skill-zip', (_event, request: PreviewSkillZipRequest) =>
    service.previewSkillZip(request)
  )
  ipcMain.handle('settings:scan-repo-skills', (_event, request: ScanRepoRequest) =>
    service.scanRepoSkills(request)
  )

  ipcMain.handle('settings:list-connectors', () => service.listConnectors())
  ipcMain.handle('settings:get-connector-detail', (_event, id: string) =>
    service.getConnectorDetail(id)
  )
  ipcMain.handle(
    'settings:set-connector-enabled',
    async (_event, request: SetConnectorEnabledRequest) => {
      const snapshot = await service.setConnectorEnabled(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMain.handle(
    'settings:set-connector-auto-allow',
    async (_event, request: SetConnectorAutoAllowRequest) => {
      const snapshot = await service.setConnectorAutoAllow(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMain.handle(
    'settings:set-tool-permission',
    async (_event, request: SetToolPermissionRequest) => {
      const detail = await service.setToolPermission(request)
      onConnectorsChanged?.()
      return detail
    }
  )
  ipcMain.handle(
    'settings:set-ncbi-credentials',
    async (_event, request: SetNcbiCredentialsRequest) => {
      const snapshot = await service.setNcbiCredentials(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMain.handle('settings:add-custom-server', async (_event, request: AddCustomServerRequest) => {
    const snapshot = await service.addCustomServer(request)
    onConnectorsChanged?.()
    return snapshot
  })
  ipcMain.handle(
    'settings:set-custom-server-enabled',
    async (_event, request: SetCustomServerEnabledRequest) => {
      const snapshot = await service.setCustomServerEnabled(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMain.handle(
    'settings:remove-custom-server',
    async (_event, request: RemoveCustomServerRequest) => {
      const snapshot = await service.removeCustomServer(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMain.handle(
    'settings:update-custom-server',
    async (_event, request: UpdateCustomServerRequest) => {
      const snapshot = await service.updateCustomServer(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
}

export { SETTINGS_INSTALL_LOG_CHANNEL, registerSettingsIpcHandlers }
