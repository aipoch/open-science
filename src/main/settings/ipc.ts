import { ipcMain } from 'electron'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isReasoningEffort,
  type AgentFrameworkId,
  type ReasoningEffort,
  type SettingsSnapshot,
  type CreateSkillRequest,
  type DeleteProviderRequest,
  type DeleteSkillRequest,
  type ImportAgentHomeSkillRequest,
  type ImportSkillRequest,
  type ImportSkillZipRequest,
  type ImportSkillZipBatchRequest,
  type PreviewSkillZipRequest,
  type ScanRepoRequest,
  type InstallClaudeRequest,
  type InstallCodexRequest,
  type InstallOpencodeRequest,
  type ClaudeInstallEvent,
  type RefreshProviderModelsRequest,
  type SetActiveProviderRequest,
  type SetAgentFrameworkRequest,
  type AddCustomServerRequest,
  type RemoveCustomServerRequest,
  type SetCustomServerEnabledRequest,
  type UpdateCustomServerRequest,
  type SetConnectorAutoAllowRequest,
  type SetConnectorEnabledRequest,
  type SetNcbiCredentialsRequest,
  type SetPackageMirrorRequest,
  type SetClosePreferenceRequest,
  type SetNotificationsEnabledRequest,
  type SetReasoningEffortRequest,
  type SetSkillEnabledRequest,
  type SetToolPermissionRequest,
  type UpdateSkillRequest,
  type UpsertProviderRequest,
  type ValidateProviderRequest
} from '../../shared/settings'
import { createDefaultSettingsService, SettingsService } from './service'
import { createLogger } from '../logger'
import { broadcastToRenderers } from '../renderer-broadcast'

const log = createLogger('settings-ipc')

// IPC channel names for the settings/onboarding surface. Kept together so preload and main agree.
// Carries both log lines and progress ticks (a `ClaudeInstallEvent` discriminated union).
const SETTINGS_INSTALL_LOG_CHANNEL = 'settings:install-log'

export type SettingsIpcOptions = {
  service?: SettingsService
  // Called after the active provider changes so the current framework runtime reconnects with it.
  onActiveProviderChanged?: () => void
  // Called after the agent framework changes. Active turns finish on their prior framework; every later
  // turn resumes through the newly selected framework.
  onAgentFrameworkChanged?: () => void
  // Called after the reasoning effort changes so the ACP runtime can live-apply it to open sessions.
  // Returns true when the level was applied over ACP (no reconnect needed); false means the active
  // framework only carries effort in its spawn config and onActiveProviderChanged must fire instead.
  onReasoningEffortChanged?: (effort: ReasoningEffort) => Promise<boolean>
  // Called after a skill is toggled so the ACP runtime reloads skills on its next reconnect.
  onSkillsChanged?: () => void
  // Called after a connector/tool/credential change so bundled + custom skill docs re-sync.
  onConnectorsChanged?: () => void
}

// Streams one install event (log line or progress tick) to every open renderer window.
const broadcastInstallEvent = (event: ClaudeInstallEvent): void => {
  broadcastToRenderers(SETTINGS_INSTALL_LOG_CHANNEL, event)
}

// Registers renderer-callable settings commands. Secret handling stays entirely in the service; the
// handlers only marshal typed requests and forward install log streaming.
const registerSettingsIpcHandlers = ({
  service = createDefaultSettingsService(),
  onActiveProviderChanged,
  onAgentFrameworkChanged,
  onReasoningEffortChanged,
  onSkillsChanged,
  onConnectorsChanged
}: SettingsIpcOptions = {}): void => {
  const notifyAfterRuntimeUninstall = (
    uninstalledFramework: AgentFrameworkId,
    snapshot: SettingsSnapshot,
    activeBackendAffected: boolean
  ): void => {
    if (!activeBackendAffected) return

    if (snapshot.agentFrameworkId !== uninstalledFramework) {
      onAgentFrameworkChanged?.()
      return
    }

    onActiveProviderChanged?.()
  }

  ipcMain.handle('settings:get-preflight', () => service.getPreflight())
  ipcMain.handle('settings:get-settings', () => service.getSettingsView())
  ipcMain.handle('settings:encryption-available', () => service.isEncryptionAvailable())
  ipcMain.handle('settings:npm-available', () => service.isNpmAvailable())
  ipcMain.handle('settings:check-environment', () => service.checkEnvironment())
  ipcMain.handle('settings:detect-claude', () => service.detectClaude())
  ipcMain.handle('settings:detect-opencode', () => service.detectOpencode())
  ipcMain.handle('settings:detect-codex', () => service.detectCodex())
  ipcMain.handle('settings:install-opencode', (_event, request: InstallOpencodeRequest) =>
    service.installOpencode(request, broadcastInstallEvent)
  )
  ipcMain.handle('settings:install-codex', (_event, request: InstallCodexRequest) =>
    service.installCodex(request, broadcastInstallEvent)
  )

  ipcMain.handle('settings:install-claude', (_event, request: InstallClaudeRequest) =>
    service.installClaude(request, broadcastInstallEvent)
  )

  ipcMain.handle('settings:uninstall-claude', async () => {
    const { snapshot, activeBackendAffected } = await service.uninstallClaude()

    // Refresh only when the removed runtime backed the active framework. Rotate generations when the
    // service selected a fallback framework; otherwise reconnect the now-stale current generation.
    // Uninstalling an inactive runtime must not churn the live agent.
    notifyAfterRuntimeUninstall('claude-code', snapshot, activeBackendAffected)

    return snapshot
  })

  ipcMain.handle('settings:uninstall-opencode', async () => {
    const { snapshot, activeBackendAffected } = await service.uninstallOpencode()

    notifyAfterRuntimeUninstall('opencode', snapshot, activeBackendAffected)

    return snapshot
  })

  ipcMain.handle('settings:uninstall-codex', async () => {
    const { snapshot, activeBackendAffected } = await service.uninstallCodex()

    notifyAfterRuntimeUninstall('codex', snapshot, activeBackendAffected)

    return snapshot
  })

  ipcMain.handle('settings:upsert-provider', async (_event, request: UpsertProviderRequest) => {
    const before = await service.getSettingsView()
    const snapshot = await service.upsertProvider(request)

    // Editing the currently-active provider in place must also refresh the agent. The live process
    // baked its base URL / key / model in at spawn time, so without this a credential or model edit
    // would silently keep hitting the pre-edit gateway until the next manual provider switch.
    if (
      request.id &&
      (request.id === before.activeProviderId || request.id === snapshot.activeProviderId)
    ) {
      onActiveProviderChanged?.()
    }

    return snapshot
  })
  ipcMain.handle('settings:delete-provider', async (_event, request: DeleteProviderRequest) => {
    const before = await service.getSettingsView()
    const snapshot = await service.deleteProvider(request.id)

    // The live process still holds the decrypted key until it reconnects.
    if (before.activeProviderId === request.id) onActiveProviderChanged?.()

    return snapshot
  })
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

      // A framework uses a different backend binary. Preserve active turns, then resume every later turn
      // through a runtime for the newly selected framework.
      onAgentFrameworkChanged?.()

      return snapshot
    }
  )
  ipcMain.handle(
    'settings:set-reasoning-effort',
    async (_event, request: SetReasoningEffortRequest) => {
      // Renderer payloads are untyped at runtime: reject anything outside the known levels instead
      // of persisting a value the agent-mapping layers can't interpret.
      if (!isReasoningEffort(request?.effort)) {
        throw new Error(`Unknown reasoning effort: ${String(request?.effort)}`)
      }

      log.info('set reasoning effort requested', { effort: request.effort })
      const snapshot = await service.setReasoningEffort(request.effort)

      // Live-capable frameworks (Claude Code, Codex) apply the level to open sessions over ACP —
      // no respawn, the way a model switch feels. Others (opencode) bake effort into the spawn
      // config, so only the provider-switch reconnect can deliver it.
      const appliedLive = (await onReasoningEffortChanged?.(request.effort)) ?? false

      if (!appliedLive) {
        onActiveProviderChanged?.()
      }

      return snapshot
    }
  )
  ipcMain.handle(
    'settings:set-notifications-enabled',
    async (_event, request: SetNotificationsEnabledRequest) => {
      // Renderer payloads are untyped at runtime: only a real boolean may persist.
      if (typeof request?.enabled !== 'boolean') {
        throw new Error(`Invalid notifications-enabled flag: ${String(request?.enabled)}`)
      }

      log.info('set notifications enabled requested', { enabled: request.enabled })
      return service.setNotificationsEnabled(request.enabled)
    }
  )
  ipcMain.handle(
    'settings:set-close-preference',
    async (_event, request: SetClosePreferenceRequest) => {
      const preference = request?.preference
      if (preference !== undefined && preference !== 'minimize' && preference !== 'quit') {
        throw new Error(`Invalid close preference: ${String(preference)}`)
      }

      log.info('set close preference requested', { preference: preference ?? 'ask' })
      return service.setClosePreference(preference)
    }
  )
  ipcMain.handle('settings:validate-provider', (_event, request: ValidateProviderRequest) =>
    service.validateProvider(request)
  )
  ipcMain.handle('settings:cancel-codex-login', () => service.cancelCodexLogin())
  ipcMain.handle('settings:cancel-claude-login', () => service.cancelClaudeLogin())
  ipcMain.handle('settings:login-shared-claude', async () => {
    const result = await service.loginClaudeShared()

    // A fresh login changes the credentials the live agent relies on; reconnect so it picks them
    // up. Skip when the outcome was discarded by a mid-flow switch to isolated — reconnecting the
    // now-isolated runtime would be redundant (its credentials didn't change).
    if (result.ok) {
      const snapshot = await service.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CLAUDE_SHARED_PROVIDER_ID &&
        active?.type === 'claude-shared'
      ) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMain.handle('settings:logout-shared-claude', async () => {
    const result = await service.logoutClaudeShared()

    if (result.ok) {
      const snapshot = await service.getSettingsView()
      if (snapshot.activeProviderId === CLAUDE_SHARED_PROVIDER_ID) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMain.handle('settings:login-isolated-claude', async (_event, token: string) => {
    // Renderer payloads are untyped at runtime: reject anything that isn't a string before it
    // reaches the controller, so a malicious or corrupt payload can never be coerced into a save.
    if (typeof token !== 'string') {
      throw new Error('Claude sign-in token must be a string.')
    }

    const result = await service.loginIsolatedClaude(token)

    // A fresh login changes the credentials the live agent relies on; reconnect so it picks them
    // up. Skip when the outcome was discarded (the claude-isolated record was deleted mid-paste) —
    // reconnecting the now-active provider would be redundant (its credentials didn't change).
    if (result.ok && result.applied !== false) {
      const snapshot = await service.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID &&
        active?.type === 'claude-isolated'
      ) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMain.handle('settings:login-isolated-claude-browser', async () => {
    // Browser sign-in: runs `claude setup-token` under the isolated config dir, which opens the
    // browser for OAuth and returns the token the app stores. Same post-login reconnect rule as the
    // paste flow — a fresh credential means the live agent must reconnect to pick it up.
    const result = await service.loginIsolatedClaudeBrowser()

    if (result.ok && result.applied !== false) {
      const snapshot = await service.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID &&
        active?.type === 'claude-isolated'
      ) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMain.handle('settings:cancel-isolated-claude-login', async () => {
    await service.cancelClaudeIsolatedLogin()
  })
  ipcMain.handle('settings:logout-isolated-claude', async () => {
    const result = await service.logoutIsolatedClaude()

    // Reconnect only when the sign-out actually cleared the credential. A failed sign-out leaves
    // the token in place, so forcing the live agent to reconnect would just re-authenticate with
    // the token we failed to remove.
    if (result.ok) {
      const snapshot = await service.getSettingsView()
      if (snapshot.activeProviderId === CLAUDE_ISOLATED_PROVIDER_ID) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMain.handle('settings:login-isolated-codex', async () => {
    const result = await service.loginIsolatedCodex()

    // A fresh login changes the credentials the live agent relies on; reconnect so it picks them
    // up. Skip when the outcome was discarded by a mid-flow switch to shared — reconnecting the
    // now-shared runtime would be redundant (its credentials didn't change).
    if (result.ok) {
      const snapshot = await service.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID &&
        active?.type === 'codex-isolated'
      ) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMain.handle('settings:logout-isolated-codex', async () => {
    const result = await service.logoutIsolatedCodex()

    // Reconnect only when the sign-out actually cleared the credential. A timed-out sign-out leaves
    // it in place, so forcing the live agent to reconnect would just re-authenticate against the
    // credential we failed to remove.
    if (result.ok) {
      const snapshot = await service.getSettingsView()
      if (snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMain.handle(
    'settings:refresh-provider-models',
    (_event, request: RefreshProviderModelsRequest) => service.refreshProviderModels(request)
  )
  ipcMain.handle('settings:mark-onboarding-complete', () => service.markOnboardingComplete())

  ipcMain.handle('settings:get-package-mirror', () => service.getPackageMirror())
  ipcMain.handle('settings:set-package-mirror', (_event, request: SetPackageMirrorRequest) =>
    service.setPackageMirror(request)
  )

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
  ipcMain.handle(
    'settings:import-skill-zip-batch',
    async (_event, request: ImportSkillZipBatchRequest) => {
      const result = await service.importSkillZipBatch(request)
      onSkillsChanged?.()
      return result
    }
  )
  ipcMain.handle('settings:preview-skill-zip', (_event, request: PreviewSkillZipRequest) =>
    service.previewSkillZip(request)
  )
  ipcMain.handle('settings:scan-repo-skills', (_event, request: ScanRepoRequest) =>
    service.scanRepoSkills(request)
  )
  // Lists the user's machine-level Claude skills (~/.claude/skills/) for the "From your agent home"
  // import source. Read-only — the renderer calls importAgentHomeSkill to actually copy one in.
  ipcMain.handle('settings:list-agent-home-skills', () => service.listAgentHomeSkills())
  ipcMain.handle(
    'settings:import-agent-home-skill',
    async (_event, request: ImportAgentHomeSkillRequest) => {
      const result = await service.importAgentHomeSkill(request)
      onSkillsChanged?.()

      return result
    }
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
  // Compute file browser bookmarks: keyed by provider_id in settings.computeBookmarks.
  ipcMain.handle('compute:bookmarks:get', (_event, providerId: string) =>
    service.getComputeBookmarks(providerId)
  )
  ipcMain.handle('compute:bookmarks:set', (_event, providerId: string, folders: string[]) =>
    service.setComputeBookmarks(providerId, folders)
  )
}

export { SETTINGS_INSTALL_LOG_CHANNEL, registerSettingsIpcHandlers }
