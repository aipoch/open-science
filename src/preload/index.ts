import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

import { unwrapApplicationCommandOutcome } from '../shared/application-command-contract'
import { createElectronRendererContractAdapter } from './electron-renderer-contract-adapter'
import type { OpenScienceAPI } from './renderer-api'

import type { ComputeApprovalDecision, ComputeApprovalRequest, JobSummary } from '../shared/compute'
import type {
  InitializeLocalePreferenceRequest,
  SetLocalePreferenceRequest
} from '../shared/locale'
import type { NotebookLanguage } from '../shared/notebook'
import type { DiscoveredInterpreter } from '../shared/notebook-runtime'
import type {
  AddCustomServerRequest,
  AuthenticateCustomServerRequest,
  ExportCustomServerTemplateRequest,
  CreateSkillRequest,
  DeleteSkillRequest,
  ExportSkillRequest,
  ImportAgentHomeSkillsRequest,
  ImportSkillRequest,
  SaveGitHubTokenRequest,
  ImportSkillZipBatchRequest,
  ImportSkillZipRequest,
  InstallCodexRequest,
  PreviewAgentHomeSkillRequest,
  PreviewGitHubSkillRequest,
  PreviewSkillZipRequest,
  RemoveCustomServerRequest,
  RespondApprovalRequest,
  ScanRepoRequest,
  SelectCustomServerTemplateRequest,
  SetConnectorAutoAllowRequest,
  SetConnectorEnabledRequest,
  SetCustomServerEnabledRequest,
  SetNcbiCredentialsRequest,
  SetSkillEnabledRequest,
  SetSkillsEnabledRequest,
  SetToolPermissionRequest,
  UpdateCustomServerRequest,
  UpdateSkillRequest
} from '../shared/settings'
import type {
  CompletionHandoffCommand,
  CreateSpecialistRequest,
  DuplicateSpecialistRequest,
  ResolveSessionSpecialistRequest,
  SetSessionSpecialistRequest,
  SetSpecialistEnabledRequest,
  UpdateSpecialistRequest
} from '../shared/specialist'
import type {
  SpecialistDeleteRequest,
  SpecialistExportRequest,
  SpecialistPackageInstallRequest
} from '../shared/specialist-package'
import type {
  AddMarketplaceSourceRequest,
  CancelMarketplaceCandidateRequest,
  GetMarketplaceReleaseRequest,
  InspectGitHubMarketplaceSourceRequest,
  ListMarketplaceRequest,
  MarketplaceDownloadProgress,
  MarketplaceInstallRequest,
  PrepareMarketplaceInstallRequest,
  RemoveMarketplaceSourceRequest
} from '../shared/specialist-marketplace'
import type {
  ReviewRunRequest,
  ReviewSessionRequest,
  ReviewSuppressionEvent
} from '../shared/reviewer'
import type { HandoffEventsRequest, HandoffRetryRequest } from '../shared/handoff-lifecycle'
import type {
  SideChatCloseRequest,
  SideChatPromptRequest,
  SideChatSessionRequest,
  SideChatStartRequest
} from '../shared/side-chat'
import type { SourcePreviewLoadState } from '../shared/source-preview'
import { announceWindowFindReady, subscribeCloseActivePane } from '../shared/window-controls'

type RemoveListener = () => void
type AcpListener<Payload> = (payload: Payload) => void

// Subscribes to one IPC channel and returns a renderer-safe unsubscribe callback.
const onIpcMessage = <Payload>(channel: string, listener: AcpListener<Payload>): RemoveListener => {
  const wrappedListener = (_event: IpcRendererEvent, payload: Payload): void => listener(payload)

  ipcRenderer.on(channel, wrappedListener)

  return () => {
    ipcRenderer.removeListener(channel, wrappedListener)
  }
}

const electronRendererContracts = createElectronRendererContractAdapter({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
  getPathForFile: (file) => webUtils.getPathForFile(file as File)
})

// Exposes the small, typed bridge surface available to renderer code.
const api: OpenScienceAPI = {
  saveBlobFile: (request) => electronRendererContracts.invoke('saveBlobFile', request),
  saveManagedFile: (request) => electronRendererContracts.invoke('saveManagedFile', request),
  saveSessionArtifacts: (request) =>
    electronRendererContracts.invoke('saveSessionArtifacts', request),
  saveProjectArtifacts: (request) =>
    electronRendererContracts.invoke('saveProjectArtifacts', request),
  platform: process.platform,
  getRuntimeVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }),
  lifecycle: {
    getClientId: () => electronRendererContracts.invoke('lifecycle.getClientId')
  },
  locale: {
    initialize: (request: InitializeLocalePreferenceRequest) =>
      electronRendererContracts.invoke('locale.initialize', request),
    setPreference: (request: SetLocalePreferenceRequest) =>
      electronRendererContracts.invoke('locale.setPreference', request),
    onChanged: (listener) => electronRendererContracts.subscribe('locale.onChanged', listener)
  },
  databaseStartup: {
    getState: () => electronRendererContracts.invoke('databaseStartup.getState'),
    retry: () => electronRendererContracts.invoke('databaseStartup.retry'),
    quit: () => electronRendererContracts.invoke('databaseStartup.quit'),
    onStateChanged: (listener) =>
      electronRendererContracts.subscribe('databaseStartup.onStateChanged', listener)
  },
  diagnostics: {
    reportRendererFailure: (report) =>
      electronRendererContracts.send('diagnostics.reportRendererFailure', report)
  },
  acp: {
    getState: () => electronRendererContracts.invoke('acp.getState'),
    getPlanProjection: (projectId, sessionId) =>
      electronRendererContracts.invoke('acp.getPlanProjection', projectId, sessionId),
    respondPlan: (request) => electronRendererContracts.invoke('acp.respondPlan', request),
    connect: (request) => electronRendererContracts.invoke('acp.connect', request),
    disconnect: () => electronRendererContracts.invoke('acp.disconnect'),
    createSession: (request) => electronRendererContracts.invoke('acp.createSession', request),
    resumeSession: (request) => electronRendererContracts.invoke('acp.resumeSession', request),
    continueInterruptedTurn: (request) =>
      electronRendererContracts.invoke('acp.continueInterruptedTurn', request),
    resetSessionContext: (request) =>
      electronRendererContracts.invoke('acp.resetSessionContext', request),
    sendPrompt: (request) => electronRendererContracts.invoke('acp.sendPrompt', request),
    steerFollowUp: (request) => electronRendererContracts.invoke('acp.steerFollowUp', request),
    saveAsSkill: (request) => electronRendererContracts.invoke('acp.saveAsSkill', request),
    compactSession: (request) => electronRendererContracts.invoke('acp.compactSession', request),
    cancel: (request) => electronRendererContracts.invoke('acp.cancel', request),
    deleteSession: (request) => electronRendererContracts.invoke('acp.deleteSession', request),
    respondToPermission: (response) =>
      electronRendererContracts.invoke('acp.respondToPermission', response),
    respondToElicitation: (response) =>
      electronRendererContracts.invoke('acp.respondToElicitation', response),
    setPermissionProfile: (request) =>
      electronRendererContracts.invoke('acp.setPermissionProfile', request),
    revokePermissionGrant: (request) =>
      electronRendererContracts.invoke('acp.revokePermissionGrant', request),
    onState: (listener) => electronRendererContracts.subscribe('acp.onState', listener),
    onAgentRuntimeUpdate: (listener) =>
      electronRendererContracts.subscribe('acp.onAgentRuntimeUpdate', listener),
    onEvent: (listener) => electronRendererContracts.subscribe('acp.onEvent', listener),
    onPermissionRequest: (listener) =>
      electronRendererContracts.subscribe('acp.onPermissionRequest', listener)
  },
  sideChat: {
    list: () => electronRendererContracts.invoke('sideChat.list'),
    start: (request: SideChatStartRequest) =>
      electronRendererContracts.invoke('sideChat.start', request),
    send: (request: SideChatPromptRequest) =>
      electronRendererContracts.invoke('sideChat.send', request),
    cancel: (request: SideChatSessionRequest) =>
      electronRendererContracts.invoke('sideChat.cancel', request),
    close: (request: SideChatCloseRequest) =>
      electronRendererContracts.invoke('sideChat.close', request),
    onEvent: (listener) => electronRendererContracts.subscribe('sideChat.onEvent', listener),
    onRelayDelivered: (listener) =>
      electronRendererContracts.subscribe('sideChat.onRelayDelivered', listener)
  },
  permissions: {
    list: () => electronRendererContracts.invoke('permissions.list'),
    revoke: (request) => electronRendererContracts.invoke('permissions.revoke', request),
    extendUndo: (request) => electronRendererContracts.invoke('permissions.extendUndo', request),
    restore: (request) => electronRendererContracts.invoke('permissions.restore', request),
    onChanged: (listener) => electronRendererContracts.subscribe('permissions.onChanged', listener)
  },
  sessions: {
    // Lists lightweight SQLite-backed Session metadata without reading transcript JSON files.
    list: () => electronRendererContracts.invoke('sessions.list'),
    // Loads every per-session file plus the last-open manifest from the main process.
    loadAll: () => electronRendererContracts.invoke('sessions.loadAll'),
    // Loads one durable Session without scanning unrelated Project/Session files.
    loadOne: (request) => electronRendererContracts.invoke('sessions.loadOne', request),
    loadUsage: () => electronRendererContracts.invoke('sessions.loadUsage'),
    // Persists a single sanitized session file.
    saveSession: async (session, options) =>
      unwrapApplicationCommandOutcome(
        await electronRendererContracts.invoke('sessions.saveSession', session, options)
      ),
    updateArchive: (request) => electronRendererContracts.invoke('sessions.updateArchive', request),
    // Removes one session file.
    deleteSession: (request) => electronRendererContracts.invoke('sessions.deleteSession', request),
    // Persists the last-open project/session pointer.
    saveManifest: (request) => electronRendererContracts.invoke('sessions.saveManifest', request),
    // Exports the authoritative persisted active branch through a main-owned Save As flow.
    exportConversation: (request) =>
      electronRendererContracts.invoke('sessions.exportConversation', request),
    onFlushAborted: (listener) =>
      electronRendererContracts.subscribe('sessions.onFlushAborted', listener),
    onFlushRequest: (listener) =>
      electronRendererContracts.subscribe('sessions.onFlushRequest', listener),
    sendFlushResponse: (response) =>
      electronRendererContracts.send('sessions.sendFlushResponse', response),
    onCreated: (listener) => electronRendererContracts.subscribe('sessions.onCreated', listener),
    onUpdated: (listener) => electronRendererContracts.subscribe('sessions.onUpdated', listener),
    onDeleted: (listener) => electronRendererContracts.subscribe('sessions.onDeleted', listener)
  },
  settings: {
    // Model-settings/onboarding surface: secrets stay in main, the renderer only sees masked views.
    getPreflight: () => electronRendererContracts.invoke('settings.getPreflight'),
    getSettings: () => electronRendererContracts.invoke('settings.getSettings'),
    isEncryptionAvailable: () => electronRendererContracts.invoke('settings.isEncryptionAvailable'),
    isNpmAvailable: () => electronRendererContracts.invoke('settings.isNpmAvailable'),
    checkEnvironment: () => electronRendererContracts.invoke('settings.checkEnvironment'),
    detectClaude: () => electronRendererContracts.invoke('settings.detectClaude'),
    detectOpencode: () => electronRendererContracts.invoke('settings.detectOpencode'),
    detectCodex: () => electronRendererContracts.invoke('settings.detectCodex'),
    installClaude: (request) => electronRendererContracts.invoke('settings.installClaude', request),
    installOpencode: (request) =>
      electronRendererContracts.invoke('settings.installOpencode', request),
    installCodex: (request: InstallCodexRequest) =>
      electronRendererContracts.invoke('settings.installCodex', request),
    uninstallClaude: () => electronRendererContracts.invoke('settings.uninstallClaude'),
    uninstallOpencode: () => electronRendererContracts.invoke('settings.uninstallOpencode'),
    uninstallCodex: () => electronRendererContracts.invoke('settings.uninstallCodex'),
    upsertProvider: (request) =>
      electronRendererContracts.invoke('settings.upsertProvider', request),
    deleteProvider: (request) =>
      electronRendererContracts.invoke('settings.deleteProvider', request),
    setActiveProvider: (request) =>
      electronRendererContracts.invoke('settings.setActiveProvider', request),
    setAgentFramework: (request) =>
      electronRendererContracts.invoke('settings.setAgentFramework', request),
    setReasoningEffort: (request) =>
      electronRendererContracts.invoke('settings.setReasoningEffort', request),
    setReviewerModel: (request) =>
      electronRendererContracts.invoke('settings.setReviewerModel', request),
    setSubagentModel: (request) =>
      electronRendererContracts.invoke('settings.setSubagentModel', request),
    setVisionModel: (request) =>
      electronRendererContracts.invoke('settings.setVisionModel', request),
    onChanged: (listener) => electronRendererContracts.subscribe('settings.onChanged', listener),
    setNotificationsEnabled: (request) =>
      electronRendererContracts.invoke('settings.setNotificationsEnabled', request),
    setConversationSkillImportEnabled: (request) =>
      electronRendererContracts.invoke('settings.setConversationSkillImportEnabled', request),
    setClosePreference: (request) =>
      electronRendererContracts.invoke('settings.setClosePreference', request),
    setProjectFilesFilter: (request) =>
      electronRendererContracts.invoke('settings.setProjectFilesFilter', request),
    setDefaultPermissionProfile: (request) =>
      electronRendererContracts.invoke('settings.setDefaultPermissionProfile', request),

    setAppIconVariant: (request) =>
      electronRendererContracts.invoke('settings.setAppIconVariant', request),
    listAppIcons: () => electronRendererContracts.invoke('settings.listAppIcons'),
    validateProvider: (request) =>
      electronRendererContracts.invoke('settings.validateProvider', request),
    cancelCodexLogin: () => electronRendererContracts.invoke('settings.cancelCodexLogin'),
    cancelClaudeLogin: () => electronRendererContracts.invoke('settings.cancelClaudeLogin'),
    beginXaiOAuthLogin: () => electronRendererContracts.invoke('settings.beginXaiOAuthLogin'),
    waitXaiOAuthLogin: () => electronRendererContracts.invoke('settings.waitXaiOAuthLogin'),
    cancelXaiOAuthLogin: () => electronRendererContracts.invoke('settings.cancelXaiOAuthLogin'),
    logoutXaiOAuth: () => electronRendererContracts.invoke('settings.logoutXaiOAuth'),
    loginIsolatedCodex: () => electronRendererContracts.invoke('settings.loginIsolatedCodex'),
    logoutIsolatedCodex: () => electronRendererContracts.invoke('settings.logoutIsolatedCodex'),
    loginSharedClaude: () => electronRendererContracts.invoke('settings.loginSharedClaude'),
    logoutSharedClaude: () => electronRendererContracts.invoke('settings.logoutSharedClaude'),
    // The Claude subscription's setup-token paste. Same shape as the codex login, but the renderer
    // supplies the token (no browser flow), so the payload is the plaintext string itself.
    loginIsolatedClaude: (token: string) =>
      electronRendererContracts.invoke('settings.loginIsolatedClaude', token),
    loginIsolatedClaudeBrowser: () =>
      electronRendererContracts.invoke('settings.loginIsolatedClaudeBrowser'),
    cancelIsolatedClaudeLogin: () =>
      electronRendererContracts.invoke('settings.cancelIsolatedClaudeLogin'),
    logoutIsolatedClaude: () => electronRendererContracts.invoke('settings.logoutIsolatedClaude'),
    refreshProviderModels: (request) =>
      electronRendererContracts.invoke('settings.refreshProviderModels', request),
    markOnboardingComplete: () =>
      electronRendererContracts.invoke('settings.markOnboardingComplete'),
    getPackageMirror: () => electronRendererContracts.invoke('settings.getPackageMirror'),
    setPackageMirror: (request) =>
      electronRendererContracts.invoke('settings.setPackageMirror', request),
    setNetworkProxy: (request) =>
      electronRendererContracts.invoke('settings.setNetworkProxy', request),
    listSkills: () => electronRendererContracts.invoke('settings.listSkills'),
    getGitHubTokenStatus: () => electronRendererContracts.invoke('settings.getGitHubTokenStatus'),
    saveGitHubToken: (request: SaveGitHubTokenRequest) =>
      electronRendererContracts.invoke('settings.saveGitHubToken', request),
    removeGitHubToken: () => electronRendererContracts.invoke('settings.removeGitHubToken'),
    getSkillDetail: (id: string) => electronRendererContracts.invoke('settings.getSkillDetail', id),
    exportSkill: (request: ExportSkillRequest) =>
      electronRendererContracts.invoke('settings.exportSkill', request),
    setSkillEnabled: (request: SetSkillEnabledRequest) =>
      electronRendererContracts.invoke('settings.setSkillEnabled', request),
    setSkillsEnabled: (request: SetSkillsEnabledRequest) =>
      electronRendererContracts.invoke('settings.setSkillsEnabled', request),
    createSkill: (request: CreateSkillRequest) =>
      electronRendererContracts.invoke('settings.createSkill', request),
    updateSkill: (request: UpdateSkillRequest) =>
      electronRendererContracts.invoke('settings.updateSkill', request),
    deleteSkill: (request: DeleteSkillRequest) =>
      electronRendererContracts.invoke('settings.deleteSkill', request),
    importSkill: (request: ImportSkillRequest) =>
      electronRendererContracts.invoke('settings.importSkill', request),
    importSkillZip: (request: ImportSkillZipRequest) =>
      electronRendererContracts.invoke('settings.importSkillZip', request),
    importSkillZipBatch: (request: ImportSkillZipBatchRequest) =>
      electronRendererContracts.invoke('settings.importSkillZipBatch', request),
    previewSkillZip: (request: PreviewSkillZipRequest) =>
      electronRendererContracts.invoke('settings.previewSkillZip', request),
    previewGitHubSkill: (request: PreviewGitHubSkillRequest) =>
      electronRendererContracts.invoke('settings.previewGitHubSkill', request),
    scanRepoSkills: (request: ScanRepoRequest) =>
      electronRendererContracts.invoke('settings.scanRepoSkills', request),
    // Lists installed skills from the shared global source plus the active framework's source.
    listAgentHomeSkills: () => electronRendererContracts.invoke('settings.listAgentHomeSkills'),
    previewAgentHomeSkill: (request: PreviewAgentHomeSkillRequest) =>
      electronRendererContracts.invoke('settings.previewAgentHomeSkill', request),
    importAgentHomeSkills: (request: ImportAgentHomeSkillsRequest) =>
      electronRendererContracts.invoke('settings.importAgentHomeSkills', request),
    listConnectors: () => electronRendererContracts.invoke('settings.listConnectors'),
    previewCustomServerTemplateExport: (id: string) =>
      electronRendererContracts.invoke('settings.previewCustomServerTemplateExport', id),
    selectCustomServerTemplate: (request?: SelectCustomServerTemplateRequest) =>
      electronRendererContracts.invoke('settings.selectCustomServerTemplate', request),
    exportCustomServerTemplate: (request: ExportCustomServerTemplateRequest) =>
      electronRendererContracts.invoke('settings.exportCustomServerTemplate', request),
    getConnectorDetail: (id: string) =>
      electronRendererContracts.invoke('settings.getConnectorDetail', id),
    setConnectorEnabled: (request: SetConnectorEnabledRequest) =>
      electronRendererContracts.invoke('settings.setConnectorEnabled', request),
    setConnectorAutoAllow: (request: SetConnectorAutoAllowRequest) =>
      electronRendererContracts.invoke('settings.setConnectorAutoAllow', request),
    setToolPermission: (request: SetToolPermissionRequest) =>
      electronRendererContracts.invoke('settings.setToolPermission', request),
    setNcbiCredentials: (request: SetNcbiCredentialsRequest) =>
      electronRendererContracts.invoke('settings.setNcbiCredentials', request),
    addCustomServer: (request: AddCustomServerRequest) =>
      electronRendererContracts.invoke('settings.addCustomServer', request),
    setCustomServerEnabled: (request: SetCustomServerEnabledRequest) =>
      electronRendererContracts.invoke('settings.setCustomServerEnabled', request),
    removeCustomServer: (request: RemoveCustomServerRequest) =>
      electronRendererContracts.invoke('settings.removeCustomServer', request),
    updateCustomServer: (request: UpdateCustomServerRequest) =>
      electronRendererContracts.invoke('settings.updateCustomServer', request),
    authenticateCustomServer: (request: AuthenticateCustomServerRequest) =>
      electronRendererContracts.invoke('settings.authenticateCustomServer', request),
    cancelCustomServerAuthentication: (request: AuthenticateCustomServerRequest) =>
      electronRendererContracts.invoke('settings.cancelCustomServerAuthentication', request),
    retryCustomServer: (request: AuthenticateCustomServerRequest) =>
      electronRendererContracts.invoke('settings.retryCustomServer', request),
    // Fires when a connector call needs the user's approval (external data-egress gate).
    onConnectorApprovalRequest: (listener) =>
      electronRendererContracts.subscribe('settings.onConnectorApprovalRequest', listener),
    onConnectorApprovalSettled: (listener) =>
      electronRendererContracts.subscribe('settings.onConnectorApprovalSettled', listener),
    onConnectorRuntimeChanged: (listener) =>
      electronRendererContracts.subscribe('settings.onConnectorRuntimeChanged', listener),
    onSkillCatalogChanged: (listener) =>
      electronRendererContracts.subscribe('settings.onSkillCatalogChanged', listener),
    onSkillImportApprovalRequest: (listener) =>
      electronRendererContracts.subscribe('settings.onSkillImportApprovalRequest', listener),
    onSkillImportApprovalSettled: (listener) =>
      electronRendererContracts.subscribe('settings.onSkillImportApprovalSettled', listener),
    replayPendingSkillImportApprovals: () =>
      electronRendererContracts.invoke('settings.replayPendingSkillImportApprovals'),
    replayConnectorApproval: (id: string) =>
      electronRendererContracts.invoke('settings.replayConnectorApproval', id),
    replayPendingConnectorApprovals: () =>
      electronRendererContracts.invoke('settings.replayPendingConnectorApprovals'),
    respondSkillImportApproval: (response) =>
      electronRendererContracts.invoke('settings.respondSkillImportApproval', response),
    respondConnectorApproval: (request: RespondApprovalRequest) =>
      electronRendererContracts.invoke('settings.respondConnectorApproval', request),
    // Streams live installer output while a one-click install runs.
    onInstallLog: (listener) =>
      electronRendererContracts.subscribe('settings.onInstallLog', listener)
  },
  remoteAccess: {
    getSnapshot: () => electronRendererContracts.invoke('remoteAccess.getSnapshot'),
    detect: () => electronRendererContracts.invoke('remoteAccess.detect'),
    disable: () => electronRendererContracts.invoke('remoteAccess.disable'),
    setMode: (request) => electronRendererContracts.invoke('remoteAccess.setMode', request),
    approve: (request) => electronRendererContracts.invoke('remoteAccess.approve', request),
    reject: (request) => electronRendererContracts.invoke('remoteAccess.reject', request),
    revokeBrowser: (request) =>
      electronRendererContracts.invoke('remoteAccess.revokeBrowser', request),
    onChanged: (listener) =>
      electronRendererContracts.subscribe('remoteAccess.onChanged', () => listener())
  },
  specialist: {
    list: () => electronRendererContracts.invoke('specialist.list'),
    listMarketplace: (request?: ListMarketplaceRequest) =>
      electronRendererContracts.invoke('specialist.listMarketplace', request),
    inspectGitHubMarketplaceSource: (request: InspectGitHubMarketplaceSourceRequest) =>
      electronRendererContracts.invoke('specialist.inspectGitHubMarketplaceSource', request),
    addMarketplaceSource: (request: AddMarketplaceSourceRequest) =>
      electronRendererContracts.invoke('specialist.addMarketplaceSource', request),
    removeMarketplaceSource: (request: RemoveMarketplaceSourceRequest) =>
      electronRendererContracts.invoke('specialist.removeMarketplaceSource', request),
    getMarketplaceRelease: (request: GetMarketplaceReleaseRequest) =>
      electronRendererContracts.invoke('specialist.getMarketplaceRelease', request),
    prepareMarketplaceInstall: (request: PrepareMarketplaceInstallRequest) =>
      electronRendererContracts.invoke('specialist.prepareMarketplaceInstall', request),
    cancelMarketplaceCandidate: (request: CancelMarketplaceCandidateRequest) =>
      electronRendererContracts.invoke('specialist.cancelMarketplaceCandidate', request),
    onMarketplaceDownloadProgress: (listener: AcpListener<MarketplaceDownloadProgress>) =>
      electronRendererContracts.subscribe('specialist.onMarketplaceDownloadProgress', listener),
    installMarketplace: (request: MarketplaceInstallRequest) =>
      electronRendererContracts.invoke('specialist.installMarketplace', request),
    create: (request: CreateSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.create', request),
    update: (request: UpdateSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.update', request),
    setEnabled: (request: SetSpecialistEnabledRequest) =>
      electronRendererContracts.invoke('specialist.setEnabled', request),
    previewDelete: (request: { id: string }) =>
      electronRendererContracts.invoke('specialist.previewDelete', request),
    delete: (request: SpecialistDeleteRequest) =>
      electronRendererContracts.invoke('specialist.delete', request),
    duplicate: (request: DuplicateSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.duplicate', request),
    exportContributionTemplate: () =>
      electronRendererContracts.invoke('specialist.exportContributionTemplate'),
    previewExport: (request: { specialistId: string }) =>
      electronRendererContracts.invoke('specialist.previewExport', request),
    exportSpecialist: (request: SpecialistExportRequest) =>
      electronRendererContracts.invoke('specialist.exportSpecialist', request),
    selectPackage: () => electronRendererContracts.invoke('specialist.selectPackage'),
    installPackage: (request: SpecialistPackageInstallRequest) =>
      electronRendererContracts.invoke('specialist.installPackage', request),
    cancelPackage: (request: SpecialistPackageInstallRequest) =>
      electronRendererContracts.invoke('specialist.cancelPackage', request),
    savePackageReport: (request: SpecialistPackageInstallRequest) =>
      electronRendererContracts.invoke('specialist.savePackageReport', request),
    onCatalogChanged: (listener: () => void) =>
      electronRendererContracts.subscribe('specialist.onCatalogChanged', listener),
    // Compatibility-only pending-selection broadcast; approved SDK handoffs use lifecycle events.
    onPendingSwitch: (listener) =>
      electronRendererContracts.subscribe('specialist.onPendingSwitch', listener),
    getHandoffEvents: (sessionId: string) =>
      electronRendererContracts.invoke('specialist.getHandoffEvents', sessionId),
    onHandoffLifecycleEvent: (listener) =>
      electronRendererContracts.subscribe('specialist.onHandoffLifecycleEvent', listener),
    retryHandoff: (request: CompletionHandoffCommand) =>
      electronRendererContracts.invoke('specialist.retryHandoff', request),
    cancelHandoff: (request: CompletionHandoffCommand) =>
      electronRendererContracts.invoke('specialist.cancelHandoff', request),
    // Session switching (issue 07).
    setSessionSpecialist: (request: SetSessionSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.setSessionSpecialist', request),
    resolveSessionSpecialist: (request: ResolveSessionSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.resolveSessionSpecialist', request)
  },
  handoff: {
    list: (request: HandoffEventsRequest) =>
      electronRendererContracts.invoke('handoff.list', request),
    retry: (request: HandoffRetryRequest) =>
      electronRendererContracts.invoke('handoff.retry', request),
    onChanged: (listener) => electronRendererContracts.subscribe('handoff.onChanged', listener)
  },
  logs: {
    getPath: () => electronRendererContracts.invoke('logs.getPath'),
    openFile: () => electronRendererContracts.invoke('logs.openFile'),
    revealInFolder: () => electronRendererContracts.invoke('logs.revealInFolder')
  },
  notifications: {
    getSnapshot: () => electronRendererContracts.invoke('notifications.getSnapshot'),
    markAllRead: (request) =>
      electronRendererContracts.invoke('notifications.markAllRead', request),
    markRead: (request) => electronRendererContracts.invoke('notifications.markRead', request),
    markSessionCompletionsRead: (request) =>
      electronRendererContracts.invoke('notifications.markSessionCompletionsRead', request),
    onChanged: (listener) =>
      electronRendererContracts.subscribe('notifications.onChanged', listener),
    // Main-process task notifications route their click through this channel.
    onOpenSession: (listener) =>
      electronRendererContracts.subscribe('notifications.onOpenSession', listener),
    peekPendingOpenSession: () =>
      electronRendererContracts.invoke('notifications.peekPendingOpenSession'),
    takePendingOpenSession: (expectedToken) =>
      electronRendererContracts.invoke('notifications.takePendingOpenSession', expectedToken),
    syncViewState: (state) => electronRendererContracts.send('notifications.syncViewState', state),
    onViewProbe: (listener) =>
      electronRendererContracts.subscribe('notifications.onViewProbe', listener)
  },
  github: {
    getStars: () => electronRendererContracts.invoke('github.getStars')
  },
  network: {
    getInfo: () => electronRendererContracts.invoke('network.getInfo'),
    checkConnectivity: () => electronRendererContracts.invoke('network.checkConnectivity')
  },
  cli: {
    getStatus: () => electronRendererContracts.invoke('cli.getStatus'),
    install: () => electronRendererContracts.invoke('cli.install'),
    uninstall: () => electronRendererContracts.invoke('cli.uninstall')
  },
  update: {
    getAppInfo: () => electronRendererContracts.invoke('update.getAppInfo'),
    getStatus: () => electronRendererContracts.invoke('update.getStatus'),
    check: () => electronRendererContracts.invoke('update.check'),
    download: () => electronRendererContracts.invoke('update.download'),
    cancel: () => electronRendererContracts.invoke('update.cancel'),
    apply: () => electronRendererContracts.invoke('update.apply'),
    onStatus: (listener) => electronRendererContracts.subscribe('update.onStatus', listener),
    onProgress: (listener) => electronRendererContracts.subscribe('update.onProgress', listener)
  },
  projects: {
    // Project CRUD backed by the SQLite/Prisma layer (scope: projects only).
    list: () => electronRendererContracts.invoke('projects.list'),
    get: (id) => electronRendererContracts.invoke('projects.get', id),
    create: (request) => electronRendererContracts.invoke('projects.create', request),
    update: (request) => electronRendererContracts.invoke('projects.update', request),
    updateArchive: (request) => electronRendererContracts.invoke('projects.updateArchive', request),
    delete: (request) => electronRendererContracts.invoke('projects.delete', request),
    onCreated: (listener) => electronRendererContracts.subscribe('projects.onCreated', listener),
    onUpdated: (listener) => electronRendererContracts.subscribe('projects.onUpdated', listener),
    onDeleted: (listener) => electronRendererContracts.subscribe('projects.onDeleted', listener)
  },
  tags: {
    snapshot: () => electronRendererContracts.invoke('tags.snapshot'),
    create: (request) => electronRendererContracts.invoke('tags.create', request),
    update: (request) => electronRendererContracts.invoke('tags.update', request),
    delete: (request) => electronRendererContracts.invoke('tags.delete', request),
    reorder: (request) => electronRendererContracts.invoke('tags.reorder', request),
    setAssignment: (request) => electronRendererContracts.invoke('tags.setAssignment', request),
    onChanged: (listener) => electronRendererContracts.subscribe('tags.onChanged', listener)
  },
  // Files exposes metadata pages only. Thumbnail/full-preview bytes continue through the existing
  // artifact/upload APIs after a visible item has been selected or rendered.
  projectFiles: {
    getOverview: (request) => electronRendererContracts.invoke('projectFiles.getOverview', request),
    listFiles: (request) => electronRendererContracts.invoke('projectFiles.listFiles', request),
    listArtifactGroups: (request) =>
      electronRendererContracts.invoke('projectFiles.listArtifactGroups', request),
    searchArtifacts: (request) =>
      electronRendererContracts.invoke('projectFiles.searchArtifacts', request),
    repairIndex: (request) => electronRendererContracts.invoke('projectFiles.repairIndex', request),
    onChanged: (listener) => electronRendererContracts.subscribe('projectFiles.onChanged', listener)
  },
  compute: {
    // SSH compute host record CRUD, backed by the same SQLite/Prisma layer as projects.
    list: () => electronRendererContracts.invoke('compute.list'),
    get: (providerId) => electronRendererContracts.invoke('compute.get', providerId),
    create: (request) => electronRendererContracts.invoke('compute.create', request),
    createPassword: (request) =>
      electronRendererContracts.invoke('compute.createPassword', request),
    resetPassword: (request) => electronRendererContracts.invoke('compute.resetPassword', request),
    changeAuthentication: (request) =>
      electronRendererContracts.invoke('compute.changeAuthentication', request),
    passwordCapability: () => electronRendererContracts.invoke('compute.passwordCapability'),
    deletionStatus: (request) =>
      electronRendererContracts.invoke('compute.deletionStatus', request),
    delete: (request) => electronRendererContracts.invoke('compute.delete', request),
    sshConfigAliases: () => electronRendererContracts.invoke('compute.sshConfigAliases'),
    probe: (providerId) => electronRendererContracts.invoke('compute.probe', providerId),
    detailsGet: (providerId) =>
      electronRendererContracts.invoke('compute.detailsGet', providerId) as Promise<{
        doc: string
        isSkeleton: boolean
      }>,
    detailsSave: (providerId, text, oldText, author) =>
      electronRendererContracts.invoke(
        'compute.detailsSave',
        providerId,
        text,
        oldText,
        author
      ) as Promise<void>,
    scratchSet: (providerId, path) =>
      electronRendererContracts.invoke('compute.scratchSet', providerId, path),
    concurrencySet: (providerId, limit) =>
      electronRendererContracts.invoke('compute.concurrencySet', providerId, limit),
    download: (providerId, remotePath, dest) =>
      electronRendererContracts.invoke('compute.download', providerId, remotePath, dest),
    revealInFolder: (filePath) =>
      electronRendererContracts.invoke('compute.revealInFolder', filePath),
    // Fires when a compute call needs user approval (runs before any SSH is made).
    onApprovalRequest: (listener: (request: ComputeApprovalRequest) => void) =>
      electronRendererContracts.subscribe('compute.onApprovalRequest', listener),
    onApprovalSettled: (listener: (id: string) => void) =>
      electronRendererContracts.subscribe('compute.onApprovalSettled', listener),
    // Renderer sends back the user's decision (once / conversation / project / deny).
    respondApproval: (request: { id: string; decision: ComputeApprovalDecision }) =>
      electronRendererContracts.invoke('compute.respondApproval', request),
    replayApproval: (id: string) => electronRendererContracts.invoke('compute.replayApproval', id),
    replayPendingApprovals: () =>
      electronRendererContracts.invoke('compute.replayPendingApprovals'),
    listDir: (providerId, path) =>
      electronRendererContracts.invoke('compute.listDir', providerId, path),
    bookmarksGet: (providerId) =>
      electronRendererContracts.invoke('compute.bookmarksGet', providerId),
    bookmarksSet: (providerId, folders) =>
      electronRendererContracts.invoke('compute.bookmarksSet', providerId, folders),
    // Returns all jobs for a session as JobSummary[], optionally filtered by status (Phase 3d).
    jobsList: (filter: { sessionId: string; status?: string[] }) =>
      electronRendererContracts.invoke('compute.jobsList', filter),
    // Returns jobs pending analysis turn (notifiedAt set, notificationConsumedAt null).
    jobsPendingNotification: (sessionId) =>
      electronRendererContracts.invoke('compute.jobsPendingNotification', sessionId),
    // Marks job ids as notification-consumed after a successful analysis turn (issue 05).
    jobsMarkConsumed: (sessionId, jobIds) =>
      electronRendererContracts.invoke('compute.jobsMarkConsumed', sessionId, jobIds),
    // Fires when a job's status or tail changes (broadcast from the main-process poller).
    onJobUpdated: (listener: (job: JobSummary) => void) =>
      electronRendererContracts.subscribe('compute.onJobUpdated', listener),
    enabledHostsGet: (sessionId) =>
      electronRendererContracts.invoke('compute.enabledHostsGet', sessionId),
    enabledHostsSet: (sessionId, providerIds) =>
      electronRendererContracts.invoke('compute.enabledHostsSet', sessionId, providerIds),
    hostEnabledSet: (sessionId, providerId, enabled) =>
      electronRendererContracts.invoke('compute.hostEnabledSet', sessionId, providerId, enabled),
    hostSelectedSet: (sessionId, providerId, selected) =>
      electronRendererContracts.invoke('compute.hostSelectedSet', sessionId, providerId, selected)
  },
  preview: {
    // Per-project preview panel state, persisted alongside projects in SQLite.
    load: (request) => electronRendererContracts.invoke('preview.load', request),
    save: (request) => electronRendererContracts.invoke('preview.save', request),
    delete: (request) => electronRendererContracts.invoke('preview.delete', request)
  },
  previewResources: {
    acquire: (request) => electronRendererContracts.invoke('previewResources.acquire', request),
    readRange: (request) => electronRendererContracts.invoke('previewResources.readRange', request),
    release: (request) => electronRendererContracts.invoke('previewResources.release', request)
  },
  officePreview: {
    open: (request) => electronRendererContracts.invoke('officePreview.open', request),
    attachFrame: (sessionId) =>
      electronRendererContracts.invoke('officePreview.attachFrame', sessionId),
    // Runtime phases are one-way notifications relayed from the sandboxed child frame.
    reportState: (sessionId, state) =>
      electronRendererContracts.send('officePreview.reportState', sessionId, state),
    close: (sessionId) => electronRendererContracts.invoke('officePreview.close', sessionId),
    onState: (listener) => electronRendererContracts.subscribe('officePreview.onState', listener)
  },
  sourcePreview: {
    release: (sourceUrl: string) =>
      electronRendererContracts.send('sourcePreview.release', sourceUrl),
    onLoadState: (listener: (state: SourcePreviewLoadState) => void) =>
      electronRendererContracts.subscribe('sourcePreview.onLoadState', listener)
  },
  artifacts: {
    // Keep generated file movement in the main process where filesystem trust checks live.
    finalizeRunArtifacts: (request) =>
      electronRendererContracts.invoke('artifacts.finalizeRunArtifacts', request),
    // Lists every on-disk artifact for a project so orphaned files (owning session deleted) still show.
    listProjectFiles: (request) =>
      electronRendererContracts.invoke('artifacts.listProjectFiles', request),
    // Re-finalizes crash-orphaned pending artifacts so the renderer can replace stale pending paths.
    reconcilePendingArtifacts: (request) =>
      electronRendererContracts.invoke('artifacts.reconcilePendingArtifacts', request),
    openFile: (request) => electronRendererContracts.invoke('artifacts.openFile', request),
    // Keep preview reads on the same managed-file trust path as opening files.
    readPreview: (request) => electronRendererContracts.invoke('artifacts.readPreview', request),
    getLineage: (request) => electronRendererContracts.invoke('artifacts.getLineage', request),
    getVersionProvenance: (request) =>
      electronRendererContracts.invoke('artifacts.getVersionProvenance', request),
    getVersionExecution: (request) =>
      electronRendererContracts.invoke('artifacts.getVersionExecution', request),
    getVersionMessages: (request) =>
      electronRendererContracts.invoke('artifacts.getVersionMessages', request),
    getVersionReview: (request) =>
      electronRendererContracts.invoke('artifacts.getVersionReview', request),
    getCodeReconstruction: (request) =>
      electronRendererContracts.invoke('artifacts.getCodeReconstruction', request),
    generateCodeReconstruction: (request) =>
      electronRendererContracts.invoke('artifacts.generateCodeReconstruction', request),
    resolveVersionDescriptors: (request) =>
      electronRendererContracts.invoke('artifacts.resolveVersionDescriptors', request)
  },
  uploads: {
    // Upload IPC remains behind the preload bridge so renderer code never receives raw fs access.
    stageLocalFile: (file, request) =>
      electronRendererContracts.invoke('uploads.stageLocalFile', file, request),
    claimLocalFile: (request) =>
      electronRendererContracts.invoke('uploads.claimLocalFile', request),
    // Save-as-artifact from the local-file preview; the renderer supplies the path directly.
    stageLocalPath: (request) =>
      electronRendererContracts.invoke('uploads.stageLocalPath', request),
    beginTransfer: (request) => electronRendererContracts.invoke('uploads.beginTransfer', request),
    appendTransfer: (request) =>
      electronRendererContracts.invoke('uploads.appendTransfer', request),
    getTransferStatus: (request) =>
      electronRendererContracts.invoke('uploads.getTransferStatus', request),
    finishTransfer: (request) =>
      electronRendererContracts.invoke('uploads.finishTransfer', request),
    abortTransfer: (request) => electronRendererContracts.invoke('uploads.abortTransfer', request),
    onTransferProgress: (listener) =>
      electronRendererContracts.subscribe('uploads.onTransferProgress', listener),
    deleteUpload: (request) => electronRendererContracts.invoke('uploads.deleteUpload', request),
    finalizeSession: (request) =>
      electronRendererContracts.invoke('uploads.finalizeSession', request),
    readPreview: (request) => electronRendererContracts.invoke('uploads.readPreview', request)
  },
  localFs: {
    // Local-fs IPC stays behind the preload bridge so renderer code never receives raw fs access.
    listDir: (path) => electronRendererContracts.invoke('localFs.listDir', path),
    readPreview: (request) => electronRendererContracts.invoke('localFs.readPreview', request),
    getRoots: () => electronRendererContracts.invoke('localFs.getRoots'),
    listDrives: () => electronRendererContracts.invoke('localFs.listDrives'),
    reveal: (path) => electronRendererContracts.invoke('localFs.reveal', path),
    openPath: (path) => electronRendererContracts.invoke('localFs.openPath', path),
    listGrantedRoots: () => electronRendererContracts.invoke('localFs.listGrantedRoots'),
    grantRoot: (request) => electronRendererContracts.invoke('localFs.grantRoot', request),
    setGrantedRootAccess: (request) =>
      electronRendererContracts.invoke('localFs.setGrantedRootAccess', request),
    removeGrantedRoot: (request) =>
      electronRendererContracts.invoke('localFs.removeGrantedRoot', request)
  },
  notebook: {
    // Notebook commands stay behind typed IPC so renderer code never talks to local RPC directly.
    state: (request) => electronRendererContracts.invoke('notebook.state', request),
    readInputPreview: (request) =>
      electronRendererContracts.invoke('notebook.readInputPreview', request),
    getReference: (request) => electronRendererContracts.invoke('notebook.getReference', request),
    beginCodeCell: (request) =>
      electronRendererContracts.invoke('notebook.beginCodeCell', request) as Promise<{
        sessionId: string
        cellId: string
        writeId: string
        status: string
      }>,
    appendCodeCell: (request) =>
      electronRendererContracts.invoke('notebook.appendCodeCell', request) as Promise<{
        sessionId: string
        cellId: string
        writeId: string
        receivedBytes: number
      }>,
    finishCodeCell: (request) =>
      electronRendererContracts.invoke('notebook.finishCodeCell', request) as Promise<{
        sessionId: string
        cellId: string
        code: string
        status: string
      }>,
    runCell: (request) => electronRendererContracts.invoke('notebook.runCell', request),
    execute: (request) => electronRendererContracts.invoke('notebook.execute', request),
    exportIpynb: (request) => electronRendererContracts.invoke('notebook.exportIpynb', request),
    exportIpynbAll: (request) =>
      electronRendererContracts.invoke('notebook.exportIpynbAll', request),
    restart: (request) => electronRendererContracts.invoke('notebook.restart', request),
    shutdown: (request) =>
      electronRendererContracts.invoke('notebook.shutdown', request) as Promise<{
        sessionId: string
        status: 'shutdown'
      }>,
    onAvailable: (listener) =>
      electronRendererContracts.subscribe('notebook.onAvailable', listener),
    onChanged: (listener) => electronRendererContracts.subscribe('notebook.onChanged', listener)
  },
  notebookEnv: {
    getStatus: () => electronRendererContracts.invoke('notebookEnv.getStatus'),
    provision: (lang, operationId) =>
      electronRendererContracts.invoke('notebookEnv.provision', lang, operationId),
    repair: (lang, operationId) =>
      electronRendererContracts.invoke('notebookEnv.repair', lang, operationId),
    cancel: (lang?: NotebookLanguage) =>
      electronRendererContracts.invoke('notebookEnv.cancel', lang),
    onProgress: (listener) =>
      electronRendererContracts.subscribe('notebookEnv.onProgress', listener)
  },
  runtime: {
    survey: () => electronRendererContracts.invoke('runtime.survey'),
    setSelection: (language, selection) =>
      electronRendererContracts.invoke('runtime.setSelection', language, selection),
    pickInterpreter: () => electronRendererContracts.invoke('runtime.pickInterpreter'),
    listEnvironments: () =>
      electronRendererContracts.invoke('runtime.listEnvironments') as Promise<{
        python: DiscoveredInterpreter[]
        r: DiscoveredInterpreter[]
      }>,
    listPackages: (language, envId) =>
      electronRendererContracts.invoke('runtime.listPackages', language, envId),
    listPackageCounts: (language) =>
      electronRendererContracts.invoke('runtime.listPackageCounts', language) as Promise<
        Record<string, number | null>
      >,
    getEnablement: (language) =>
      electronRendererContracts.invoke('runtime.getEnablement', language),
    describeUsage: (language, envId) =>
      electronRendererContracts.invoke('runtime.describeUsage', language, envId),
    setEnvironmentEnabled: (language, envId, enabled, force) =>
      electronRendererContracts.invoke(
        'runtime.setEnvironmentEnabled',
        language,
        envId,
        enabled,
        force
      ),
    setInstallAuthorized: (language, envId, authorized) =>
      electronRendererContracts.invoke('runtime.setInstallAuthorized', language, envId, authorized),
    registerInterpreter: (language, path) =>
      electronRendererContracts.invoke('runtime.registerInterpreter', language, path),
    unregisterInterpreter: (language, path) =>
      electronRendererContracts.invoke('runtime.unregisterInterpreter', language, path)
  },
  storage: {
    getStatus: () => electronRendererContracts.invoke('storage.getStatus'),
    getInfo: () => electronRendererContracts.invoke('storage.getInfo'),
    revealAppStorage: () => electronRendererContracts.invoke('storage.revealAppStorage'),
    detectActive: () => electronRendererContracts.invoke('storage.detectActive'),
    pickDirectory: () => electronRendererContracts.invoke('storage.pickDirectory'),
    validateDataRoot: (parent) =>
      electronRendererContracts.invoke('storage.validateDataRoot', parent),
    inspectDataRoot: (parent) =>
      electronRendererContracts.invoke('storage.inspectDataRoot', parent),
    migrate: (parent) => electronRendererContracts.invoke('storage.migrate', parent),
    setDataRootAndRelaunch: (parent, markOnboarding) =>
      electronRendererContracts.invoke('storage.setDataRootAndRelaunch', parent, markOnboarding),
    cancelMigrate: () => electronRendererContracts.invoke('storage.cancelMigrate'),
    commitAndRelaunch: (parent) =>
      electronRendererContracts.invoke('storage.commitAndRelaunch', parent),
    discardMigratedCopy: (parent) =>
      electronRendererContracts.invoke('storage.discardMigratedCopy', parent),
    dismissLegacyMovePrompt: () =>
      electronRendererContracts.invoke('storage.dismissLegacyMovePrompt'),
    onProgress: (listener) => electronRendererContracts.subscribe('storage.onProgress', listener)
  },
  reviewer: {
    run: (request: ReviewRunRequest) => electronRendererContracts.invoke('reviewer.run', request),
    getForSession: (request: ReviewSessionRequest) =>
      electronRendererContracts.invoke('reviewer.getForSession', request),
    onUpdated: (listener) => electronRendererContracts.subscribe('reviewer.onUpdated', listener),
    onSuppressNextAutoReview: (listener: AcpListener<ReviewSuppressionEvent>) =>
      electronRendererContracts.subscribe('reviewer.onSuppressNextAutoReview', listener),
    // Fix loop lock: fired when the loop starts (lock composer) / ends or is aborted (unlock).
    onFixLoopStart: (listener: AcpListener<ReviewSessionRequest>) =>
      electronRendererContracts.subscribe('reviewer.onFixLoopStart', listener),
    onFixLoopEnd: (listener: AcpListener<ReviewSessionRequest>) =>
      electronRendererContracts.subscribe('reviewer.onFixLoopEnd', listener),
    // Sends an abort request to the main process to stop the running fix loop for a session.
    abortFixLoop: (request: ReviewSessionRequest) =>
      electronRendererContracts.invoke('reviewer.abortFixLoop', request)
  },
  window: {
    close: () => electronRendererContracts.invoke('window.close'),
    // The shared helper announces READY on subscribe (so main forwards the chord here) and UNREADY on
    // teardown (so main re-arms its direct close). Reload remounts the hook, re-running the handshake.
    onCloseActivePane: (listener) =>
      subscribeCloseActivePane(
        {
          on: (channel, paneListener) => onIpcMessage(channel, paneListener),
          send: (channel) => ipcRenderer.send(channel)
        },
        listener
      ),
    findInPage: (request) => electronRendererContracts.send('window.findInPage', request),
    clearFind: () => electronRendererContracts.send('window.clearFind'),
    // The Workspace announces it is mounted and searchable so main knows whether to intercept
    // Cmd/Ctrl+F. Returns a teardown that announces UNREADY on unmount.
    announceWindowFindReady: () =>
      announceWindowFindReady({ send: (channel) => ipcRenderer.send(channel) }),
    announceWindowFindContentReady: () =>
      electronRendererContracts.send('window.announceWindowFindContentReady'),
    onFindInPageResult: (listener) =>
      electronRendererContracts.subscribe('window.onFindInPageResult', listener),
    // Overlay-only surface: main signals the bar was shown (focus + restore remembered query), and the
    // overlay asks main to hide it. The localhost Web UI never loads this overlay, so both stay optional.
    onShowWindowFind: (listener) =>
      electronRendererContracts.subscribe('window.onShowWindowFind', listener),
    onHideWindowFind: (listener) =>
      electronRendererContracts.subscribe('window.onHideWindowFind', listener),
    onWindowFindAppearance: (listener) =>
      electronRendererContracts.subscribe('window.onWindowFindAppearance', listener),
    announceWindowFindAppearance: (appearance) =>
      electronRendererContracts.send('window.announceWindowFindAppearance', appearance),
    closeFind: () => electronRendererContracts.send('window.closeFind'),
    onCloseConfirmRequest: (listener) =>
      electronRendererContracts.subscribe('window.onCloseConfirmRequest', listener),
    sendCloseConfirmResponse: (payload) =>
      electronRendererContracts.send('window.sendCloseConfirmResponse', payload)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
