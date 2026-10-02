// Ordered fragments keep the public registration order when capabilities interleave.
import type {
  SkillMarketplaceCatalog,
  SkillMarketplaceCatalogRequest,
  SkillMarketplaceBatch,
  SkillMarketplaceBatchRequest,
  SkillMarketplaceBatchStartResult,
  SkillMarketplaceDetail,
  SkillMarketplaceDetailRequest,
  SkillMarketplaceInstallRequest,
  SkillMarketplaceInstallResult,
  SkillMarketplaceResult
} from '../skill-marketplace'

import type {
  SetConversationSkillImportEnabledRequest,
  SetSkillEnabledRequest,
  SetSkillsEnabledRequest,
  SettingsSnapshot,
  SkillDetailView,
  SkillView,
  CreateSkillRequest,
  UpdateSkillRequest,
  DeleteSkillRequest,
  ExportSkillRequest,
  ExportSkillResult,
  ImportSkillRequest,
  ImportSkillResult,
  ImportSkillZipRequest,
  ImportSkillZipBatchRequest,
  ImportSkillZipBatchResult,
  ImportAgentHomeSkillsRequest,
  ImportAgentHomeSkillsResult,
  AgentHomeSkillView,
  PreviewAgentHomeSkillRequest,
  PreviewGitHubSkillRequest,
  PreviewSkillZipRequest,
  ResolveSkillDocumentRequest,
  ResolvedSkillDocument,
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  ScanRepoRequest,
  ScanRepoResult,
  ConversationSkillImportApprovalRequest,
  ConversationSkillImportApprovalResponse
} from '../settings'

import {
  callable,
  ELECTRON,
  MAPPED_ELECTRON,
  type AcpListener,
  type RemoveListener,
  EVENT
} from './definition'

export const settingsCreateSkillContracts = {
  'settings.createSkill': callable<(request: CreateSkillRequest) => Promise<SkillView[]>>()(
    'settings',
    ['settings:create-skill']
  )
} as const

export const settingsDeleteSkillContracts = {
  'settings.deleteSkill': callable<(request: DeleteSkillRequest) => Promise<SkillView[]>>()(
    'settings',
    ['settings:delete-skill']
  )
} as const

export const settingsExportSkillContracts = {
  'settings.exportSkill': callable<(request: ExportSkillRequest) => Promise<ExportSkillResult>>()(
    'settings',
    ['settings:export-skill', ELECTRON]
  )
} as const

export const settingsListSkillMarketplaceContracts = {
  'settings.listSkillMarketplace': callable<
    (
      request?: SkillMarketplaceCatalogRequest
    ) => Promise<SkillMarketplaceResult<SkillMarketplaceCatalog>>
  >()('settings', ['settings:list-skill-marketplace']),
  'settings.getSkillMarketplaceDetail': callable<
    (
      request: SkillMarketplaceDetailRequest
    ) => Promise<SkillMarketplaceResult<SkillMarketplaceDetail>>
  >()('settings', ['settings:get-skill-marketplace-detail']),
  'settings.installSkillMarketplace': callable<
    (request: SkillMarketplaceInstallRequest) => Promise<SkillMarketplaceInstallResult>
  >()('settings', ['settings:install-skill-marketplace']),
  'settings.startSkillMarketplaceBatch': callable<
    (request: SkillMarketplaceBatchRequest) => Promise<SkillMarketplaceBatchStartResult>
  >()('settings', ['settings:start-skill-marketplace-batch']),
  'settings.getSkillMarketplaceBatch': callable<() => Promise<SkillMarketplaceBatch | null>>()(
    'settings',
    ['settings:get-skill-marketplace-batch']
  ),
  'settings.stopSkillMarketplaceBatch': callable<(id: string) => Promise<boolean>>()('settings', [
    'settings:stop-skill-marketplace-batch'
  ]),
  'settings.getSkillDetail': callable<(id: string) => Promise<SkillDetailView>>()('settings', [
    'settings:get-skill-detail'
  ]),
  'settings.resolveSkillDocument': callable<
    (request: ResolveSkillDocumentRequest) => Promise<ResolvedSkillDocument | null>
  >()('settings', ['settings:resolve-skill-document', ELECTRON]),
  'settings.importAgentHomeSkills': callable<
    (request: ImportAgentHomeSkillsRequest) => Promise<ImportAgentHomeSkillsResult>
  >()('settings', ['settings:import-agent-home-skills', MAPPED_ELECTRON]),
  'settings.importSkill': callable<(request: ImportSkillRequest) => Promise<ImportSkillResult>>()(
    'settings',
    ['settings:import-skill']
  ),
  'settings.importSkillZip': callable<
    (request: ImportSkillZipRequest) => Promise<ImportSkillResult>
  >()('settings', ['settings:import-skill-zip']),
  'settings.importSkillZipBatch': callable<
    (request: ImportSkillZipBatchRequest) => Promise<ImportSkillZipBatchResult>
  >()('settings', ['settings:import-skill-zip-batch'])
} as const

export const settingsListAgentHomeSkillsContracts = {
  'settings.listAgentHomeSkills': callable<() => Promise<AgentHomeSkillView[]>>()('settings', [
    'settings:list-agent-home-skills',
    MAPPED_ELECTRON
  ])
} as const

export const settingsListSkillsContracts = {
  'settings.listSkills': callable<() => Promise<SkillView[]>>()('settings', [
    'settings:list-skills'
  ])
} as const

export const settingsOnSkillCatalogChangedContracts = {
  'settings.onSkillCatalogChanged': callable<
    (listener: AcpListener<undefined>) => RemoveListener
  >()('settings', ['skills:catalog-changed', EVENT]),
  'settings.onSkillImportApprovalRequest': callable<
    (listener: AcpListener<ConversationSkillImportApprovalRequest>) => RemoveListener
  >()('settings', ['skills:conversation-import-request', EVENT]),
  'settings.onSkillImportApprovalSettled': callable<
    (listener: AcpListener<string>) => RemoveListener
  >()('settings', ['skills:conversation-import-settled', EVENT]),
  'settings.previewAgentHomeSkill': callable<
    (request: PreviewAgentHomeSkillRequest) => Promise<SkillImportPreviewContent>
  >()('settings', ['settings:preview-agent-home-skill'])
} as const

export const settingsPreviewGitHubSkillContracts = {
  'settings.previewGitHubSkill': callable<
    (request: PreviewGitHubSkillRequest) => Promise<SkillImportPreviewContent>
  >()('settings', ['settings:preview-github-skill']),
  'settings.previewSkillZip': callable<
    (request: PreviewSkillZipRequest) => Promise<SkillBundlePreviewResult>
  >()('settings', ['settings:preview-skill-zip'])
} as const

export const settingsReplayPendingSkillImportApprovalsContracts = {
  'settings.replayPendingSkillImportApprovals': callable<() => Promise<void>>()('settings', [
    'skills:conversation-import-replay-pending'
  ])
} as const

export const settingsRespondSkillImportApprovalContracts = {
  'settings.respondSkillImportApproval': callable<
    (response: ConversationSkillImportApprovalResponse) => Promise<void>
  >()('settings', ['skills:conversation-import-respond'])
} as const

export const settingsScanRepoSkillsContracts = {
  'settings.scanRepoSkills': callable<(request: ScanRepoRequest) => Promise<ScanRepoResult>>()(
    'settings',
    ['settings:scan-repo-skills']
  )
} as const

export const settingsSetConversationSkillImportEnabledContracts = {
  'settings.setConversationSkillImportEnabled': callable<
    (request: SetConversationSkillImportEnabledRequest) => Promise<SettingsSnapshot>
  >()('settings', ['settings:set-conversation-skill-import-enabled'])
} as const

export const settingsSetSkillEnabledContracts = {
  'settings.setSkillEnabled': callable<(request: SetSkillEnabledRequest) => Promise<SkillView[]>>()(
    'settings',
    ['settings:set-skill-enabled']
  ),
  'settings.setSkillsEnabled': callable<
    (request: SetSkillsEnabledRequest) => Promise<SkillView[]>
  >()('settings', ['settings:set-skills-enabled'])
} as const

export const settingsUpdateSkillContracts = {
  'settings.updateSkill': callable<(request: UpdateSkillRequest) => Promise<SkillView[]>>()(
    'settings',
    ['settings:update-skill']
  )
} as const
