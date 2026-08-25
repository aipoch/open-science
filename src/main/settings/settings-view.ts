import {
  DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
  type ProviderView,
  type SettingsSnapshot
} from '../../shared/settings'
import { resolveNetworkProxySettings } from '../../shared/network-proxy'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  listAgentFrameworks,
  type AgentFrameworkId
} from '../agent-framework'
import { toSettingsPreferencesSnapshot } from './preferences'
import type { StoredProvider, StoredSettings } from './types'

type ManagedRuntimeProjection = {
  isManagedRuntimePath: (frameworkId: AgentFrameworkId, path: string) => boolean
}

type ProviderViewProjection = {
  toProviderView: (provider: StoredProvider, activeModel?: string) => ProviderView
}

export const buildSettingsSnapshot = (
  settings: StoredSettings,
  runtimeManager: ManagedRuntimeProjection,
  providers: ProviderViewProjection
): SettingsSnapshot => {
  const preferences = toSettingsPreferencesSnapshot(settings)

  return {
    claude: settings.claude ?? {},
    opencode: { resolvedPath: settings.opencodePath, version: settings.opencodeVersion },
    codebuddy: { resolvedPath: settings.codebuddyPath, version: settings.codebuddyVersion },
    codex: {
      resolvedPath: settings.codex?.resolvedPath,
      version: settings.codex?.version,
      nativeVersion: settings.codex?.nativeVersion
    },
    claudeManaged: settings.claude?.resolvedPath
      ? runtimeManager.isManagedRuntimePath('claude-code', settings.claude.resolvedPath)
      : false,
    opencodeManaged: settings.opencodePath
      ? runtimeManager.isManagedRuntimePath('opencode', settings.opencodePath)
      : false,
    codebuddyManaged: settings.codebuddyPath
      ? runtimeManager.isManagedRuntimePath('codebuddy', settings.codebuddyPath)
      : false,
    codexManaged: settings.codex?.resolvedPath
      ? runtimeManager.isManagedRuntimePath('codex', settings.codex.resolvedPath)
      : false,
    activeProviderId: settings.activeProviderId,
    claudeSubscriptionProviderId: settings.claudeSubscriptionProviderId,
    activeModel: settings.activeModel,
    providers: settings.providers.map((provider) =>
      providers.toProviderView(
        provider,
        provider.id === settings.activeProviderId ? settings.activeModel : undefined
      )
    ),
    onboardingCompletedAt: preferences.onboardingCompletedAt,
    packageMirror: settings.packageMirror,
    networkProxy: resolveNetworkProxySettings(settings.networkProxy),
    reasoningEffort: preferences.reasoningEffort,
    subagentModel: settings.subagentModel ?? { mode: 'inherit' },
    reviewerModel: settings.reviewerModel ?? { mode: 'inherit' },
    sessionDetailsModel:
      settings.sessionDetailsModel ?? DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION,
    visionModel: settings.visionModel,
    notificationsEnabled: preferences.notificationsEnabled,
    conversationSkillImportEnabled: preferences.conversationSkillImportEnabled,
    closePreference: preferences.closePreference,
    appIconVariant: preferences.appIconVariant,
    projectFilesFilter: preferences.projectFilesFilter,
    defaultPermissionProfile: preferences.defaultPermissionProfile,

    agentFrameworkId: settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID,
    agentFrameworks: listAgentFrameworks().map((framework) => ({
      id: framework.id,
      displayName: framework.displayName,
      supportsSkills: framework.supportsSkills,
      supportsDelegatedWork: framework.supportsDelegatedWork,
      supportedApiTypes: [...framework.supportedApiTypes]
    }))
  }
}
