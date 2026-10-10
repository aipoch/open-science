import { defineRendererContractGroup, type RendererContractGroup } from './renderer-contract'
import {
  composeRendererApiContract,
  expandEntry,
  type ContractValue,
  type RendererApiFromContract
} from './renderer-contracts/definition'
export type { RendererApiFromContract } from './renderer-contracts/definition'
import * as conversation from './renderer-contracts/conversation'
import * as acp from './renderer-contracts/acp'
import * as artifacts from './renderer-contracts/artifacts'
import * as system from './renderer-contracts/system'
import * as compute from './renderer-contracts/compute'
import * as files from './renderer-contracts/files'
import * as literature from './renderer-contracts/literature'
import * as memory from './renderer-contracts/memory'
import * as notebook from './renderer-contracts/notebook'
import * as sessionReplay from './renderer-contracts/session-replay'
import * as runObservation from './renderer-contracts/run-observation'
import * as researchRuns from './renderer-contracts/research-runs'
import * as researchDemos from './renderer-contracts/research-demos'
import * as researchExecutionProfiles from './renderer-contracts/research-execution-profiles'
import * as notifications from './renderer-contracts/notifications'
import * as previews from './renderer-contracts/previews'
import * as permissions from './renderer-contracts/permissions'
import * as projects from './renderer-contracts/projects'
import * as remoteAccess from './renderer-contracts/remote-access'
import * as reviewer from './renderer-contracts/reviewer'
import * as runtime from './renderer-contracts/runtime'
import * as settingsConnectors from './renderer-contracts/settings-connectors'
import * as settingsModels from './renderer-contracts/settings-models'
import * as settingsSkills from './renderer-contracts/settings-skills'
import * as settingsPreferences from './renderer-contracts/settings-preferences'
import * as specialist from './renderer-contracts/specialist'
import * as storage from './renderer-contracts/storage'
import * as update from './renderer-contracts/update'
import * as window from './renderer-contracts/window'

// Explicit composition preserves registration order without a second API inventory.
export const RENDERER_API_CONTRACT = composeRendererApiContract(
  conversation.backgroundResultDeliveryGetSessionActivityContracts,
  acp.contracts,
  artifacts.contracts,
  system.cliGetStatusContracts,
  compute.contracts,
  system.databaseStartupGetStateContracts,
  files.getRuntimeVersionsContracts,
  system.githubGetStarsContracts,
  conversation.handoffListContracts,
  system.lifecycleClaimRuntimeWriterContracts,
  files.localFsGetRootsContracts,
  system.logsGetStatusContracts,
  literature.contracts,
  files.managedFileVersionsCancelDiffContracts,
  memory.contracts,
  system.networkCheckConnectivityContracts,
  notebook.contracts,
  notifications.contracts,
  previews.officePreviewAttachFrameContracts,
  permissions.contracts,
  files.platformContracts,
  sessionReplay.contracts,
  runObservation.contracts,
  researchRuns.contracts,
  researchDemos.contracts,
  researchExecutionProfiles.contracts,
  previews.previewDeleteContracts,
  files.projectFilesGetOverviewContracts,
  projects.projectsCreateContracts,
  remoteAccess.contracts,
  reviewer.contracts,
  runtime.runtimeDescribeUsageContracts,
  files.saveBlobFileContracts,
  conversation.sessionsDeleteSessionContracts,
  settingsConnectors.settingsAddCustomServerContracts,
  settingsModels.settingsBeginXaiOAuthLoginContracts,
  settingsConnectors.settingsCancelCustomServerAuthenticationContracts,
  settingsModels.settingsCancelIsolatedClaudeLoginContracts,
  settingsSkills.settingsCreateSkillContracts,
  settingsModels.settingsDeleteProviderContracts,
  settingsSkills.settingsDeleteSkillContracts,
  settingsModels.settingsDetectClaudeContracts,
  settingsConnectors.settingsExportCustomServerTemplateContracts,
  settingsSkills.settingsExportSkillContracts,
  settingsConnectors.settingsGetConnectorDetailContracts,
  settingsPreferences.settingsGetPackageMirrorContracts,
  settingsModels.settingsGetPreflightContracts,
  settingsPreferences.settingsGetSettingsContracts,
  settingsSkills.settingsListSkillMarketplaceContracts,
  settingsModels.settingsInstallClaudeContracts,
  settingsPreferences.settingsIsEncryptionAvailableContracts,
  settingsModels.settingsIsNpmAvailableContracts,
  settingsSkills.settingsListAgentHomeSkillsContracts,
  settingsPreferences.settingsListAppIconsContracts,
  settingsConnectors.settingsListConnectorsContracts,
  settingsSkills.settingsListSkillsContracts,
  settingsModels.settingsLoginIsolatedClaudeContracts,
  settingsPreferences.settingsMarkOnboardingCompleteContracts,
  settingsConnectors.settingsOnConnectorApprovalRequestContracts,
  settingsModels.settingsOnInstallLogContracts,
  settingsSkills.settingsOnSkillCatalogChangedContracts,
  settingsConnectors.settingsPreviewCustomServerTemplateExportContracts,
  settingsSkills.settingsPreviewGitHubSkillContracts,
  settingsModels.settingsRefreshProviderModelsContracts,
  settingsConnectors.settingsRemoveCustomServerContracts,
  settingsSkills.settingsReplayPendingSkillImportApprovalsContracts,
  settingsConnectors.settingsRespondConnectorApprovalContracts,
  settingsSkills.settingsRespondSkillImportApprovalContracts,
  settingsConnectors.settingsRetryConnectorProjectionContracts,
  settingsSkills.settingsScanRepoSkillsContracts,
  settingsConnectors.settingsSelectCustomServerTemplateContracts,
  settingsModels.settingsSetActiveProviderContracts,
  settingsPreferences.settingsSetAgentFrameworkContracts,
  settingsConnectors.settingsSetConnectorAutoAllowContracts,
  settingsSkills.settingsSetConversationSkillImportEnabledContracts,
  settingsConnectors.settingsSetCustomServerEnabledContracts,
  settingsPreferences.settingsSetDefaultPermissionProfileContracts,
  settingsConnectors.settingsSetNcbiCredentialsContracts,
  settingsPreferences.settingsGetClassificationContracts,
  settingsConnectors.settingsSetOpenAlexCredentialContracts,
  settingsPreferences.settingsSetNetworkProxyContracts,
  settingsModels.settingsSetReviewerModelContracts,
  settingsSkills.settingsSetSkillEnabledContracts,
  settingsModels.settingsSetSubagentModelContracts,
  settingsConnectors.settingsSetToolPermissionContracts,
  settingsModels.settingsSetVisionModelContracts,
  settingsConnectors.settingsUpdateCustomServerContracts,
  settingsSkills.settingsUpdateSkillContracts,
  settingsModels.settingsUpsertProviderContracts,
  conversation.sideChatCancelContracts,
  previews.sourcePreviewOnNavigationBlockedContracts,
  specialist.contracts,
  storage.contracts,
  projects.bookmarksResolvePdfSourceContracts,
  previews.pdfAnnotationsListContracts,
  projects.tagsCreateContracts,
  update.updateApplyContracts,
  previews.pdfStructureReadCachedContracts,
  runtime.localModelsGetSnapshotContracts,
  update.updateOnProgressContracts,
  files.uploadsAbortTransferContracts,
  window.contracts
)

export type OpenScienceAPI = RendererApiFromContract<typeof RENDERER_API_CONTRACT>

export type RendererApiContractPath = keyof typeof RENDERER_API_CONTRACT
export type RendererApiContractValue<Path extends RendererApiContractPath> = ContractValue<
  (typeof RENDERER_API_CONTRACT)[Path]
>

const RENDERER_CONTRACTS_IN_REGISTRATION_ORDER = Object.freeze(
  Object.entries(RENDERER_API_CONTRACT).flatMap(([publicPath, draft]) =>
    draft.metadata === null ? [] : [Object.freeze(expandEntry(publicPath, draft))]
  )
)

export const RENDERER_CONTRACT_CATALOG = Object.freeze(
  [...RENDERER_CONTRACTS_IN_REGISTRATION_ORDER].sort((left, right) =>
    left.publicPath.localeCompare(right.publicPath)
  )
)

const contractsByCapability = new Map<string, (typeof RENDERER_CONTRACT_CATALOG)[number][]>()
for (const contract of RENDERER_CONTRACTS_IN_REGISTRATION_ORDER) {
  const contracts = contractsByCapability.get(contract.capability) ?? []
  contracts.push(contract)
  contractsByCapability.set(contract.capability, contracts)
}

const RENDERER_CAPABILITY_ORDER = Object.freeze([
  'acp',
  'artifacts',
  'cli',
  'compute',
  'database-startup',
  'diagnostics',
  'github',
  'handoff',
  'lifecycle',
  'locale',
  'local-fs',
  'literature',
  'memory',
  'logs',
  'managed-file-versions',
  'network',
  'notebook',
  'notebook-environment',
  'notifications',
  'office-preview',
  'source-preview',
  'permissions',
  'platform-file-save',
  'preview',
  'preview-context-menu',
  'preview-resources',
  'project-files',
  'projects',
  'tags',
  'remote-access',
  'reviewer',
  'research-runs',
  'runtime',
  'sessions',
  'settings',
  'side-chat',
  'specialist',
  'storage',
  'update',
  'local-models',
  'pdf-structure',
  'uploads',
  'window'
] as const)

export const RENDERER_CONTRACT_GROUPS: readonly RendererContractGroup[] = Object.freeze(
  RENDERER_CAPABILITY_ORDER.map((capability) => {
    const contracts = contractsByCapability.get(capability)
    if (!contracts) throw new Error(`Renderer contract capability is empty: ${capability}`)
    return defineRendererContractGroup(capability, contracts)
  })
)

export const ELECTRON_APPLICATION_COMMAND_CHANNELS: readonly string[] = Object.freeze(
  RENDERER_CONTRACT_CATALOG.flatMap(
    ({ applicationCommand, channel, dispatchPolicy, kind, surfaceInstallation }) =>
      applicationCommand === 'runtime-validated' &&
      channel !== null &&
      kind === 'method' &&
      surfaceInstallation.electron === 'preload' &&
      dispatchPolicy.electron === 'electron-ipc-request'
        ? [channel]
        : []
  ).sort()
)
