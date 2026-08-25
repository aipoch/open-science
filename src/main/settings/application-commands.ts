import type {
  AppIconPreview,
  ClaudeInstallEvent,
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  PreviewAgentHomeSkillRequest,
  PreviewGitHubSkillRequest,
  PreviewSkillZipRequest,
  RefreshProviderModelsRequest,
  ScanRepoRequest,
  SaveGitHubTokenRequest,
  SetAppIconVariantRequest,
  SetClosePreferenceRequest,
  SetDefaultPermissionProfileRequest,
  SetNotificationsEnabledRequest,
  SetPackageMirrorRequest,
  SetNetworkProxyRequest,
  SetProjectFilesFilterRequest,
  SetReviewerModelRequest,
  SetSessionDetailsModelRequest,
  SetSubagentModelRequest,
  SetVisionModelRequest,
  ValidateProviderRequest
} from '../../shared/settings'
import {
  defineApplicationCommand,
  defineApplicationCommandGroup,
  type ApplicationCommandInstallation,
  type ApplicationCommandRegistrar
} from '../application-command-router'
import type { CallerContext } from '../caller-context'
import type { SettingsService } from './service'
import {
  readAppIconVariant,
  readClosePreference,
  readDefaultPermissionProfile,
  readGitHubToken,
  readNotificationsEnabled,
  readProjectFilesFilter,
  readReviewerModel,
  readSessionDetailsModel,
  readSubagentModel,
  readVisionModel
} from './transport-validation'
import type { AppearanceSettingsWorkflows } from './workflows/appearance'

type CoreSettingsCommandStore = Pick<
  SettingsService,
  | 'cancelClaudeLogin'
  | 'cancelCodexLogin'
  | 'cancelClaudeIsolatedLogin'
  | 'checkEnvironment'
  | 'detectClaude'
  | 'detectCodex'
  | 'detectOpencode'
  | 'getConnectorDetail'
  | 'getPackageMirror'
  | 'getGitHubTokenStatus'
  | 'getPreflight'
  | 'getSettingsView'
  | 'getSkillDetail'
  | 'installClaude'
  | 'installCodex'
  | 'installOpencode'
  | 'isEncryptionAvailable'
  | 'isNpmAvailable'
  | 'listConnectors'
  | 'listSkills'
  | 'markOnboardingComplete'
  | 'previewAgentHomeSkill'
  | 'previewGitHubSkill'
  | 'previewSkillZip'
  | 'refreshProviderModels'
  | 'scanRepoSkills'
  | 'saveGitHubToken'
  | 'removeGitHubToken'
  | 'setClosePreference'
  | 'setDefaultPermissionProfile'
  | 'setNotificationsEnabled'
  | 'setPackageMirror'
  | 'setNetworkProxy'
  | 'setProjectFilesFilter'
  | 'setReviewerModel'
  | 'setSessionDetailsModel'
  | 'setSubagentModel'
  | 'setVisionModel'
  | 'validateProvider'
>

type StoreResult<Method extends keyof CoreSettingsCommandStore> =
  CoreSettingsCommandStore[Method] extends (...args: infer _Args) => infer Result
    ? Awaited<Result>
    : never
type AppearanceResult = Awaited<ReturnType<AppearanceSettingsWorkflows['setAppIconVariant']>>

const settingsCoreApplicationCommands = Object.freeze({
  cancelClaudeLogin: defineApplicationCommand<
    'settings:cancel-claude-login',
    readonly [],
    StoreResult<'cancelClaudeLogin'>
  >('settings:cancel-claude-login'),
  cancelCodexLogin: defineApplicationCommand<
    'settings:cancel-codex-login',
    readonly [],
    StoreResult<'cancelCodexLogin'>
  >('settings:cancel-codex-login'),
  cancelIsolatedClaudeLogin: defineApplicationCommand<
    'settings:cancel-isolated-claude-login',
    readonly [],
    StoreResult<'cancelClaudeIsolatedLogin'>
  >('settings:cancel-isolated-claude-login'),
  checkEnvironment: defineApplicationCommand<
    'settings:check-environment',
    readonly [],
    StoreResult<'checkEnvironment'>
  >('settings:check-environment'),
  detectClaude: defineApplicationCommand<
    'settings:detect-claude',
    readonly [],
    StoreResult<'detectClaude'>
  >('settings:detect-claude'),
  detectCodex: defineApplicationCommand<
    'settings:detect-codex',
    readonly [],
    StoreResult<'detectCodex'>
  >('settings:detect-codex'),
  detectOpencode: defineApplicationCommand<
    'settings:detect-opencode',
    readonly [],
    StoreResult<'detectOpencode'>
  >('settings:detect-opencode'),
  getGitHubTokenStatus: defineApplicationCommand<
    'settings:get-github-token-status',
    readonly [],
    StoreResult<'getGitHubTokenStatus'>
  >('settings:get-github-token-status'),
  getConnectorDetail: defineApplicationCommand<
    'settings:get-connector-detail',
    readonly [id: string],
    StoreResult<'getConnectorDetail'>
  >('settings:get-connector-detail'),
  getPackageMirror: defineApplicationCommand<
    'settings:get-package-mirror',
    readonly [],
    StoreResult<'getPackageMirror'>
  >('settings:get-package-mirror'),
  getPreflight: defineApplicationCommand<
    'settings:get-preflight',
    readonly [],
    StoreResult<'getPreflight'>
  >('settings:get-preflight'),
  getSettings: defineApplicationCommand<
    'settings:get-settings',
    readonly [],
    StoreResult<'getSettingsView'>
  >('settings:get-settings'),
  getSkillDetail: defineApplicationCommand<
    'settings:get-skill-detail',
    readonly [id: string],
    StoreResult<'getSkillDetail'>
  >('settings:get-skill-detail'),
  installClaude: defineApplicationCommand<
    'settings:install-claude',
    readonly [request: InstallClaudeRequest],
    StoreResult<'installClaude'>
  >('settings:install-claude'),
  installCodex: defineApplicationCommand<
    'settings:install-codex',
    readonly [request: InstallCodexRequest],
    StoreResult<'installCodex'>
  >('settings:install-codex'),
  installOpencode: defineApplicationCommand<
    'settings:install-opencode',
    readonly [request: InstallOpencodeRequest],
    StoreResult<'installOpencode'>
  >('settings:install-opencode'),
  isEncryptionAvailable: defineApplicationCommand<
    'settings:encryption-available',
    readonly [],
    StoreResult<'isEncryptionAvailable'>
  >('settings:encryption-available'),
  isNpmAvailable: defineApplicationCommand<
    'settings:npm-available',
    readonly [],
    StoreResult<'isNpmAvailable'>
  >('settings:npm-available'),
  listAppIcons: defineApplicationCommand<'settings:list-app-icons', readonly [], AppIconPreview[]>(
    'settings:list-app-icons'
  ),
  listConnectors: defineApplicationCommand<
    'settings:list-connectors',
    readonly [],
    StoreResult<'listConnectors'>
  >('settings:list-connectors'),
  listSkills: defineApplicationCommand<
    'settings:list-skills',
    readonly [],
    StoreResult<'listSkills'>
  >('settings:list-skills'),
  markOnboardingComplete: defineApplicationCommand<
    'settings:mark-onboarding-complete',
    readonly [],
    StoreResult<'markOnboardingComplete'>
  >('settings:mark-onboarding-complete'),
  previewAgentHomeSkill: defineApplicationCommand<
    'settings:preview-agent-home-skill',
    readonly [request: PreviewAgentHomeSkillRequest],
    StoreResult<'previewAgentHomeSkill'>
  >('settings:preview-agent-home-skill'),
  previewGitHubSkill: defineApplicationCommand<
    'settings:preview-github-skill',
    readonly [request: PreviewGitHubSkillRequest],
    StoreResult<'previewGitHubSkill'>
  >('settings:preview-github-skill'),
  previewSkillZip: defineApplicationCommand<
    'settings:preview-skill-zip',
    readonly [request: PreviewSkillZipRequest],
    StoreResult<'previewSkillZip'>
  >('settings:preview-skill-zip'),
  refreshProviderModels: defineApplicationCommand<
    'settings:refresh-provider-models',
    readonly [request: RefreshProviderModelsRequest],
    StoreResult<'refreshProviderModels'>
  >('settings:refresh-provider-models'),
  scanRepoSkills: defineApplicationCommand<
    'settings:scan-repo-skills',
    readonly [request: ScanRepoRequest],
    StoreResult<'scanRepoSkills'>
  >('settings:scan-repo-skills'),
  saveGitHubToken: defineApplicationCommand<
    'settings:save-github-token',
    readonly [request: SaveGitHubTokenRequest],
    StoreResult<'saveGitHubToken'>
  >('settings:save-github-token'),
  removeGitHubToken: defineApplicationCommand<
    'settings:remove-github-token',
    readonly [],
    StoreResult<'removeGitHubToken'>
  >('settings:remove-github-token'),
  setAppIconVariant: defineApplicationCommand<
    'settings:set-app-icon-variant',
    readonly [request: SetAppIconVariantRequest],
    AppearanceResult
  >('settings:set-app-icon-variant'),
  setClosePreference: defineApplicationCommand<
    'settings:set-close-preference',
    readonly [request: SetClosePreferenceRequest],
    StoreResult<'setClosePreference'>
  >('settings:set-close-preference'),
  setDefaultPermissionProfile: defineApplicationCommand<
    'settings:set-default-permission-profile',
    readonly [request: SetDefaultPermissionProfileRequest],
    StoreResult<'setDefaultPermissionProfile'>
  >('settings:set-default-permission-profile'),
  setNotificationsEnabled: defineApplicationCommand<
    'settings:set-notifications-enabled',
    readonly [request: SetNotificationsEnabledRequest],
    StoreResult<'setNotificationsEnabled'>
  >('settings:set-notifications-enabled'),
  setPackageMirror: defineApplicationCommand<
    'settings:set-package-mirror',
    readonly [request: SetPackageMirrorRequest],
    StoreResult<'setPackageMirror'>
  >('settings:set-package-mirror'),
  setNetworkProxy: defineApplicationCommand<
    'settings:set-network-proxy',
    readonly [request: SetNetworkProxyRequest],
    StoreResult<'setNetworkProxy'>
  >('settings:set-network-proxy'),
  setProjectFilesFilter: defineApplicationCommand<
    'settings:set-project-files-filter',
    readonly [request: SetProjectFilesFilterRequest],
    StoreResult<'setProjectFilesFilter'>
  >('settings:set-project-files-filter'),
  setReviewerModel: defineApplicationCommand<
    'settings:set-reviewer-model',
    readonly [request: SetReviewerModelRequest],
    StoreResult<'setReviewerModel'>
  >('settings:set-reviewer-model'),
  setSessionDetailsModel: defineApplicationCommand<
    'settings:set-session-details-model',
    readonly [request: SetSessionDetailsModelRequest],
    StoreResult<'setSessionDetailsModel'>
  >('settings:set-session-details-model'),
  setSubagentModel: defineApplicationCommand<
    'settings:set-subagent-model',
    readonly [request: SetSubagentModelRequest],
    StoreResult<'setSubagentModel'>
  >('settings:set-subagent-model'),
  setVisionModel: defineApplicationCommand<
    'settings:set-vision-model',
    readonly [request: SetVisionModelRequest],
    StoreResult<'setVisionModel'>
  >('settings:set-vision-model'),
  validateProvider: defineApplicationCommand<
    'settings:validate-provider',
    readonly [request: ValidateProviderRequest],
    StoreResult<'validateProvider'>
  >('settings:validate-provider')
})

const settingsCoreApplicationCommandGroup = defineApplicationCommandGroup('settings-core', [
  settingsCoreApplicationCommands.cancelClaudeLogin,
  settingsCoreApplicationCommands.cancelCodexLogin,
  settingsCoreApplicationCommands.cancelIsolatedClaudeLogin,
  settingsCoreApplicationCommands.checkEnvironment,
  settingsCoreApplicationCommands.detectClaude,
  settingsCoreApplicationCommands.detectCodex,
  settingsCoreApplicationCommands.detectOpencode,
  settingsCoreApplicationCommands.getConnectorDetail,
  settingsCoreApplicationCommands.getGitHubTokenStatus,
  settingsCoreApplicationCommands.getPackageMirror,
  settingsCoreApplicationCommands.getPreflight,
  settingsCoreApplicationCommands.getSettings,
  settingsCoreApplicationCommands.getSkillDetail,
  settingsCoreApplicationCommands.installClaude,
  settingsCoreApplicationCommands.installCodex,
  settingsCoreApplicationCommands.installOpencode,
  settingsCoreApplicationCommands.isEncryptionAvailable,
  settingsCoreApplicationCommands.isNpmAvailable,
  settingsCoreApplicationCommands.listAppIcons,
  settingsCoreApplicationCommands.listConnectors,
  settingsCoreApplicationCommands.listSkills,
  settingsCoreApplicationCommands.markOnboardingComplete,
  settingsCoreApplicationCommands.previewAgentHomeSkill,
  settingsCoreApplicationCommands.previewGitHubSkill,
  settingsCoreApplicationCommands.previewSkillZip,
  settingsCoreApplicationCommands.refreshProviderModels,
  settingsCoreApplicationCommands.scanRepoSkills,
  settingsCoreApplicationCommands.saveGitHubToken,
  settingsCoreApplicationCommands.removeGitHubToken,
  settingsCoreApplicationCommands.setAppIconVariant,
  settingsCoreApplicationCommands.setClosePreference,
  settingsCoreApplicationCommands.setDefaultPermissionProfile,
  settingsCoreApplicationCommands.setNotificationsEnabled,
  settingsCoreApplicationCommands.setPackageMirror,
  settingsCoreApplicationCommands.setNetworkProxy,
  settingsCoreApplicationCommands.setProjectFilesFilter,
  settingsCoreApplicationCommands.setReviewerModel,
  settingsCoreApplicationCommands.setSessionDetailsModel,
  settingsCoreApplicationCommands.setSubagentModel,
  settingsCoreApplicationCommands.setVisionModel,
  settingsCoreApplicationCommands.validateProvider
] as const)

type CoreSettingsApplicationCommandDependencies = Readonly<{
  service: CoreSettingsCommandStore
  appearance: Pick<AppearanceSettingsWorkflows, 'setAppIconVariant'>
  emitInstallEvent: (event: ClaudeInstallEvent) => void
  listAppIconPreviews?: () => AppIconPreview[]
}>

const requireLocalCaller = (context: CallerContext, channel: string): void => {
  if (context.location !== 'local') {
    throw new Error(`Channel only available from the local app: ${channel}`)
  }
}

const registerCoreSettingsApplicationCommands = (
  registrar: ApplicationCommandRegistrar,
  dependencies: CoreSettingsApplicationCommandDependencies
): ApplicationCommandInstallation => {
  const scope = registrar.createScope()

  try {
    scope.registerGroup(settingsCoreApplicationCommandGroup, {
      'settings:cancel-claude-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:cancel-claude-login')
        return dependencies.service.cancelClaudeLogin()
      },
      'settings:cancel-codex-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:cancel-codex-login')
        return dependencies.service.cancelCodexLogin()
      },
      'settings:cancel-isolated-claude-login': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:cancel-isolated-claude-login')
        return dependencies.service.cancelClaudeIsolatedLogin()
      },
      'settings:check-environment': () => dependencies.service.checkEnvironment(),
      'settings:detect-claude': () => dependencies.service.detectClaude(),
      'settings:detect-codex': () => dependencies.service.detectCodex(),
      'settings:detect-opencode': () => dependencies.service.detectOpencode(),
      'settings:get-connector-detail': ({ args }) =>
        dependencies.service.getConnectorDetail(args[0]),
      'settings:get-github-token-status': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:get-github-token-status')
        return dependencies.service.getGitHubTokenStatus()
      },
      'settings:get-package-mirror': () => dependencies.service.getPackageMirror(),
      'settings:get-preflight': () => dependencies.service.getPreflight(),
      'settings:get-settings': () => dependencies.service.getSettingsView(),
      'settings:get-skill-detail': ({ args }) => dependencies.service.getSkillDetail(args[0]),
      'settings:install-claude': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:install-claude')
        return dependencies.service.installClaude(args[0], dependencies.emitInstallEvent)
      },
      'settings:install-codex': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:install-codex')
        return dependencies.service.installCodex(args[0], dependencies.emitInstallEvent)
      },
      'settings:install-opencode': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:install-opencode')
        return dependencies.service.installOpencode(args[0], dependencies.emitInstallEvent)
      },
      'settings:encryption-available': () => dependencies.service.isEncryptionAvailable(),
      'settings:npm-available': () => dependencies.service.isNpmAvailable(),
      'settings:list-app-icons': () => dependencies.listAppIconPreviews?.() ?? [],
      'settings:list-connectors': () => dependencies.service.listConnectors(),
      'settings:list-skills': () => dependencies.service.listSkills(),
      'settings:mark-onboarding-complete': () => dependencies.service.markOnboardingComplete(),
      'settings:preview-agent-home-skill': ({ args }) =>
        dependencies.service.previewAgentHomeSkill(args[0]),
      'settings:preview-github-skill': ({ args }) =>
        dependencies.service.previewGitHubSkill(args[0]),
      'settings:preview-skill-zip': ({ args }) => dependencies.service.previewSkillZip(args[0]),
      'settings:refresh-provider-models': ({ args }) =>
        dependencies.service.refreshProviderModels(args[0]),
      'settings:scan-repo-skills': ({ args }) => dependencies.service.scanRepoSkills(args[0]),
      'settings:save-github-token': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:save-github-token')
        return dependencies.service.saveGitHubToken(readGitHubToken(args[0]))
      },
      'settings:remove-github-token': ({ callerContext }) => {
        requireLocalCaller(callerContext, 'settings:remove-github-token')
        return dependencies.service.removeGitHubToken()
      },
      'settings:set-app-icon-variant': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-app-icon-variant')
        return dependencies.appearance.setAppIconVariant(readAppIconVariant(args[0]))
      },
      'settings:set-close-preference': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-close-preference')
        return dependencies.service.setClosePreference(readClosePreference(args[0]))
      },
      'settings:set-default-permission-profile': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-default-permission-profile')
        return dependencies.service.setDefaultPermissionProfile(
          readDefaultPermissionProfile(args[0])
        )
      },
      'settings:set-notifications-enabled': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-notifications-enabled')
        return dependencies.service.setNotificationsEnabled(readNotificationsEnabled(args[0]))
      },
      'settings:set-package-mirror': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-package-mirror')
        return dependencies.service.setPackageMirror(args[0])
      },
      'settings:set-network-proxy': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-network-proxy')
        return dependencies.service.setNetworkProxy(args[0])
      },
      'settings:set-project-files-filter': ({ args, callerContext }) => {
        requireLocalCaller(callerContext, 'settings:set-project-files-filter')
        return dependencies.service.setProjectFilesFilter(readProjectFilesFilter(args[0]))
      },
      'settings:set-reviewer-model': ({ args }) =>
        dependencies.service.setReviewerModel(readReviewerModel(args[0])),
      'settings:set-session-details-model': ({ args }) =>
        dependencies.service.setSessionDetailsModel(readSessionDetailsModel(args[0])),
      'settings:set-subagent-model': ({ args }) =>
        dependencies.service.setSubagentModel(readSubagentModel(args[0])),
      'settings:set-vision-model': ({ args }) =>
        dependencies.service.setVisionModel(readVisionModel(args[0])),
      'settings:validate-provider': ({ args }) => dependencies.service.validateProvider(args[0])
    })
    return scope.complete()
  } catch (error) {
    scope.rollback()
    throw error
  }
}

export {
  registerCoreSettingsApplicationCommands,
  settingsCoreApplicationCommandGroup,
  settingsCoreApplicationCommands
}
export type { CoreSettingsApplicationCommandDependencies, CoreSettingsCommandStore }
