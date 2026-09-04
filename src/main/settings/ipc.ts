import { ipcMainHandle } from '../ipc-handler-registry'
import type { WebContents } from 'electron'

import {
  type AppIconPreview,
  type SetAppIconVariantRequest,
  type CreateSkillRequest,
  type DeleteProviderRequest,
  type DeleteSkillRequest,
  type ExportSkillRequest,
  type ExportSkillResult,
  type ImportAgentHomeSkillsRequest,
  type ImportSkillRequest,
  type ImportSkillZipRequest,
  type ImportSkillZipBatchRequest,
  type SaveGitHubTokenRequest,
  type PreviewAgentHomeSkillRequest,
  type PreviewGitHubSkillRequest,
  type PreviewSkillZipRequest,
  type ScanRepoRequest,
  type InstallClaudeRequest,
  type InstallCodeBuddyRequest,
  type InstallCodexRequest,
  type InstallOpencodeRequest,
  type ClaudeInstallEvent,
  type RefreshProviderModelsRequest,
  type SetActiveProviderRequest,
  type SetAgentFrameworkRequest,
  type AddCustomServerRequest,
  type CreateDeviceCredentialRequest,
  type DeviceCredentialAuthenticationRequest,
  type AuthenticateCustomServerRequest,
  type DisconnectCustomServerRequest,
  type ConnectorTemplateSelectionResult,
  type ExportCustomServerTemplateRequest,
  type ExportCustomServerTemplateResult,
  type RemoveCustomServerRequest,
  type RemoveDeviceCredentialRequest,
  type ResolveSkillDocumentRequest,
  type SelectCustomServerTemplateRequest,
  type SetCustomServerEnabledRequest,
  type UpdateCustomServerRequest,
  type UpdateDeviceCredentialRequest,
  type SetConnectorAutoAllowRequest,
  type SetConnectorEnabledRequest,
  type SetNcbiCredentialsRequest,
  type SetOpenAlexCredentialRequest,
  type ValidateOpenAlexCredentialRequest,
  type SetPackageMirrorRequest,
  type SetNetworkProxyRequest,
  type SetNotebookNetworkRequest,
  type SetClosePreferenceRequest,
  type SetDefaultPermissionProfileRequest,
  type SetConversationSkillImportEnabledRequest,
  type SetNotificationsEnabledRequest,
  type SetShowNotificationContentRequest,
  type SetProjectFilesFilterRequest,
  type SetReasoningEffortRequest,
  type SetReviewerModelRequest,
  type SetSessionDetailsModelRequest,
  type SetSubagentModelRequest,
  type SetVisionModelRequest,
  type SetSkillEnabledRequest,
  type SetSkillsEnabledRequest,
  type SetToolPermissionRequest,
  type UpdateSkillRequest,
  type UpsertProviderRequest,
  type ValidateProviderRequest
} from '../../shared/settings'
import { SettingsService } from './service'
import { connectorTemplateExportSelection } from './connector-template'
import type { SettingsWorkflows } from './workflows'
import { createLogger } from '../logger'
import type { SkillExportArchive } from '../skills/export'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { SettingsSnapshotCommitOwner } from './settings-snapshot-commit-owner'
import {
  readAppIconVariant,
  readClosePreference,
  readDefaultPermissionProfile,
  readGitHubToken,
  readConversationSkillImportEnabled,
  readIsolatedClaudeToken,
  readNotificationsEnabled,
  readShowNotificationContent,
  readProjectFilesFilter,
  readReasoningEffort,
  readReviewerModel,
  readSessionDetailsModel,
  readSubagentModel,
  readVisionModel
} from './transport-validation'

const log = createLogger('settings-ipc')

// IPC channel names for the settings/onboarding surface. Kept together so preload and main agree.
// Carries both log lines and progress ticks (a `ClaudeInstallEvent` discriminated union).
const SETTINGS_INSTALL_LOG_CHANNEL = 'settings:install-log'

export type SettingsIpcOptions = {
  service: SettingsService
  workflows: SettingsWorkflows
  snapshotCommits: SettingsSnapshotCommitOwner
  // Renders the built-in icon variants to preview data URLs for the Appearance picker. Absent means
  // the picker gets an empty list (no bundled assets available, e.g. an environment without them).
  listAppIconPreviews?: () => AppIconPreview[]
  connectorTemplateFiles?: {
    select(): Promise<
      { cancelled: true } | { cancelled: false; fileName: string; contents: string }
    >
    save(suggestedFileName: string, contents: string, sender: WebContents): Promise<boolean>
  }
  skillExportFiles?: {
    save(archive: SkillExportArchive, sender: WebContents): Promise<ExportSkillResult>
  }
}

// Streams one install event (log line or progress tick) to every open renderer window.
const broadcastInstallEvent = (event: ClaudeInstallEvent): void => {
  broadcastToRenderers(SETTINGS_INSTALL_LOG_CHANNEL, event)
}

// Registers renderer-callable settings commands. Secret handling stays entirely in the service; the
// handlers only marshal typed requests and forward install log streaming.
const registerSettingsIpcHandlers = ({
  service,
  workflows,
  snapshotCommits,
  listAppIconPreviews,
  connectorTemplateFiles,
  skillExportFiles
}: SettingsIpcOptions): void => {
  ipcMainHandle('settings:get-preflight', () => service.getPreflight())
  ipcMainHandle('settings:get-settings', () => snapshotCommits.readCurrentSnapshot())
  ipcMainHandle('settings:encryption-available', () => service.isEncryptionAvailable())
  ipcMainHandle('settings:npm-available', () => service.isNpmAvailable())
  ipcMainHandle('settings:check-environment', () =>
    snapshotCommits.projectAfter(service.checkEnvironment())
  )
  ipcMainHandle('settings:detect-claude', () =>
    snapshotCommits.projectAfter(service.detectClaude())
  )
  ipcMainHandle('settings:detect-codebuddy', () =>
    snapshotCommits.currentSnapshotAfter(service.detectCodeBuddy())
  )
  ipcMainHandle('settings:detect-opencode', () =>
    snapshotCommits.currentSnapshotAfter(service.detectOpencode())
  )
  ipcMainHandle('settings:detect-codex', () =>
    snapshotCommits.currentSnapshotAfter(service.detectCodex())
  )
  ipcMainHandle('settings:install-opencode', (_event, request: InstallOpencodeRequest) =>
    snapshotCommits.projectAfter(service.installOpencode(request, broadcastInstallEvent))
  )
  ipcMainHandle('settings:install-codebuddy', (_event, request: InstallCodeBuddyRequest) =>
    snapshotCommits.projectAfter(service.installCodeBuddy(request, broadcastInstallEvent))
  )
  ipcMainHandle('settings:install-codex', (_event, request: InstallCodexRequest) =>
    snapshotCommits.projectAfter(service.installCodex(request, broadcastInstallEvent))
  )

  ipcMainHandle('settings:install-claude', (_event, request: InstallClaudeRequest) =>
    snapshotCommits.projectAfter(service.installClaude(request, broadcastInstallEvent))
  )

  ipcMainHandle('settings:uninstall-claude', () =>
    snapshotCommits.currentSnapshotAfter(
      workflows.runtime.uninstallRuntime('uninstallClaude', 'claude-code')
    )
  )

  ipcMainHandle('settings:uninstall-opencode', () =>
    snapshotCommits.currentSnapshotAfter(
      workflows.runtime.uninstallRuntime('uninstallOpencode', 'opencode')
    )
  )

  ipcMainHandle('settings:uninstall-codebuddy', () =>
    snapshotCommits.currentSnapshotAfter(
      workflows.runtime.uninstallRuntime('uninstallCodeBuddy', 'codebuddy')
    )
  )

  ipcMainHandle('settings:uninstall-codex', () =>
    snapshotCommits.currentSnapshotAfter(
      workflows.runtime.uninstallRuntime('uninstallCodex', 'codex')
    )
  )

  ipcMainHandle('settings:upsert-provider', (_event, request: UpsertProviderRequest) =>
    snapshotCommits.currentSnapshotAfter(workflows.runtime.upsertProvider(request))
  )
  ipcMainHandle('settings:delete-provider', (_event, request: DeleteProviderRequest) =>
    snapshotCommits.currentSnapshotAfter(workflows.runtime.deleteProvider(request.id))
  )
  ipcMainHandle('settings:set-active-provider', (_event, request: SetActiveProviderRequest) =>
    snapshotCommits.currentSnapshotAfter(workflows.runtime.setActiveProvider(request))
  )
  ipcMainHandle(
    'settings:set-agent-framework',
    async (_event, request: SetAgentFrameworkRequest) => {
      log.info('set agent framework requested', { id: request.id })
      return snapshotCommits.currentSnapshotAfter(workflows.runtime.setAgentFramework(request))
    }
  )
  ipcMainHandle(
    'settings:set-reasoning-effort',
    async (_event, request: SetReasoningEffortRequest) => {
      const effort = readReasoningEffort(request)
      log.info('set reasoning effort requested', { effort })
      return snapshotCommits.currentSnapshotAfter(workflows.runtime.setReasoningEffort({ effort }))
    }
  )
  ipcMainHandle('settings:set-subagent-model', async (_event, request: SetSubagentModelRequest) => {
    const configuration = readSubagentModel(request)
    return snapshotCommits.currentSnapshotAfter(service.setSubagentModel(configuration))
  })
  ipcMainHandle('settings:set-reviewer-model', async (_event, request: SetReviewerModelRequest) => {
    const configuration = readReviewerModel(request)
    return snapshotCommits.currentSnapshotAfter(service.setReviewerModel(configuration))
  })
  ipcMainHandle(
    'settings:set-session-details-model',
    async (_event, request: SetSessionDetailsModelRequest) => {
      const configuration = readSessionDetailsModel(request)
      return snapshotCommits.currentSnapshotAfter(service.setSessionDetailsModel(configuration))
    }
  )
  ipcMainHandle('settings:set-vision-model', async (_event, request: SetVisionModelRequest) => {
    const configuration = readVisionModel(request)
    return snapshotCommits.currentSnapshotAfter(service.setVisionModel(configuration))
  })
  ipcMainHandle(
    'settings:set-notifications-enabled',
    async (_event, request: SetNotificationsEnabledRequest) => {
      const enabled = readNotificationsEnabled(request)
      log.info('set notifications enabled requested', { enabled })
      return snapshotCommits.currentSnapshotAfter(service.setNotificationsEnabled(enabled))
    }
  )
  ipcMainHandle(
    'settings:set-show-notification-content',
    async (_event, request: SetShowNotificationContentRequest) => {
      const enabled = readShowNotificationContent(request)
      log.info('set show notification content requested', { enabled })
      return snapshotCommits.currentSnapshotAfter(service.setShowNotificationContent(enabled))
    }
  )
  ipcMainHandle(
    'settings:set-conversation-skill-import-enabled',
    async (_event, request: SetConversationSkillImportEnabledRequest) => {
      const enabled = readConversationSkillImportEnabled(request)
      log.info('set conversation Skill import enabled requested', { enabled })
      return snapshotCommits.currentSnapshotAfter(
        workflows.skills.setConversationSkillImportEnabled({ enabled })
      )
    }
  )
  ipcMainHandle(
    'settings:set-close-preference',
    async (_event, request: SetClosePreferenceRequest) => {
      const preference = readClosePreference(request)
      log.info('set close preference requested', { preference: preference ?? 'ask' })
      return snapshotCommits.currentSnapshotAfter(service.setClosePreference(preference))
    }
  )
  ipcMainHandle(
    'settings:set-project-files-filter',
    async (_event, request: SetProjectFilesFilterRequest) => {
      const filter = readProjectFilesFilter(request)
      log.info('set project files filter requested', { filter: filter ?? 'default' })
      return snapshotCommits.currentSnapshotAfter(service.setProjectFilesFilter(filter))
    }
  )
  ipcMainHandle(
    'settings:set-default-permission-profile',
    async (_event, request: SetDefaultPermissionProfileRequest) => {
      const profile = readDefaultPermissionProfile(request)
      log.info('set default permission profile requested', { profile })
      return snapshotCommits.currentSnapshotAfter(service.setDefaultPermissionProfile(profile))
    }
  )
  ipcMainHandle('settings:list-app-icons', (): AppIconPreview[] => listAppIconPreviews?.() ?? [])
  ipcMainHandle(
    'settings:set-app-icon-variant',
    async (_event, request: SetAppIconVariantRequest) => {
      const variant = readAppIconVariant(request)
      log.info('set app icon variant requested', { variant })
      return snapshotCommits.currentSnapshotAfter(workflows.appearance.setAppIconVariant(variant))
    }
  )
  ipcMainHandle('settings:validate-provider', (_event, request: ValidateProviderRequest) =>
    snapshotCommits.projectAfter(service.validateProvider(request))
  )
  ipcMainHandle('settings:cancel-codex-login', () => service.cancelCodexLogin())
  ipcMainHandle('settings:cancel-claude-login', () => service.cancelClaudeLogin())
  ipcMainHandle('settings:login-shared-claude', () =>
    snapshotCommits.projectAfter(workflows.runtime.loginClaudeShared())
  )
  ipcMainHandle('settings:logout-shared-claude', () =>
    snapshotCommits.projectAfter(workflows.runtime.logoutClaudeShared())
  )
  ipcMainHandle('settings:login-isolated-claude', (_event, token: string) =>
    snapshotCommits.projectAfter(
      workflows.runtime.loginIsolatedClaude(readIsolatedClaudeToken(token))
    )
  )
  ipcMainHandle('settings:login-isolated-claude-browser', () =>
    snapshotCommits.projectAfter(workflows.runtime.loginIsolatedClaudeBrowser())
  )
  ipcMainHandle('settings:cancel-isolated-claude-login', async () => {
    await service.cancelClaudeIsolatedLogin()
  })
  ipcMainHandle('settings:logout-isolated-claude', () =>
    snapshotCommits.projectAfter(workflows.runtime.logoutIsolatedClaude())
  )
  ipcMainHandle('settings:login-isolated-codex', () =>
    snapshotCommits.projectAfter(workflows.runtime.loginIsolatedCodex())
  )
  ipcMainHandle('settings:logout-isolated-codex', () =>
    snapshotCommits.projectAfter(workflows.runtime.logoutIsolatedCodex())
  )
  ipcMainHandle('settings:begin-xai-oauth-login', () => workflows.runtime.beginXaiOAuthLogin())
  ipcMainHandle('settings:wait-xai-oauth-login', () =>
    snapshotCommits.projectAfter(workflows.runtime.waitXaiOAuthLogin())
  )
  ipcMainHandle('settings:cancel-xai-oauth-login', () => workflows.runtime.cancelXaiOAuthLogin())
  ipcMainHandle('settings:logout-xai-oauth', () =>
    snapshotCommits.currentSnapshotAfter(workflows.runtime.logoutXaiOAuth())
  )
  ipcMainHandle(
    'settings:refresh-provider-models',
    (_event, request: RefreshProviderModelsRequest) =>
      snapshotCommits.projectAfter(service.refreshProviderModels(request))
  )
  ipcMainHandle('settings:mark-onboarding-complete', () =>
    snapshotCommits.currentSnapshotAfter(service.markOnboardingComplete())
  )

  ipcMainHandle('settings:get-package-mirror', () => service.getPackageMirror())
  ipcMainHandle('settings:get-notebook-network-status', () => service.getNotebookNetworkStatus())
  ipcMainHandle('settings:set-package-mirror', (_event, request: SetPackageMirrorRequest) =>
    snapshotCommits.projectAfter(service.setPackageMirror(request))
  )
  ipcMainHandle('settings:set-network-proxy', (_event, request: SetNetworkProxyRequest) =>
    snapshotCommits.projectAfter(service.setNetworkProxy(request))
  )
  ipcMainHandle('settings:set-notebook-network', (_event, request: SetNotebookNetworkRequest) =>
    snapshotCommits.projectAfter(service.setNotebookNetwork(request))
  )
  ipcMainHandle('settings:install-notebook-network', () => service.installNotebookNetwork())
  ipcMainHandle('settings:remove-notebook-network', () => service.removeNotebookNetwork())

  ipcMainHandle('settings:list-skills', () => service.listSkills())
  ipcMainHandle('settings:get-github-token-status', () => service.getGitHubTokenStatus())
  ipcMainHandle('settings:save-github-token', (_event, request: SaveGitHubTokenRequest) =>
    service.saveGitHubToken(readGitHubToken(request))
  )
  ipcMainHandle('settings:remove-github-token', () => service.removeGitHubToken())
  ipcMainHandle('settings:get-skill-detail', (_event, id: string) => service.getSkillDetail(id))
  ipcMainHandle('settings:resolve-skill-document', (_event, request: ResolveSkillDocumentRequest) =>
    service.resolveSkillDocument(request)
  )
  ipcMainHandle('settings:export-skill', async (event, request: ExportSkillRequest) => {
    if (!skillExportFiles) throw new Error('Skill export is unavailable')
    return skillExportFiles.save(await service.buildSkillExport(request.id), event.sender)
  })
  ipcMainHandle('settings:set-skill-enabled', (_event, request: SetSkillEnabledRequest) =>
    workflows.skills.setSkillEnabled(request)
  )
  ipcMainHandle('settings:set-skills-enabled', (_event, request: SetSkillsEnabledRequest) =>
    workflows.skills.setSkillsEnabled(request)
  )
  ipcMainHandle('settings:create-skill', (_event, request: CreateSkillRequest) =>
    workflows.skills.createSkill(request)
  )
  ipcMainHandle('settings:update-skill', (_event, request: UpdateSkillRequest) =>
    workflows.skills.updateSkill(request)
  )
  ipcMainHandle('settings:delete-skill', (_event, request: DeleteSkillRequest) =>
    workflows.skills.deleteSkill(request)
  )
  ipcMainHandle('settings:import-skill', (_event, request: ImportSkillRequest) =>
    workflows.skills.importSkill(request)
  )
  ipcMainHandle('settings:import-skill-zip', (_event, request: ImportSkillZipRequest) =>
    workflows.skills.importSkillZip(request)
  )
  ipcMainHandle('settings:import-skill-zip-batch', (_event, request: ImportSkillZipBatchRequest) =>
    workflows.skills.importSkillZipBatch(request)
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
    (_event, request: ImportAgentHomeSkillsRequest) =>
      workflows.skills.importAgentHomeSkills(request)
  )

  ipcMainHandle('settings:list-connectors', () => service.listConnectors())
  ipcMainHandle('settings:retry-connector-projection', () =>
    workflows.connectors.retryConnectorProjection()
  )
  ipcMainHandle('settings:retry-custom-server', (_event, request: DisconnectCustomServerRequest) =>
    workflows.connectors.retryCustomServer(request)
  )
  ipcMainHandle('settings:preview-custom-server-template-export', (_event, id: string) =>
    service.previewCustomServerTemplateExport(id)
  )
  ipcMainHandle(
    'settings:select-custom-server-template',
    async (
      _event,
      request?: SelectCustomServerTemplateRequest
    ): Promise<ConnectorTemplateSelectionResult> => {
      if (request) {
        return {
          cancelled: false,
          fileName: request.fileName,
          preview: await service.previewCustomServerTemplateImport(request.contents)
        }
      }
      if (!connectorTemplateFiles) throw new Error('Connector configuration files are unavailable')
      const selected = await connectorTemplateFiles.select()
      if (selected.cancelled) return selected
      return {
        cancelled: false,
        fileName: selected.fileName,
        preview: await service.previewCustomServerTemplateImport(selected.contents)
      }
    }
  )
  ipcMainHandle(
    'settings:export-custom-server-template',
    async (
      event,
      request: ExportCustomServerTemplateRequest
    ): Promise<ExportCustomServerTemplateResult> => {
      if (!connectorTemplateFiles) throw new Error('Connector configuration files are unavailable')
      const result = await service.buildCustomServerTemplateExport(request.id)
      const selected = connectorTemplateExportSelection(result, request.format ?? 'open-science')
      if (
        !result.preview.ready ||
        !selected.digest ||
        !selected.suggestedFileName ||
        !selected.contents
      ) {
        throw new Error('Connector configuration is not safe to export')
      }
      if (selected.digest !== request.expectedDigest) {
        throw new Error('Connector configuration changed after preview; review it again')
      }
      return {
        saved: await connectorTemplateFiles.save(
          selected.suggestedFileName,
          selected.contents,
          event.sender
        )
      }
    }
  )
  ipcMainHandle('settings:get-connector-detail', (_event, id: string) =>
    service.getConnectorDetail(id)
  )
  ipcMainHandle('settings:set-connector-enabled', (_event, request: SetConnectorEnabledRequest) =>
    workflows.connectors.setConnectorEnabled(request)
  )
  ipcMainHandle(
    'settings:set-connector-auto-allow',
    (_event, request: SetConnectorAutoAllowRequest) =>
      workflows.connectors.setConnectorAutoAllow(request)
  )
  ipcMainHandle('settings:set-tool-permission', (_event, request: SetToolPermissionRequest) =>
    workflows.connectors.setToolPermission(request)
  )
  ipcMainHandle('settings:set-ncbi-credentials', (_event, request: SetNcbiCredentialsRequest) =>
    workflows.connectors.setNcbiCredentials(request)
  )
  ipcMainHandle('settings:list-device-credentials', () =>
    workflows.connectors.listDeviceCredentials()
  )
  ipcMainHandle(
    'settings:create-device-credential',
    (_event, request: CreateDeviceCredentialRequest) =>
      workflows.connectors.createDeviceCredential(request)
  )
  ipcMainHandle(
    'settings:update-device-credential',
    (_event, request: UpdateDeviceCredentialRequest) =>
      workflows.connectors.updateDeviceCredential(request)
  )
  ipcMainHandle(
    'settings:remove-device-credential',
    (_event, request: RemoveDeviceCredentialRequest) =>
      workflows.connectors.removeDeviceCredential(request)
  )
  ipcMainHandle(
    'settings:authenticate-device-credential',
    (_event, request: DeviceCredentialAuthenticationRequest) =>
      workflows.connectors.authenticateDeviceCredential(request)
  )
  ipcMainHandle(
    'settings:cancel-device-credential-authentication',
    (_event, request: DeviceCredentialAuthenticationRequest) =>
      workflows.connectors.cancelDeviceCredentialAuthentication(request)
  )
  ipcMainHandle(
    'settings:disconnect-device-credential',
    (_event, request: DeviceCredentialAuthenticationRequest) =>
      workflows.connectors.disconnectDeviceCredential(request)
  )
  ipcMainHandle(
    'settings:set-openalex-credential',
    (_event, request: SetOpenAlexCredentialRequest) =>
      workflows.connectors.setOpenAlexCredential(request)
  )
  ipcMainHandle(
    'settings:validate-openalex-credential',
    (_event, request: ValidateOpenAlexCredentialRequest) =>
      workflows.connectors.validateOpenAlexCredential(request)
  )
  ipcMainHandle('settings:add-custom-server', (_event, request: AddCustomServerRequest) =>
    workflows.connectors.addCustomServer(request)
  )
  ipcMainHandle(
    'settings:set-custom-server-enabled',
    (_event, request: SetCustomServerEnabledRequest) =>
      workflows.connectors.setCustomServerEnabled(request)
  )
  ipcMainHandle('settings:remove-custom-server', (_event, request: RemoveCustomServerRequest) =>
    workflows.connectors.removeCustomServer(request)
  )
  ipcMainHandle('settings:update-custom-server', (_event, request: UpdateCustomServerRequest) =>
    workflows.connectors.updateCustomServer(request)
  )
  ipcMainHandle(
    'settings:authenticate-custom-server',
    (_event, request: AuthenticateCustomServerRequest) =>
      workflows.connectors.authenticateCustomServer(request)
  )
  ipcMainHandle(
    'settings:cancel-custom-server-authentication',
    (_event, request: AuthenticateCustomServerRequest) =>
      workflows.connectors.cancelCustomServerAuthentication(request)
  )
  ipcMainHandle(
    'settings:disconnect-custom-server',
    (_event, request: AuthenticateCustomServerRequest) =>
      workflows.connectors.disconnectCustomServer(request)
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
