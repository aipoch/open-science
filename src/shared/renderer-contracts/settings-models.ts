// Ordered fragments keep the public registration order when capabilities interleave.
import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  DeleteProviderRequest,
  EnvironmentCheckResult,
  XaiOAuthDeviceAuthorization,
  InstallClaudeRequest,
  InstallCodeBuddyRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SetActiveProviderRequest,
  SetReviewerModelRequest,
  SetSessionDetailsModelRequest,
  SetSubagentModelRequest,
  SetVisionModelRequest,
  SettingsSnapshot,
  UpsertProviderRequest,
  SaveValidatedProviderResult,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../settings'

import { callable, LOCAL, type AcpListener, type RemoveListener, EVENT } from './definition'

export const settingsBeginXaiOAuthLoginContracts = {
  'settings.beginXaiOAuthLogin': callable<() => Promise<XaiOAuthDeviceAuthorization>>()(
    'settings',
    ['settings:begin-xai-oauth-login', LOCAL]
  ),
  'settings.cancelClaudeLogin': callable<() => Promise<void>>()('settings', [
    'settings:cancel-claude-login',
    LOCAL
  ]),
  'settings.cancelCodexLogin': callable<() => Promise<void>>()('settings', [
    'settings:cancel-codex-login',
    LOCAL
  ])
} as const

export const settingsCancelIsolatedClaudeLoginContracts = {
  'settings.cancelIsolatedClaudeLogin': callable<() => Promise<void>>()('settings', [
    'settings:cancel-isolated-claude-login',
    LOCAL
  ]),
  'settings.cancelXaiOAuthLogin': callable<() => Promise<void>>()('settings', [
    'settings:cancel-xai-oauth-login',
    LOCAL
  ]),
  'settings.checkEnvironment': callable<() => Promise<EnvironmentCheckResult>>()('settings', [
    'settings:check-environment'
  ])
} as const

export const settingsDeleteProviderContracts = {
  'settings.deleteProvider': callable<
    (request: DeleteProviderRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:delete-provider'])
} as const

export const settingsDetectClaudeContracts = {
  'settings.detectClaude': callable<() => Promise<ClaudeDetectResult>>()('settings', [
    'settings:detect-claude'
  ]),
  'settings.detectCodeBuddy': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:detect-codebuddy'
  ]),
  'settings.detectCodex': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:detect-codex'
  ]),
  'settings.detectOpencode': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:detect-opencode'
  ])
} as const

export const settingsGetPreflightContracts = {
  'settings.getPreflight': callable<() => Promise<Preflight>>()('settings', [
    'settings:get-preflight'
  ])
} as const

export const settingsInstallClaudeContracts = {
  'settings.installClaude': callable<
    (request: InstallClaudeRequest) => Promise<ClaudeInstallResult>
  >()('settings', ['settings:install-claude', LOCAL]),
  'settings.installCodeBuddy': callable<
    (request: InstallCodeBuddyRequest) => Promise<ClaudeInstallResult>
  >()('settings', ['settings:install-codebuddy', LOCAL]),
  'settings.installCodex': callable<
    (request: InstallCodexRequest) => Promise<ClaudeInstallResult>
  >()('settings', ['settings:install-codex', LOCAL]),
  'settings.installOpencode': callable<
    (request: InstallOpencodeRequest) => Promise<ClaudeInstallResult>
  >()('settings', ['settings:install-opencode', LOCAL])
} as const

export const settingsIsNpmAvailableContracts = {
  'settings.isNpmAvailable': callable<() => Promise<boolean>>()('settings', [
    'settings:npm-available'
  ])
} as const

export const settingsLoginIsolatedClaudeContracts = {
  'settings.loginIsolatedClaude': callable<(token: string) => Promise<ValidateProviderResult>>()(
    'settings',
    ['settings:login-isolated-claude', LOCAL]
  ),
  'settings.loginIsolatedClaudeBrowser': callable<() => Promise<ValidateProviderResult>>()(
    'settings',
    ['settings:login-isolated-claude-browser', LOCAL]
  ),
  'settings.loginIsolatedCodex': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:login-isolated-codex',
    LOCAL
  ]),
  'settings.loginSharedClaude': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:login-shared-claude',
    LOCAL
  ]),
  'settings.logoutIsolatedClaude': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:logout-isolated-claude',
    LOCAL
  ]),
  'settings.logoutIsolatedCodex': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:logout-isolated-codex',
    LOCAL
  ]),
  'settings.logoutSharedClaude': callable<() => Promise<ValidateProviderResult>>()('settings', [
    'settings:logout-shared-claude',
    LOCAL
  ]),
  'settings.logoutXaiOAuth': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:logout-xai-oauth',
    LOCAL
  ])
} as const

export const settingsOnInstallLogContracts = {
  'settings.onInstallLog': callable<
    (listener: AcpListener<ClaudeInstallEvent>) => RemoveListener
  >()('settings', ['settings:install-log', EVENT])
} as const

export const settingsRefreshProviderModelsContracts = {
  'settings.refreshProviderModels': callable<
    (request: RefreshProviderModelsRequest) => Promise<RefreshProviderModelsResult>
  >()('settings', ['settings:refresh-provider-models'])
} as const

export const settingsSetActiveProviderContracts = {
  'settings.setActiveProvider': callable<
    (request: SetActiveProviderRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-active-provider'])
} as const

export const settingsSetReviewerModelContracts = {
  'settings.setReviewerModel': callable<
    (request: SetReviewerModelRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-reviewer-model']),
  'settings.setSessionDetailsModel': callable<
    (request: SetSessionDetailsModelRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-session-details-model'])
} as const

export const settingsSetSubagentModelContracts = {
  'settings.setSubagentModel': callable<
    (request: SetSubagentModelRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-subagent-model'])
} as const

export const settingsSetVisionModelContracts = {
  'settings.setVisionModel': callable<
    (request: SetVisionModelRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-vision-model']),
  'settings.uninstallClaude': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:uninstall-claude',
    LOCAL
  ]),
  'settings.uninstallCodeBuddy': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:uninstall-codebuddy',
    LOCAL
  ]),
  'settings.uninstallCodex': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:uninstall-codex',
    LOCAL
  ]),
  'settings.uninstallOpencode': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:uninstall-opencode',
    LOCAL
  ])
} as const

export const settingsUpsertProviderContracts = {
  'settings.upsertProvider': callable<
    (request: UpsertProviderRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:upsert-provider']),
  'settings.saveValidatedProvider': callable<
    (request: UpsertProviderRequest) => Promise<SaveValidatedProviderResult>
  >()('settings', ['settings:save-validated-provider']),
  'settings.validateProvider': callable<
    (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
  >()('settings', ['settings:validate-provider']),
  'settings.waitXaiOAuthLogin': callable<() => Promise<{ accountEmail?: string }>>()('settings', [
    'settings:wait-xai-oauth-login',
    LOCAL
  ])
} as const
