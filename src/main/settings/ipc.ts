import { ipcMainHandle } from '../ipc-handler-registry'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  isAppIconVariant,
  isReasoningEffort,
  type AgentFrameworkId,
  type AppIconPreview,
  type AppIconVariant,
  type SetAppIconVariantRequest,
  type SettingsSnapshot,
  type CreateSkillRequest,
  type DeleteProviderRequest,
  type DeleteSkillRequest,
  type ImportAgentHomeSkillsRequest,
  type ImportSkillRequest,
  type ImportSkillZipRequest,
  type ImportSkillZipBatchRequest,
  type PreviewAgentHomeSkillRequest,
  type PreviewGitHubSkillRequest,
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
  type SetConversationSkillImportEnabledRequest,
  type SetNotificationsEnabledRequest,
  type SetReasoningEffortRequest,
  type SetSkillEnabledRequest,
  type SetToolPermissionRequest,
  type UpdateSkillRequest,
  type UpsertProviderRequest,
  type ValidateProviderRequest
} from '../../shared/settings'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import {
  createDefaultSettingsService,
  SettingsService,
  type CustomServerSecurityChangeGuard
} from './service'
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
  onReasoningEffortChanged?: (effort: ResolvedReasoningEffort) => Promise<boolean>
  // Called after a skill is toggled so the ACP runtime reloads skills on its next reconnect.
  onSkillsChanged?: () => void
  // Called after a connector/tool/credential change so bundled + custom skill docs re-sync.
  onConnectorsChanged?: () => void
  // Hard owner deletion prunes grants after the settings mutation succeeds.
  onCustomServerRemoved?: (serverId: string) => Promise<void>
  // Security-sensitive endpoint/executable edits revoke remembered authority before the new
  // configuration is persisted. Failure leaves the old server configuration in place.
  onCustomServerSecurityChanged?: (
    serverId: string
  ) => Promise<CustomServerSecurityChangeGuard | void>
  // Called after the app-icon variant changes so the main process applies it live to the window and
  // dock/taskbar. Absent (e.g. web mode) means only the persisted value changes.
  onAppIconVariantChanged?: (variant: AppIconVariant) => void
  // Renders the built-in icon variants to preview data URLs for the Appearance picker. Absent means
  // the picker gets an empty list (no bundled assets available, e.g. an environment without them).
  listAppIconPreviews?: () => AppIconPreview[]
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
  onConnectorsChanged,
  onCustomServerRemoved,
  onCustomServerSecurityChanged,
  onAppIconVariantChanged,
  listAppIconPreviews
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

  ipcMainHandle('settings:get-preflight', () => service.getPreflight())
  ipcMainHandle('settings:get-settings', () => service.getSettingsView())
  ipcMainHandle('settings:encryption-available', () => service.isEncryptionAvailable())
  ipcMainHandle('settings:npm-available', () => service.isNpmAvailable())
  ipcMainHandle('settings:check-environment', () => service.checkEnvironment())
  ipcMainHandle('settings:detect-claude', () => service.detectClaude())
  ipcMainHandle('settings:detect-opencode', () => service.detectOpencode())
  ipcMainHandle('settings:detect-codex', () => service.detectCodex())
  ipcMainHandle('settings:install-opencode', (_event, request: InstallOpencodeRequest) =>
    service.installOpencode(request, broadcastInstallEvent)
  )
  ipcMainHandle('settings:install-codex', (_event, request: InstallCodexRequest) =>
    service.installCodex(request, broadcastInstallEvent)
  )

  ipcMainHandle('settings:install-claude', (_event, request: InstallClaudeRequest) =>
    service.installClaude(request, broadcastInstallEvent)
  )

  ipcMainHandle('settings:uninstall-claude', async () => {
    const { snapshot, activeBackendAffected } = await service.uninstallClaude()

    // Refresh only when the removed runtime backed the active framework. Rotate generations when the
    // service selected a fallback framework; otherwise reconnect the now-stale current generation.
    // Uninstalling an inactive runtime must not churn the live agent.
    notifyAfterRuntimeUninstall('claude-code', snapshot, activeBackendAffected)

    return snapshot
  })

  ipcMainHandle('settings:uninstall-opencode', async () => {
    const { snapshot, activeBackendAffected } = await service.uninstallOpencode()

    notifyAfterRuntimeUninstall('opencode', snapshot, activeBackendAffected)

    return snapshot
  })

  ipcMainHandle('settings:uninstall-codex', async () => {
    const { snapshot, activeBackendAffected } = await service.uninstallCodex()

    notifyAfterRuntimeUninstall('codex', snapshot, activeBackendAffected)

    return snapshot
  })

  ipcMainHandle('settings:upsert-provider', async (_event, request: UpsertProviderRequest) => {
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
  ipcMainHandle('settings:delete-provider', async (_event, request: DeleteProviderRequest) => {
    const before = await service.getSettingsView()
    const snapshot = await service.deleteProvider(request.id)

    // The live process still holds the deleted provider configuration until it reconnects. Compare
    // snapshots because deleting either collapsed Claude id can also remove its active sibling.
    if (before.activeProviderId !== snapshot.activeProviderId) onActiveProviderChanged?.()

    return snapshot
  })
  ipcMainHandle(
    'settings:set-active-provider',
    async (_event, request: SetActiveProviderRequest) => {
      const snapshot = await service.setActiveProvider(request.id, request.model)

      // Switching providers requires a fresh agent process so the new credentials take effect.
      onActiveProviderChanged?.()

      return snapshot
    }
  )
  ipcMainHandle(
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
  ipcMainHandle(
    'settings:set-reasoning-effort',
    async (_event, request: SetReasoningEffortRequest) => {
      // Renderer payloads are untyped at runtime: reject anything outside the known levels instead
      // of persisting a value the agent-mapping layers can't interpret.
      if (!isReasoningEffort(request?.effort)) {
        throw new Error(`Unknown reasoning effort: ${String(request?.effort)}`)
      }

      log.info('set reasoning effort requested', { effort: request.effort })
      const snapshot = await service.setReasoningEffort(request.effort)
      const resolvedEffort = await service.resolveActiveReasoningEffort(request.effort)

      // Live-capable frameworks (Claude Code, Codex) apply the level to open sessions over ACP —
      // no respawn, the way a model switch feels. Others (opencode) bake effort into the spawn
      // config, so only the provider-switch reconnect can deliver it.
      const appliedLive = (await onReasoningEffortChanged?.(resolvedEffort)) ?? false

      if (!appliedLive) {
        onActiveProviderChanged?.()
      }

      return snapshot
    }
  )
  ipcMainHandle(
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
  ipcMainHandle(
    'settings:set-conversation-skill-import-enabled',
    async (_event, request: SetConversationSkillImportEnabledRequest) => {
      if (typeof request?.enabled !== 'boolean') {
        throw new Error(
          `Invalid conversation-skill-import-enabled flag: ${String(request?.enabled)}`
        )
      }

      log.info('set conversation Skill import enabled requested', { enabled: request.enabled })
      const snapshot = await service.setConversationSkillImportEnabled(request.enabled)
      // Reuse the existing deferred reconnect: an active turn finishes with its current tool set;
      // the next session/resume gets a matching MCP list and system prompt.
      onSkillsChanged?.()
      return snapshot
    }
  )
  ipcMainHandle(
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
  ipcMainHandle('settings:list-app-icons', (): AppIconPreview[] => listAppIconPreviews?.() ?? [])
  ipcMainHandle(
    'settings:set-app-icon-variant',
    async (_event, request: SetAppIconVariantRequest) => {
      // Renderer payloads are untyped at runtime: only a known variant may persist.
      if (!isAppIconVariant(request?.variant)) {
        throw new Error(`Unknown app icon variant: ${String(request?.variant)}`)
      }

      log.info('set app icon variant requested', { variant: request.variant })
      const snapshot = await service.setAppIconVariant(request.variant)

      // Apply live to the window + dock/taskbar so the change is visible without a restart.
      onAppIconVariantChanged?.(request.variant)

      return snapshot
    }
  )
  ipcMainHandle('settings:validate-provider', (_event, request: ValidateProviderRequest) =>
    service.validateProvider(request)
  )
  ipcMainHandle('settings:cancel-codex-login', () => service.cancelCodexLogin())
  ipcMainHandle('settings:cancel-claude-login', () => service.cancelClaudeLogin())
  ipcMainHandle('settings:login-shared-claude', async () => {
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
  ipcMainHandle('settings:logout-shared-claude', async () => {
    const result = await service.logoutClaudeShared()

    if (result.ok) {
      const snapshot = await service.getSettingsView()
      if (snapshot.activeProviderId === CLAUDE_SHARED_PROVIDER_ID) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMainHandle('settings:login-isolated-claude', async (_event, token: string) => {
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
  ipcMainHandle('settings:login-isolated-claude-browser', async () => {
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
  ipcMainHandle('settings:cancel-isolated-claude-login', async () => {
    await service.cancelClaudeIsolatedLogin()
  })
  ipcMainHandle('settings:logout-isolated-claude', async () => {
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
  ipcMainHandle('settings:login-isolated-codex', async () => {
    const result = await service.loginIsolatedCodex()

    // A fresh login changes the credentials the live agent relies on; reconnect so it picks them
    // up. Skip when the outcome was discarded by a mid-flow switch to imported auth — reconnecting
    // the imported runtime would be redundant (its credentials didn't change).
    if (result.ok && result.applied !== false) {
      const snapshot = await service.getSettingsView()
      const active = snapshot.providers.find(
        (provider) => provider.id === snapshot.activeProviderId
      )
      if (
        snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID &&
        active?.type === 'codex-isolated' &&
        active.codexAuthMode === 'isolated'
      ) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMainHandle('settings:logout-isolated-codex', async () => {
    const result = await service.logoutIsolatedCodex()

    // Reconnect only when the app-owned credential was actually removed. If local cleanup fails,
    // keep the live agent untouched because it may still hold the credential in memory.
    if (result.ok) {
      const snapshot = await service.getSettingsView()
      if (snapshot.activeProviderId === CODEX_SUBSCRIPTION_PROVIDER_ID) {
        onActiveProviderChanged?.()
      }
    }

    return result
  })
  ipcMainHandle(
    'settings:refresh-provider-models',
    (_event, request: RefreshProviderModelsRequest) => service.refreshProviderModels(request)
  )
  ipcMainHandle('settings:mark-onboarding-complete', () => service.markOnboardingComplete())

  ipcMainHandle('settings:get-package-mirror', () => service.getPackageMirror())
  ipcMainHandle('settings:set-package-mirror', (_event, request: SetPackageMirrorRequest) =>
    service.setPackageMirror(request)
  )

  ipcMainHandle('settings:list-skills', () => service.listSkills())
  ipcMainHandle('settings:get-skill-detail', (_event, id: string) => service.getSkillDetail(id))
  ipcMainHandle('settings:set-skill-enabled', async (_event, request: SetSkillEnabledRequest) => {
    const skills = await service.setSkillEnabled(request)

    // A toggle takes effect on the next reconnect: the runtime re-provisions (re-materializes) the
    // config dir and resumes the open session with full context on its next message.
    onSkillsChanged?.()

    return skills
  })
  ipcMainHandle('settings:create-skill', async (_event, request: CreateSkillRequest) => {
    const skills = await service.createSkill(request)
    onSkillsChanged?.()
    return skills
  })
  ipcMainHandle('settings:update-skill', async (_event, request: UpdateSkillRequest) => {
    const skills = await service.updateSkill(request)
    onSkillsChanged?.()
    return skills
  })
  ipcMainHandle('settings:delete-skill', async (_event, request: DeleteSkillRequest) => {
    const skills = await service.deleteSkill(request)
    onSkillsChanged?.()
    return skills
  })
  ipcMainHandle('settings:import-skill', async (_event, request: ImportSkillRequest) => {
    const result = await service.importSkill(request)
    onSkillsChanged?.()
    return result
  })
  ipcMainHandle('settings:import-skill-zip', async (_event, request: ImportSkillZipRequest) => {
    const result = await service.importSkillZip(request)
    onSkillsChanged?.()
    return result
  })
  ipcMainHandle(
    'settings:import-skill-zip-batch',
    async (_event, request: ImportSkillZipBatchRequest) => {
      const result = await service.importSkillZipBatch(request)
      onSkillsChanged?.()
      return result
    }
  )
  ipcMainHandle('settings:preview-skill-zip', (_event, request: PreviewSkillZipRequest) =>
    service.previewSkillZip(request)
  )
  ipcMainHandle('settings:preview-github-skill', (_event, request: PreviewGitHubSkillRequest) =>
    service.previewGitHubSkill(request)
  )
  ipcMainHandle('settings:scan-repo-skills', (_event, request: ScanRepoRequest) =>
    service.scanRepoSkills(request)
  )
  // Lists the generic global skill source plus the active framework's source. Read-only — the
  // renderer submits checked source-id/slug pairs through the batch import handler below.
  ipcMainHandle('settings:list-agent-home-skills', () => service.listAgentHomeSkills())
  ipcMainHandle(
    'settings:preview-agent-home-skill',
    (_event, request: PreviewAgentHomeSkillRequest) => service.previewAgentHomeSkill(request)
  )
  ipcMainHandle(
    'settings:import-agent-home-skills',
    async (_event, request: ImportAgentHomeSkillsRequest) => {
      const result = await service.importAgentHomeSkills(request)
      if (result.results.some((item) => item.status === 'imported' || item.status === 'updated')) {
        onSkillsChanged?.()
      }

      return result
    }
  )

  ipcMainHandle('settings:list-connectors', () => service.listConnectors())
  ipcMainHandle('settings:get-connector-detail', (_event, id: string) =>
    service.getConnectorDetail(id)
  )
  ipcMainHandle(
    'settings:set-connector-enabled',
    async (_event, request: SetConnectorEnabledRequest) => {
      const snapshot = await service.setConnectorEnabled(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMainHandle(
    'settings:set-connector-auto-allow',
    async (_event, request: SetConnectorAutoAllowRequest) => {
      const snapshot = await service.setConnectorAutoAllow(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMainHandle(
    'settings:set-tool-permission',
    async (_event, request: SetToolPermissionRequest) => {
      const detail = await service.setToolPermission(request)
      onConnectorsChanged?.()
      return detail
    }
  )
  ipcMainHandle(
    'settings:set-ncbi-credentials',
    async (_event, request: SetNcbiCredentialsRequest) => {
      const snapshot = await service.setNcbiCredentials(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMainHandle('settings:add-custom-server', async (_event, request: AddCustomServerRequest) => {
    const snapshot = await service.addCustomServer(request)
    onConnectorsChanged?.()
    return snapshot
  })
  ipcMainHandle(
    'settings:set-custom-server-enabled',
    async (_event, request: SetCustomServerEnabledRequest) => {
      const snapshot = await service.setCustomServerEnabled(request)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMainHandle(
    'settings:remove-custom-server',
    async (_event, request: RemoveCustomServerRequest) => {
      const serverId = (await service.getConnectors())?.customMcpServers?.find(
        (server) => server.id === request.id
      )?.id
      const snapshot = await service.removeCustomServer(request)
      if (serverId) await onCustomServerRemoved?.(serverId)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  ipcMainHandle(
    'settings:update-custom-server',
    async (_event, request: UpdateCustomServerRequest) => {
      const snapshot = await service.updateCustomServer(request, onCustomServerSecurityChanged)
      onConnectorsChanged?.()
      return snapshot
    }
  )
  // Compute file browser bookmarks: keyed by provider_id in settings.computeBookmarks.
  ipcMainHandle('compute:bookmarks:get', (_event, providerId: string) =>
    service.getComputeBookmarks(providerId)
  )
  ipcMainHandle('compute:bookmarks:set', (_event, providerId: string, folders: string[]) =>
    service.setComputeBookmarks(providerId, folders)
  )
}

export { SETTINGS_INSTALL_LOG_CHANNEL, registerSettingsIpcHandlers }
