// Ordered fragments keep the public registration order when capabilities interleave.
import type {
  ClassificationSnapshot,
  ClassificationMutation,
  ClassificationMutationResult,
  ClassificationProbe,
  ClassificationProbeResult
} from '../classification'

import type {
  InstallMissingWslDependenciesRequest,
  InstallWslDistroRequest,
  OpenWslTerminalRequest,
  LocalShellRuntimePreference,
  SelectWslProfileRequest,
  SwitchToPowerShellResult,
  UseWsl2BashResult,
  WslPlatformInstallResult,
  Wsl2BashPreviewStatus,
  WslSetupSnapshot,
  WslSetupStatus,
  WslSetupConversationBootstrap
} from '../wsl-setup'

import type {
  SetPackageMirrorRequest,
  SetNetworkProxyRequest,
  SetNotebookNetworkRequest,
  SetAgentFrameworkRequest,
  SetNotificationsEnabledRequest,
  SetShowNotificationContentRequest,
  SetClosePreferenceRequest,
  SetProjectFilesFilterRequest,
  SetDefaultPermissionProfileRequest,
  SetAppIconVariantRequest,
  SetReasoningEffortRequest,
  SettingsSnapshot,
  AppIconPreview
} from '../settings'

import type { PackageMirror } from '../mirror'

import type { NetworkProxySettings } from '../network-proxy'

import type { NotebookNetworkSettings, NotebookNetworkStatus } from '../notebook-network'

import { callable, EVENT, ELECTRON_EVENT, LOCAL } from './definition'

export const settingsGetPackageMirrorContracts = {
  'settings.getPackageMirror': callable<() => Promise<PackageMirror>>()('settings', [
    'settings:get-package-mirror'
  ])
} as const

export const settingsGetSettingsContracts = {
  'settings.getSettings': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:get-settings'
  ])
} as const

export const settingsIsEncryptionAvailableContracts = {
  'settings.isEncryptionAvailable': callable<() => Promise<boolean>>()('settings', [
    'settings:encryption-available'
  ])
} as const

export const settingsListAppIconsContracts = {
  'settings.listAppIcons': callable<() => Promise<AppIconPreview[]>>()('settings', [
    'settings:list-app-icons'
  ])
} as const

export const settingsMarkOnboardingCompleteContracts = {
  'settings.markOnboardingComplete': callable<() => Promise<SettingsSnapshot>>()('settings', [
    'settings:mark-onboarding-complete'
  ]),
  'settings.onChanged': callable<(listener: (snapshot: SettingsSnapshot) => void) => () => void>()(
    'settings',
    ['settings:changed', EVENT]
  ),
  'settings.onWslSetupChanged': callable<
    (listener: (status: WslSetupStatus) => void) => () => void
  >()('settings', ['settings:wsl-setup-changed', ELECTRON_EVENT])
} as const

export const settingsSetAgentFrameworkContracts = {
  'settings.setAgentFramework': callable<
    (request: SetAgentFrameworkRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-agent-framework']),
  'settings.setAppIconVariant': callable<
    (request: SetAppIconVariantRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-app-icon-variant', LOCAL]),
  'settings.setClosePreference': callable<
    (request: SetClosePreferenceRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-close-preference', LOCAL])
} as const

export const settingsSetDefaultPermissionProfileContracts = {
  'settings.setDefaultPermissionProfile': callable<
    (request: SetDefaultPermissionProfileRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-default-permission-profile', LOCAL])
} as const

export const settingsGetClassificationContracts = {
  'settings.getClassification': callable<() => Promise<ClassificationSnapshot>>()('settings', [
    'settings:get-classification',
    LOCAL
  ]),
  'settings.updateClassification': callable<
    (request: ClassificationMutation) => Promise<ClassificationMutationResult>
  >()('settings', ['settings:update-classification', LOCAL]),
  'settings.testClassification': callable<
    (request: ClassificationProbe) => Promise<ClassificationProbeResult>
  >()('settings', ['settings:test-classification', LOCAL])
} as const

export const settingsSetNetworkProxyContracts = {
  'settings.setNetworkProxy': callable<
    (request: SetNetworkProxyRequest) => Promise<NetworkProxySettings>
  >()('settings', ['settings:set-network-proxy', LOCAL]),
  'settings.setNotebookNetwork': callable<
    (request: SetNotebookNetworkRequest) => Promise<NotebookNetworkSettings>
  >()('settings', ['settings:set-notebook-network', LOCAL]),
  'settings.getNotebookNetworkStatus': callable<() => Promise<NotebookNetworkStatus>>()(
    'settings',
    ['settings:get-notebook-network-status', LOCAL]
  ),
  'settings.getWsl2BashPreviewStatus': callable<() => Promise<Wsl2BashPreviewStatus>>()(
    'settings',
    ['settings:get-wsl2-bash-preview-status', LOCAL]
  ),
  'settings.getWslSetupStatus': callable<() => Promise<WslSetupStatus>>()('settings', [
    'settings:get-wsl-setup-status',
    LOCAL
  ]),
  'settings.getLocalShellRuntimePreference': callable<
    () => Promise<LocalShellRuntimePreference | undefined>
  >()('settings', ['settings:get-local-shell-runtime-preference', LOCAL]),
  'settings.probeWslSetup': callable<() => Promise<WslSetupSnapshot>>()('settings', [
    'settings:probe-wsl-setup',
    LOCAL
  ]),
  'settings.installWslPlatform': callable<() => Promise<WslPlatformInstallResult>>()('settings', [
    'settings:install-wsl-platform',
    LOCAL
  ]),
  'settings.installMissingWslDependencies': callable<
    (request: InstallMissingWslDependenciesRequest) => Promise<WslSetupSnapshot>
  >()('settings', ['settings:install-missing-wsl-dependencies', LOCAL]),
  'settings.createWslSupportHandoff': callable<() => Promise<WslSetupConversationBootstrap>>()(
    'settings',
    ['settings:create-wsl-support-handoff', LOCAL]
  ),
  'settings.selectWslProfile': callable<
    (request: SelectWslProfileRequest) => Promise<WslSetupSnapshot>
  >()('settings', ['settings:select-wsl-profile', LOCAL]),
  'settings.switchLocalShellToPowerShell': callable<() => Promise<SwitchToPowerShellResult>>()(
    'settings',
    ['settings:switch-local-shell-to-powershell', LOCAL]
  ),
  'settings.useWsl2Bash': callable<() => Promise<UseWsl2BashResult>>()('settings', [
    'settings:use-wsl2-bash',
    LOCAL
  ]),
  'settings.installRecommendedWslDistro': callable<
    (request: InstallWslDistroRequest) => Promise<WslSetupSnapshot>
  >()('settings', ['settings:install-recommended-wsl-distro', LOCAL]),
  'settings.openWslTerminal': callable<
    (request: OpenWslTerminalRequest) => Promise<WslSetupSnapshot>
  >()('settings', ['settings:open-wsl-terminal', LOCAL]),
  'settings.installNotebookNetwork': callable<() => Promise<NotebookNetworkStatus>>()('settings', [
    'settings:install-notebook-network',
    LOCAL
  ]),
  'settings.cancelNotebookNetworkSetup': callable<() => Promise<boolean>>()('settings', [
    'settings:cancel-notebook-network-setup',
    LOCAL
  ]),
  'settings.removeNotebookNetwork': callable<() => Promise<NotebookNetworkStatus>>()('settings', [
    'settings:remove-notebook-network',
    LOCAL
  ]),
  'settings.setNotificationsEnabled': callable<
    (request: SetNotificationsEnabledRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-notifications-enabled', LOCAL]),
  'settings.setShowNotificationContent': callable<
    (request: SetShowNotificationContentRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-show-notification-content', LOCAL]),
  'settings.setPackageMirror': callable<
    (request: SetPackageMirrorRequest) => Promise<PackageMirror>
  >()('settings', ['settings:set-package-mirror', LOCAL]),
  'settings.setProjectFilesFilter': callable<
    (request: SetProjectFilesFilterRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-project-files-filter', LOCAL]),
  'settings.setReasoningEffort': callable<
    (request: SetReasoningEffortRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-reasoning-effort'])
} as const
