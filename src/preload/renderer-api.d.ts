import type {
  AcpCancelPromptRequest,
  AcpAgentRuntimeUpdate,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpContinueInterruptedTurnRequest,
  AcpCreateSessionResponse,
  AcpRuntimeEvent,
  AcpDeleteSessionRequest,
  AcpPermissionRequest,
  AcpPermissionResponse,
  ElicitationResponse,
  AcpPromptRequest,
  AcpSteerFollowUpRequest,
  AcpSteerFollowUpResult,
  AcpResumeSessionRequest,
  AcpSaveAsSkillRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../shared/acp'
import type { ActivePlanProjection, PlanResponseCommand } from '../shared/session-plan/contract'
import type {
  SideChatCloseRequest,
  SideChatPromptRequest,
  SideChatRelayDeliveredEvent,
  SideChatRuntimeEvent,
  SideChatSessionRequest,
  SideChatSnapshotList,
  SideChatStartRequest,
  SideChatStartResponse
} from '../shared/side-chat'
import type {
  ArtifactFile,
  ArtifactPreviewResult,
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult,
  ListProjectArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest,
  ResolveArtifactVersionDescriptorsRequest
} from '../shared/artifacts'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionExecutionProvenance,
  ArtifactVersionMessagesProvenance,
  ArtifactVersionProvenance,
  ArtifactVersionReviewProvenance,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest
} from '../shared/artifact-provenance'
import type {
  ArtifactCodeReconstructionState,
  GenerateArtifactCodeReconstructionRequest,
  GetArtifactCodeReconstructionRequest
} from '../shared/artifact-code-reconstruction'
import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveProjectArtifactsRequest,
  SaveProjectArtifactsResult,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
} from '../shared/file-save'
import type {
  ContributionTemplateExportResult,
  SpecialistPackageReportSaveResult,
  SpecialistExportPreview,
  SpecialistExportRequest,
  SpecialistExportSaveResult
} from '../shared/specialist-package'
import type {
  ComputeApprovalDecision,
  ComputeApprovalRequest,
  ComputeHost,
  ComputeHostDeletionStatus,
  ComputePasswordCapability,
  CreateComputeHostRequest,
  CreatePasswordComputeHostRequest,
  CreatePasswordComputeHostResult,
  ResetPasswordComputeHostRequest,
  ResetPasswordComputeHostResult,
  ChangeComputeHostAuthenticationRequest,
  ChangeComputeHostAuthenticationResult,
  DeleteComputeHostRequest,
  DetailsAuthor,
  JobSummary,
  ProbeResult
} from '../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../shared/remote-fs'
import type {
  GrantLocalRootRequest,
  GrantedLocalRoot,
  LocalDirListing,
  LocalDrive,
  LocalRoots,
  RemoveGrantedLocalRootRequest,
  SetGrantedLocalRootAccessRequest
} from '../shared/local-fs'
import type { RendererFailureReport } from '../shared/diagnostics'
import type { OpenLogFileResult, RevealLogFileResult } from '../shared/logs'
import type {
  NotificationInboxChanged,
  NotificationInboxSnapshot,
  NotificationMarkAllReadRequest,
  NotificationMarkReadRequest,
  NotificationMarkSessionCompletionsReadRequest,
  OpenSessionFromNotificationRequest,
  UnreadTaskViewState
} from '../shared/notifications'
import type {
  ProjectDeletedEvent,
  SessionDeletedEvent,
  SessionUpsertEvent
} from '../shared/lifecycle-events'
import type {
  HandoffEventsRequest,
  HandoffLifecycleChange,
  HandoffLifecycleEvent,
  HandoffRetryRequest
} from '../shared/handoff-lifecycle'
import type {
  PermissionGrantMutationView,
  PermissionGrantRestoreRequest,
  PermissionGrantRevokeRequest,
  PermissionGrantSnapshot,
  PermissionGrantUndoExtendRequest,
  PermissionGrantUndoReceipt,
  PermissionGrantsChangedEvent
} from '../shared/permission-grants'
import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  NotebookAvailableEvent,
  NotebookChangedEvent,
  ExecuteNotebookCodeRequest,
  ExportNotebookAllRequest,
  ExportNotebookAllResult,
  ExportNotebookKernelRequest,
  ExportNotebookResult,
  FinishNotebookCodeCellRequest,
  NotebookLanguage,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionStateRequest,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../shared/notebook'
import type { ProvisionProgress, ProvisionStatus } from '../shared/notebook-env'
import type {
  DiscoveredInterpreter,
  EnvPackage,
  RuntimeEnablement,
  RuntimeUsage,
  RuntimeSelection,
  RuntimeSurvey
} from '../shared/notebook-runtime'
import type {
  DeletePreviewStateRequest,
  LoadPreviewStateRequest,
  PreviewStateSnapshot,
  SavePreviewStateResult,
  SavePreviewStateRequest
} from '../shared/preview-state'
import type {
  OfficePreviewAttachResult,
  OfficePreviewOpenRequest,
  OfficePreviewOpenResult,
  OfficePreviewRuntimeState
} from '../shared/office-preview'
import type {
  AcquireManagedPreviewRequest,
  ManagedPreviewRangeResult,
  ManagedPreviewResource,
  ReadManagedPreviewRangeRequest,
  ReleaseManagedPreviewRequest
} from '../shared/preview-resources'
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  Project,
  UpdateProjectArchiveRequest,
  UpdateProjectRequest
} from '../shared/projects'
import type {
  CreateTagRequest,
  DeleteTagRequest,
  ReorderTagsRequest,
  SetTagAssignmentRequest,
  TagSnapshot,
  TagsChangedEvent,
  UpdateTagRequest
} from '../shared/tags'
import type {
  ArtifactGroupPage,
  GetProjectFilesOverviewRequest,
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFilesChangedEvent,
  ProjectFilesOverview,
  ProjectFilesPage,
  SearchArtifactsRequest,
  SearchArtifactsResult
} from '../shared/project-files'
import type {
  DeleteSessionRequest,
  SessionDeletionResult,
  LoadAllSessionsResult,
  ListSessionSummariesResult,
  LoadSessionRequest,
  PersistedChatSession,
  SaveSessionOptions,
  SaveSessionManifestRequest,
  SessionUsageProjection,
  UpdateSessionArchiveRequest
} from '../shared/session-persistence'
import type {
  SessionPersistenceFlushRequest,
  SessionPersistenceFlushResponse
} from '../shared/session-persistence-flush'
import type {
  ExportConversationRequest,
  ExportConversationResult
} from '../shared/conversation-export'
import type {
  ClaudeDetectResult,
  ClaudeInstallEvent,
  ClaudeInstallResult,
  DeleteProviderRequest,
  EnvironmentCheckResult,
  XaiOAuthDeviceAuthorization,
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SetActiveProviderRequest,
  SetPackageMirrorRequest,
  SetNetworkProxyRequest,
  SetAgentFrameworkRequest,
  SetConversationSkillImportEnabledRequest,
  SetNotificationsEnabledRequest,
  SetClosePreferenceRequest,
  SetProjectFilesFilterRequest,
  SetDefaultPermissionProfileRequest,
  SetAppIconVariantRequest,
  SetReasoningEffortRequest,
  SetReviewerModelRequest,
  SetSubagentModelRequest,
  SetVisionModelRequest,
  SetSkillEnabledRequest,
  SetSkillsEnabledRequest,
  SettingsSnapshot,
  AppIconPreview,
  SkillDetailView,
  SkillView,
  CreateSkillRequest,
  UpdateSkillRequest,
  DeleteSkillRequest,
  ExportSkillRequest,
  ExportSkillResult,
  ImportSkillRequest,
  GitHubTokenStatus,
  SaveGitHubTokenRequest,
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
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  ScanRepoRequest,
  ScanRepoResult,
  ConnectorsSnapshot,
  ConnectorDetailView,
  ConnectorTemplateExportPreview,
  ConnectorTemplateSelectionResult,
  SelectCustomServerTemplateRequest,
  ExportCustomServerTemplateRequest,
  ExportCustomServerTemplateResult,
  SetConnectorEnabledRequest,
  SetConnectorAutoAllowRequest,
  SetToolPermissionRequest,
  SetNcbiCredentialsRequest,
  AddCustomServerRequest,
  AuthenticateCustomServerRequest,
  SetCustomServerEnabledRequest,
  RemoveCustomServerRequest,
  UpdateCustomServerRequest,
  ConnectorApprovalRequest,
  ConversationSkillImportApprovalRequest,
  ConversationSkillImportApprovalResponse,
  RespondApprovalRequest,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../shared/settings'
import type { PackageMirror } from '../shared/mirror'
import type { NetworkProxySettings } from '../shared/network-proxy'
import type { NetworkInfo } from '../shared/network'
import type {
  ActiveSessionInfo,
  DataRootInspection,
  DataRootValidationResult,
  DiscardMigratedCopyResult,
  MigrationOutcome,
  MigrationProgress,
  RevealAppStorageResult,
  StorageInfo,
  StorageStatus
} from '../shared/storage'
import type { CliLauncherStatus } from '../shared/cli'
import type { AppInfo, DownloadProgress, UpdateStatus } from '../shared/update'
import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageLocalPathUploadRequest,
  UploadTransferProgress,
  UploadTransferRequest,
  UploadTransferStatus,
  UploadedAttachment
} from '../shared/uploads'
import type {
  ReviewWithChecks,
  ReviewRunRequest,
  ReviewRunResult,
  ReviewSessionRequest,
  ReviewSuppressionEvent,
  ReviewUpdateEvent
} from '../shared/reviewer'
import type {
  ApproveRemotePairingRequest,
  RemoteAccessSnapshot,
  RemotePairingRequestId,
  RevokeRemoteBrowserRequest,
  SetRemoteAccessModeRequest
} from '../shared/remote-access'
import type {
  CreateSpecialistRequest,
  UpdateSpecialistRequest,
  SetSpecialistEnabledRequest,
  DuplicateSpecialistRequest,
  SpecialistCatalogSnapshot,
  SpecialistProfileView,
  SetSessionSpecialistRequest,
  SetSessionSpecialistResponse,
  ResolveSessionSpecialistRequest,
  SessionSpecialistResolution,
  PendingSwitchBroadcast,
  CompletionHandoffLifecycleEvent,
  CompletionHandoffCommand
} from '../shared/specialist'
import type {
  SpecialistPackageCandidatePreview,
  SpecialistPackageInstallRequest,
  SpecialistPackageInstallResult,
  SpecialistDeletePreview,
  SpecialistDeleteRequest,
  SpecialistDeleteResult
} from '../shared/specialist-package'
import type {
  AddMarketplaceSourceRequest,
  CancelMarketplaceCandidateRequest,
  GetMarketplaceReleaseRequest,
  InspectGitHubMarketplaceSourceRequest,
  ListMarketplaceRequest,
  MarketplaceDownloadProgress,
  MarketplaceInstallPreview,
  MarketplaceInstallRequest,
  MarketplaceInstallResult,
  MarketplaceSnapshot,
  MarketplaceSourceCandidate,
  MarketplaceSourceView,
  MarketplaceSpecialistRelease,
  PrepareMarketplaceInstallRequest,
  RemoveMarketplaceSourceRequest
} from '../shared/specialist-marketplace'
import type {
  CloseConfirmRequest,
  CloseConfirmResponse,
  WindowFindAppearance,
  WindowFindRequest,
  WindowFindResult
} from '../shared/window-controls'
import type { DatabaseStartupState } from '../shared/database-startup'
import type {
  InitializeLocalePreferenceRequest,
  LocalePreferenceSnapshot,
  SetLocalePreferenceRequest
} from '../shared/locale'

type RemoveListener = () => void
type AcpListener<Payload> = (payload: Payload) => void

export interface OpenScienceAPI {
  saveBlobFile(request: SaveBlobFileRequest): Promise<SaveBlobFileResult>
  saveManagedFile(request: SaveManagedFileRequest): Promise<SaveManagedFileResult>
  saveSessionArtifacts(request: SaveSessionArtifactsRequest): Promise<SaveSessionArtifactsResult>
  saveProjectArtifacts(request: SaveProjectArtifactsRequest): Promise<SaveProjectArtifactsResult>
  // Host platform (process.platform), e.g. 'win32' | 'darwin' | 'linux'.
  platform: string
  getRuntimeVersions(): {
    electron: string
    chrome: string
    node: string
  }
  lifecycle: {
    getClientId(): Promise<string>
  }
  locale: {
    initialize(request: InitializeLocalePreferenceRequest): Promise<LocalePreferenceSnapshot>
    setPreference(request: SetLocalePreferenceRequest): Promise<LocalePreferenceSnapshot>
    onChanged(listener: AcpListener<LocalePreferenceSnapshot>): RemoveListener
  }
  databaseStartup: {
    getState(): Promise<DatabaseStartupState>
    retry(): Promise<DatabaseStartupState>
    quit(): Promise<void>
    onStateChanged(listener: AcpListener<DatabaseStartupState>): RemoveListener
  }
  diagnostics?: {
    reportRendererFailure(report: RendererFailureReport): void
  }
  acp: {
    getState(): Promise<AcpStateSnapshot>
    getPlanProjection(projectId: string, sessionId: string): Promise<ActivePlanProjection | null>
    respondPlan(request: PlanResponseCommand): Promise<unknown>
    connect(request?: AcpConnectRequest): Promise<AcpStateSnapshot>
    disconnect(): Promise<AcpStateSnapshot>
    createSession(request?: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse>
    resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
    continueInterruptedTurn(request: AcpContinueInterruptedTurnRequest): Promise<AcpStateSnapshot>
    resetSessionContext(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
    sendPrompt(request: AcpPromptRequest): Promise<AcpStateSnapshot>
    steerFollowUp(request: AcpSteerFollowUpRequest): Promise<AcpSteerFollowUpResult>
    saveAsSkill(request: AcpSaveAsSkillRequest): Promise<AcpStateSnapshot>
    compactSession(request: AcpCompactSessionRequest): Promise<AcpStateSnapshot>
    cancel(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot>
    deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot>
    respondToPermission(response: AcpPermissionResponse): Promise<AcpStateSnapshot>
    respondToElicitation(response: ElicitationResponse): Promise<AcpStateSnapshot>
    setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpStateSnapshot>
    revokePermissionGrant(request: AcpRevokePermissionGrantRequest): Promise<AcpStateSnapshot>
    onState(listener: AcpListener<AcpStateSnapshot>): RemoveListener
    onAgentRuntimeUpdate(listener: AcpListener<AcpAgentRuntimeUpdate>): RemoveListener
    onEvent(listener: AcpListener<readonly AcpRuntimeEvent[]>): RemoveListener
    onPermissionRequest(listener: AcpListener<AcpPermissionRequest>): RemoveListener
  }
  sideChat: {
    list(): Promise<SideChatSnapshotList>
    start(request: SideChatStartRequest): Promise<SideChatStartResponse>
    send(request: SideChatPromptRequest): Promise<void>
    cancel(request: SideChatSessionRequest): Promise<void>
    close(request: SideChatCloseRequest): Promise<void>
    onEvent(listener: AcpListener<SideChatRuntimeEvent>): RemoveListener
    onRelayDelivered(listener: AcpListener<SideChatRelayDeliveredEvent>): RemoveListener
  }
  permissions: {
    list(): Promise<PermissionGrantSnapshot>
    revoke(request: PermissionGrantRevokeRequest): Promise<PermissionGrantMutationView>
    extendUndo(
      request: PermissionGrantUndoExtendRequest
    ): Promise<PermissionGrantUndoReceipt | undefined>
    restore(request: PermissionGrantRestoreRequest): Promise<PermissionGrantMutationView>
    onChanged(listener: AcpListener<PermissionGrantsChangedEvent>): RemoveListener
  }
  sessions: {
    list(): Promise<ListSessionSummariesResult>
    loadAll(): Promise<LoadAllSessionsResult>
    loadOne(request: LoadSessionRequest): Promise<PersistedChatSession | undefined>
    loadUsage(): Promise<SessionUsageProjection>
    saveSession(
      session: PersistedChatSession,
      options?: SaveSessionOptions
    ): Promise<PersistedChatSession>
    updateArchive(request: UpdateSessionArchiveRequest): Promise<PersistedChatSession>
    deleteSession(request: DeleteSessionRequest): Promise<SessionDeletionResult>
    saveManifest(request: SaveSessionManifestRequest): Promise<void>
    exportConversation(request: ExportConversationRequest): Promise<ExportConversationResult>
    onFlushAborted?(listener: () => void): RemoveListener
    onFlushRequest?(listener: AcpListener<SessionPersistenceFlushRequest>): RemoveListener
    sendFlushResponse?(response: SessionPersistenceFlushResponse): void
    onCreated(listener: AcpListener<SessionUpsertEvent>): RemoveListener
    onUpdated(listener: AcpListener<SessionUpsertEvent>): RemoveListener
    onDeleted(listener: AcpListener<SessionDeletedEvent>): RemoveListener
  }
  settings: {
    getPreflight(): Promise<Preflight>
    getSettings(): Promise<SettingsSnapshot>
    isEncryptionAvailable(): Promise<boolean>
    isNpmAvailable(): Promise<boolean>
    checkEnvironment(): Promise<EnvironmentCheckResult>
    detectClaude(): Promise<ClaudeDetectResult>
    detectOpencode(): Promise<SettingsSnapshot>
    detectCodex(): Promise<SettingsSnapshot>
    installClaude(request: InstallClaudeRequest): Promise<ClaudeInstallResult>
    installOpencode(request: InstallOpencodeRequest): Promise<ClaudeInstallResult>
    installCodex(request: InstallCodexRequest): Promise<ClaudeInstallResult>
    uninstallClaude(): Promise<SettingsSnapshot>
    uninstallOpencode(): Promise<SettingsSnapshot>
    uninstallCodex(): Promise<SettingsSnapshot>
    upsertProvider(request: UpsertProviderRequest): Promise<SettingsSnapshot>
    deleteProvider(request: DeleteProviderRequest): Promise<SettingsSnapshot>
    setActiveProvider(request: SetActiveProviderRequest): Promise<SettingsSnapshot>
    setAgentFramework(request: SetAgentFrameworkRequest): Promise<SettingsSnapshot>
    setReasoningEffort(request: SetReasoningEffortRequest): Promise<SettingsSnapshot>
    setReviewerModel(request: SetReviewerModelRequest): Promise<SettingsSnapshot>
    setSubagentModel(request: SetSubagentModelRequest): Promise<SettingsSnapshot>
    setVisionModel(request: SetVisionModelRequest): Promise<SettingsSnapshot>
    onChanged(listener: (snapshot: SettingsSnapshot) => void): () => void
    setNotificationsEnabled(request: SetNotificationsEnabledRequest): Promise<SettingsSnapshot>
    setConversationSkillImportEnabled(
      request: SetConversationSkillImportEnabledRequest
    ): Promise<SettingsSnapshot>
    setClosePreference(request: SetClosePreferenceRequest): Promise<SettingsSnapshot>
    setProjectFilesFilter(request: SetProjectFilesFilterRequest): Promise<SettingsSnapshot>
    setDefaultPermissionProfile(
      request: SetDefaultPermissionProfileRequest
    ): Promise<SettingsSnapshot>

    setAppIconVariant(request: SetAppIconVariantRequest): Promise<SettingsSnapshot>
    listAppIcons(): Promise<AppIconPreview[]>
    validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult>
    cancelCodexLogin(): Promise<void>
    cancelClaudeLogin(): Promise<void>
    beginXaiOAuthLogin(): Promise<XaiOAuthDeviceAuthorization>
    waitXaiOAuthLogin(): Promise<{ accountEmail?: string }>
    cancelXaiOAuthLogin(): Promise<void>
    logoutXaiOAuth(): Promise<SettingsSnapshot>
    loginIsolatedCodex(): Promise<ValidateProviderResult>
    logoutIsolatedCodex(): Promise<ValidateProviderResult>
    loginSharedClaude(): Promise<ValidateProviderResult>
    logoutSharedClaude(): Promise<ValidateProviderResult>
    loginIsolatedClaude(token: string): Promise<ValidateProviderResult>
    loginIsolatedClaudeBrowser(): Promise<ValidateProviderResult>
    cancelIsolatedClaudeLogin(): Promise<void>
    logoutIsolatedClaude(): Promise<ValidateProviderResult>
    refreshProviderModels(
      request: RefreshProviderModelsRequest
    ): Promise<RefreshProviderModelsResult>
    markOnboardingComplete(): Promise<SettingsSnapshot>
    getPackageMirror(): Promise<PackageMirror>
    setPackageMirror(request: SetPackageMirrorRequest): Promise<PackageMirror>
    setNetworkProxy(request: SetNetworkProxyRequest): Promise<NetworkProxySettings>
    listSkills(): Promise<SkillView[]>
    getGitHubTokenStatus(): Promise<GitHubTokenStatus>
    saveGitHubToken(request: SaveGitHubTokenRequest): Promise<GitHubTokenStatus>
    removeGitHubToken(): Promise<GitHubTokenStatus>
    getSkillDetail(id: string): Promise<SkillDetailView>
    exportSkill(request: ExportSkillRequest): Promise<ExportSkillResult>
    setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]>
    setSkillsEnabled(request: SetSkillsEnabledRequest): Promise<SkillView[]>
    createSkill(request: CreateSkillRequest): Promise<SkillView[]>
    updateSkill(request: UpdateSkillRequest): Promise<SkillView[]>
    deleteSkill(request: DeleteSkillRequest): Promise<SkillView[]>
    importSkill(request: ImportSkillRequest): Promise<ImportSkillResult>
    importSkillZip(request: ImportSkillZipRequest): Promise<ImportSkillResult>
    importSkillZipBatch(request: ImportSkillZipBatchRequest): Promise<ImportSkillZipBatchResult>
    previewSkillZip(request: PreviewSkillZipRequest): Promise<SkillBundlePreviewResult>
    previewGitHubSkill(request: PreviewGitHubSkillRequest): Promise<SkillImportPreviewContent>
    scanRepoSkills(request: ScanRepoRequest): Promise<ScanRepoResult>
    listAgentHomeSkills(): Promise<AgentHomeSkillView[]>
    previewAgentHomeSkill(request: PreviewAgentHomeSkillRequest): Promise<SkillImportPreviewContent>
    importAgentHomeSkills(
      request: ImportAgentHomeSkillsRequest
    ): Promise<ImportAgentHomeSkillsResult>
    listConnectors(): Promise<ConnectorsSnapshot>
    previewCustomServerTemplateExport(id: string): Promise<ConnectorTemplateExportPreview>
    selectCustomServerTemplate(
      request?: SelectCustomServerTemplateRequest
    ): Promise<ConnectorTemplateSelectionResult>
    exportCustomServerTemplate(
      request: ExportCustomServerTemplateRequest
    ): Promise<ExportCustomServerTemplateResult>
    getConnectorDetail(id: string): Promise<ConnectorDetailView>
    setConnectorEnabled(request: SetConnectorEnabledRequest): Promise<ConnectorsSnapshot>
    setConnectorAutoAllow(request: SetConnectorAutoAllowRequest): Promise<ConnectorsSnapshot>
    setToolPermission(request: SetToolPermissionRequest): Promise<ConnectorDetailView>
    setNcbiCredentials(request: SetNcbiCredentialsRequest): Promise<ConnectorsSnapshot>
    addCustomServer(request: AddCustomServerRequest): Promise<ConnectorsSnapshot>
    setCustomServerEnabled(request: SetCustomServerEnabledRequest): Promise<ConnectorsSnapshot>
    removeCustomServer(request: RemoveCustomServerRequest): Promise<ConnectorsSnapshot>
    updateCustomServer(request: UpdateCustomServerRequest): Promise<ConnectorsSnapshot>
    authenticateCustomServer(request: AuthenticateCustomServerRequest): Promise<ConnectorsSnapshot>
    cancelCustomServerAuthentication(request: AuthenticateCustomServerRequest): Promise<void>
    retryCustomServer(request: AuthenticateCustomServerRequest): Promise<ConnectorsSnapshot>
    onConnectorApprovalRequest(listener: AcpListener<ConnectorApprovalRequest>): RemoveListener
    onConnectorApprovalSettled?(listener: AcpListener<string>): RemoveListener
    onConnectorRuntimeChanged(listener: AcpListener<undefined>): RemoveListener
    onSkillCatalogChanged(listener: AcpListener<undefined>): RemoveListener
    onSkillImportApprovalRequest(
      listener: AcpListener<ConversationSkillImportApprovalRequest>
    ): RemoveListener
    onSkillImportApprovalSettled(listener: AcpListener<string>): RemoveListener
    replayPendingSkillImportApprovals(): Promise<void>
    replayConnectorApproval(id: string): Promise<ConnectorApprovalRequest | null>
    replayPendingConnectorApprovals?(): Promise<void>
    respondSkillImportApproval(response: ConversationSkillImportApprovalResponse): Promise<void>
    respondConnectorApproval(request: RespondApprovalRequest): Promise<void>
    onInstallLog(listener: AcpListener<ClaudeInstallEvent>): RemoveListener
  }
  remoteAccess: {
    getSnapshot(): Promise<RemoteAccessSnapshot>
    detect(): Promise<RemoteAccessSnapshot>
    disable(): Promise<RemoteAccessSnapshot>
    setMode(request: SetRemoteAccessModeRequest): Promise<RemoteAccessSnapshot>
    approve(request: ApproveRemotePairingRequest): Promise<RemoteAccessSnapshot>
    reject(request: RemotePairingRequestId): Promise<RemoteAccessSnapshot>
    revokeBrowser(request: RevokeRemoteBrowserRequest): Promise<RemoteAccessSnapshot>
    onChanged(listener: () => void): RemoveListener
  }
  specialist: {
    list(): Promise<SpecialistCatalogSnapshot>
    listMarketplace(request?: ListMarketplaceRequest): Promise<MarketplaceSnapshot>
    inspectGitHubMarketplaceSource(
      request: InspectGitHubMarketplaceSourceRequest
    ): Promise<MarketplaceSourceCandidate>
    addMarketplaceSource(request: AddMarketplaceSourceRequest): Promise<MarketplaceSourceView>
    removeMarketplaceSource(request: RemoveMarketplaceSourceRequest): Promise<void>
    getMarketplaceRelease(
      request: GetMarketplaceReleaseRequest
    ): Promise<MarketplaceSpecialistRelease>
    prepareMarketplaceInstall(
      request: PrepareMarketplaceInstallRequest
    ): Promise<MarketplaceInstallPreview>
    cancelMarketplaceCandidate(request: CancelMarketplaceCandidateRequest): Promise<void>
    onMarketplaceDownloadProgress(
      listener: (progress: MarketplaceDownloadProgress) => void
    ): RemoveListener
    installMarketplace(request: MarketplaceInstallRequest): Promise<MarketplaceInstallResult>
    create(request: CreateSpecialistRequest): Promise<SpecialistProfileView>
    update(request: UpdateSpecialistRequest): Promise<SpecialistProfileView>
    setEnabled(request: SetSpecialistEnabledRequest): Promise<SpecialistProfileView>
    previewDelete(request: { id: string }): Promise<SpecialistDeletePreview>
    delete(request: SpecialistDeleteRequest): Promise<SpecialistDeleteResult>
    duplicate(request: DuplicateSpecialistRequest): Promise<CreateSpecialistRequest>
    exportContributionTemplate(): Promise<ContributionTemplateExportResult>
    previewExport(request: { specialistId: string }): Promise<SpecialistExportPreview>
    exportSpecialist(request: SpecialistExportRequest): Promise<SpecialistExportSaveResult>
    selectPackage(): Promise<{ cancelled: true } | SpecialistPackageCandidatePreview>
    installPackage(
      request: SpecialistPackageInstallRequest
    ): Promise<SpecialistPackageInstallResult>
    cancelPackage(request: SpecialistPackageInstallRequest): Promise<void>
    savePackageReport(
      request: SpecialistPackageInstallRequest
    ): Promise<SpecialistPackageReportSaveResult>
    onCatalogChanged(listener: () => void): RemoveListener
    // Compatibility-only pending-selection broadcast; approved SDK handoffs use lifecycle events.
    onPendingSwitch(listener: AcpListener<PendingSwitchBroadcast>): RemoveListener
    getHandoffEvents(sessionId: string): Promise<CompletionHandoffLifecycleEvent[]>
    onHandoffLifecycleEvent(listener: AcpListener<CompletionHandoffLifecycleEvent>): RemoveListener
    retryHandoff(request: CompletionHandoffCommand): Promise<unknown>
    cancelHandoff(request: CompletionHandoffCommand): Promise<void>
    // Session switching (issue 07).
    setSessionSpecialist(
      request: SetSessionSpecialistRequest
    ): Promise<SetSessionSpecialistResponse>
    resolveSessionSpecialist(
      request: ResolveSessionSpecialistRequest
    ): Promise<SessionSpecialistResolution>
  }
  handoff: {
    list(request: HandoffEventsRequest): Promise<readonly HandoffLifecycleEvent[]>
    retry(request: HandoffRetryRequest): Promise<void>
    onChanged(listener: AcpListener<HandoffLifecycleChange>): RemoveListener
  }
  logs: {
    getPath(): Promise<string | null>
    openFile(): Promise<OpenLogFileResult>
    revealInFolder(): Promise<RevealLogFileResult>
  }
  notifications: {
    getSnapshot(): Promise<NotificationInboxSnapshot>
    markAllRead(request: NotificationMarkAllReadRequest): Promise<void>
    markRead(request: NotificationMarkReadRequest): Promise<void>
    markSessionCompletionsRead(
      request: NotificationMarkSessionCompletionsReadRequest
    ): Promise<void>
    onChanged(listener: AcpListener<NotificationInboxChanged>): RemoveListener
    onOpenSession(listener: () => void): RemoveListener
    peekPendingOpenSession(): Promise<OpenSessionFromNotificationRequest | null>
    takePendingOpenSession(
      expectedToken: number
    ): Promise<OpenSessionFromNotificationRequest | null>
    // Electron-only. The Web bridge intentionally omits native unread acknowledgement.
    syncViewState?(state: UnreadTaskViewState): void
    onViewProbe?(listener: AcpListener<number>): RemoveListener
  }
  github: {
    getStars(): Promise<number | null>
  }
  network: {
    getInfo(): Promise<NetworkInfo>
    checkConnectivity(): Promise<boolean>
  }
  cli: {
    getStatus(): Promise<CliLauncherStatus>
    install(): Promise<CliLauncherStatus>
    uninstall(): Promise<CliLauncherStatus>
  }
  update: {
    getAppInfo(): Promise<AppInfo>
    getStatus(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    download(): Promise<UpdateStatus>
    cancel(): Promise<UpdateStatus>
    apply(): Promise<UpdateStatus>
    onStatus(listener: (status: UpdateStatus) => void): RemoveListener
    onProgress(listener: (progress: DownloadProgress) => void): RemoveListener
  }
  projects: {
    list(): Promise<Project[]>
    get(id: string): Promise<Project | null>
    create(request: CreateProjectRequest): Promise<Project>
    update(request: UpdateProjectRequest): Promise<Project>
    updateArchive(request: UpdateProjectArchiveRequest): Promise<Project>
    delete(request: DeleteProjectRequest): Promise<void>
    onCreated(listener: AcpListener<Project>): RemoveListener
    onUpdated(listener: AcpListener<Project>): RemoveListener
    onDeleted(listener: AcpListener<ProjectDeletedEvent>): RemoveListener
  }
  tags: {
    snapshot(): Promise<TagSnapshot>
    create(request: CreateTagRequest): Promise<TagSnapshot>
    update(request: UpdateTagRequest): Promise<TagSnapshot>
    delete(request: DeleteTagRequest): Promise<TagSnapshot>
    reorder(request: ReorderTagsRequest): Promise<TagSnapshot>
    setAssignment(request: SetTagAssignmentRequest): Promise<TagSnapshot>
    onChanged(listener: AcpListener<TagsChangedEvent>): RemoveListener
  }
  projectFiles: {
    getOverview(request: GetProjectFilesOverviewRequest): Promise<ProjectFilesOverview>
    listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
    listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
    searchArtifacts(request: SearchArtifactsRequest): Promise<SearchArtifactsResult>
    repairIndex(request: { projectId: string }): Promise<void>
    onChanged(listener: AcpListener<ProjectFilesChangedEvent>): RemoveListener
  }
  compute: {
    // SSH compute host record CRUD (Compute settings tab). No credentials cross this boundary.
    list(): Promise<ComputeHost[]>
    get(providerId: string): Promise<ComputeHost | null>
    create(request: CreateComputeHostRequest): Promise<ComputeHost>
    createPassword(
      request: CreatePasswordComputeHostRequest
    ): Promise<CreatePasswordComputeHostResult>
    resetPassword(request: ResetPasswordComputeHostRequest): Promise<ResetPasswordComputeHostResult>
    changeAuthentication(
      request: ChangeComputeHostAuthenticationRequest
    ): Promise<ChangeComputeHostAuthenticationResult>
    passwordCapability(): Promise<ComputePasswordCapability>
    deletionStatus(request: DeleteComputeHostRequest): Promise<ComputeHostDeletionStatus>
    delete(request: DeleteComputeHostRequest): Promise<void>
    // Selectable Host aliases parsed from ~/.ssh/config (patterns / Match blocks excluded).
    sshConfigAliases(): Promise<string[]>
    // Runs the probe bundle against the host; persists probeResult + shape. SSH stays in main.
    probe(providerId: string): Promise<ProbeResult>
    // Details document: get (with skeleton synthesis when empty) and save (old_text guard).
    detailsGet(providerId: string): Promise<{ doc: string; isSkeleton: boolean }>
    detailsSave(
      providerId: string,
      text: string,
      oldText: string,
      author: DetailsAuthor
    ): Promise<void>
    // Scratch root: set path and mark pinned.
    scratchSet(providerId: string, path: string): Promise<void>
    // Enforced concurrent job limit: set 1..500.
    concurrencySet(providerId: string, limit: number): Promise<void>
    // Fires when a compute call needs user approval (runs before any SSH is made).
    onApprovalRequest(listener: (request: ComputeApprovalRequest) => void): () => void
    onApprovalSettled?(listener: (id: string) => void): () => void
    // Renderer sends back the user's decision (once / conversation / project / deny).
    respondApproval(request: { id: string; decision: ComputeApprovalDecision }): Promise<void>
    replayApproval(id: string): Promise<ComputeApprovalRequest | null>
    replayPendingApprovals?(): Promise<void>
    // Lists a remote directory (browse experience).
    listDir(providerId: string, path: string): Promise<DirListing>
    // Downloads a remote file to OS Downloads or project artifact. No approval gate for UI actions.
    download(providerId: string, remotePath: string, dest: DownloadDest): Promise<LocalFile>
    // Reveals a local file path in the OS file manager (Finder / Explorer).
    revealInFolder(filePath: string): Promise<void>
    // Bookmark folders for the file browser Go-to/Pin feature, persisted in settings JSON.
    bookmarksGet(providerId: string): Promise<string[]>
    bookmarksSet(providerId: string, folders: string[]): Promise<void>
    // Returns all jobs for a session as JobSummary[], optionally filtered by status (Phase 3d).
    jobsList(filter: { sessionId: string; status?: string[] }): Promise<JobSummary[]>
    // Returns jobs with notifiedAt set and notificationConsumedAt null (issue 05 restart recovery).
    jobsPendingNotification(sessionId: string): Promise<JobSummary[]>
    // Marks job ids as notification-consumed after a successful analysis turn (issue 05).
    jobsMarkConsumed(sessionId: string, jobIds: string[]): Promise<void>
    // Fires when a job's status or tail changes (broadcast from the main-process poller).
    onJobUpdated(listener: (job: JobSummary) => void): () => void
    // Per-session enabled Compute Hosts. Main owns durable Session JSON and projects the runtime cache.
    enabledHostsGet(sessionId: string): Promise<string[]>
    enabledHostsSet(sessionId: string, providerIds: string[]): Promise<PersistedChatSession>
    hostEnabledSet(
      sessionId: string,
      providerId: string,
      enabled: boolean
    ): Promise<PersistedChatSession>
    hostSelectedSet(
      sessionId: string,
      providerId: string,
      selected: boolean
    ): Promise<PersistedChatSession>
  }
  preview: {
    load(request: LoadPreviewStateRequest): Promise<PreviewStateSnapshot | null>
    save(request: SavePreviewStateRequest): Promise<SavePreviewStateResult>
    delete(request: DeletePreviewStateRequest): Promise<void>
  }
  previewResources: {
    acquire(request: AcquireManagedPreviewRequest): Promise<ManagedPreviewResource>
    readRange(request: ReadManagedPreviewRangeRequest): Promise<ManagedPreviewRangeResult>
    release(request: ReleaseManagedPreviewRequest): Promise<void>
  }
  officePreview: {
    open(request: OfficePreviewOpenRequest): Promise<OfficePreviewOpenResult>
    attachFrame(sessionId: string): Promise<OfficePreviewAttachResult | undefined>
    reportState(sessionId: string, state: OfficePreviewRuntimeState): void
    close(sessionId: string): Promise<void>
    onState(listener: (state: OfficePreviewRuntimeState) => void): RemoveListener
  }
  artifacts: {
    finalizeRunArtifacts(request: FinalizeRunArtifactsRequest): Promise<FinalizeRunArtifactsResult>
    listProjectFiles(request: ListProjectArtifactsRequest): Promise<ArtifactFile[]>
    reconcilePendingArtifacts(request: ReconcilePendingArtifactsRequest): Promise<ArtifactFile[]>
    openFile(request: OpenArtifactFileRequest): Promise<void>
    readPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
    getLineage(request: GetArtifactLineageRequest): Promise<ArtifactLineageProvenance | undefined>
    getVersionProvenance(
      request: GetArtifactVersionProvenanceRequest
    ): Promise<ArtifactVersionProvenance>
    getVersionExecution(
      request: GetArtifactVersionProvenanceRequest
    ): Promise<ArtifactVersionExecutionProvenance>
    getVersionMessages(
      request: GetArtifactVersionProvenanceRequest
    ): Promise<ArtifactVersionMessagesProvenance>
    getVersionReview(
      request: GetArtifactVersionProvenanceRequest
    ): Promise<ArtifactVersionReviewProvenance>
    getCodeReconstruction(
      request: GetArtifactCodeReconstructionRequest
    ): Promise<ArtifactCodeReconstructionState>
    generateCodeReconstruction(
      request: GenerateArtifactCodeReconstructionRequest
    ): Promise<ArtifactCodeReconstructionState>
    resolveVersionDescriptors(
      request: ResolveArtifactVersionDescriptorsRequest
    ): Promise<ArtifactVersionDescriptor[]>
  }
  uploads: {
    // Desktop-only path fast path; omitted by the Web capability map.
    stageLocalFile?(
      file: File,
      request: BeginUploadTransferRequest
    ): Promise<UploadedAttachment | null>
    // Acknowledges that the renderer committed a native-path upload into its draft state.
    claimLocalFile?(request: UploadTransferRequest): Promise<void>
    // Desktop-only save-as-artifact path for the local-file preview; staged like a composer upload.
    stageLocalPath?(request: StageLocalPathUploadRequest): Promise<UploadedAttachment>
    beginTransfer(request: BeginUploadTransferRequest): Promise<UploadTransferStatus>
    appendTransfer(request: AppendUploadTransferRequest): Promise<UploadTransferStatus>
    getTransferStatus(request: UploadTransferRequest): Promise<UploadTransferStatus | null>
    finishTransfer(request: UploadTransferRequest): Promise<UploadedAttachment>
    abortTransfer(request: UploadTransferRequest): Promise<void>
    onTransferProgress(listener: AcpListener<UploadTransferProgress>): RemoveListener
    // Deletes a staged upload when the composer chip is removed or the draft is abandoned.
    deleteUpload(request: DeleteUploadRequest): Promise<void>
    // Moves pending uploads into the durable session directory once a session id exists.
    finalizeSession(request: FinalizeUploadSessionRequest): Promise<UploadedAttachment[]>
    // Reads a bounded preview from upload storage using the same preview result shape as artifacts.
    readPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
  }
  localFs: {
    // Lists a directory on the machine Kiro runs on (the "This computer" browser).
    listDir(path: string): Promise<LocalDirListing>
    // Reads a bounded preview of a local file (same result shape as artifacts/uploads).
    readPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
    // Home directory + friendly machine name for the browser's initial location and label.
    getRoots(): Promise<LocalRoots>
    // Mounted drives/volumes for the browsers' drive switchers (drive letters on Windows,
    // / + /Volumes on macOS, / + mount parents on Linux).
    listDrives(): Promise<LocalDrive[]>
    // Reveals a local file in the OS file manager.
    reveal(path: string): Promise<void>
    // Opens a local file with the OS default application; resolves to '' on success.
    openPath(path: string): Promise<string>
    // Folders the user granted the app access to; mutations resolve to the updated list.
    listGrantedRoots(): Promise<GrantedLocalRoot[]>
    grantRoot(request: GrantLocalRootRequest): Promise<GrantedLocalRoot[]>
    setGrantedRootAccess(request: SetGrantedLocalRootAccessRequest): Promise<GrantedLocalRoot[]>
    removeGrantedRoot(request: RemoveGrantedLocalRootRequest): Promise<GrantedLocalRoot[]>
  }
  notebook: {
    state(request: NotebookSessionStateRequest): Promise<NotebookSessionState>
    readInputPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
    getReference(request: NotebookSessionRequest): Promise<NotebookSessionReference | null>
    beginCodeCell(request: BeginNotebookCodeCellRequest): Promise<{
      sessionId: string
      cellId: string
      writeId: string
      status: string
    }>
    appendCodeCell(request: AppendNotebookCodeCellRequest): Promise<{
      sessionId: string
      cellId: string
      writeId: string
      receivedBytes: number
    }>
    finishCodeCell(request: FinishNotebookCodeCellRequest): Promise<{
      sessionId: string
      cellId: string
      code: string
      status: string
    }>
    runCell(request: RunNotebookCellRequest): Promise<NotebookRunSummary>
    execute(request: ExecuteNotebookCodeRequest): Promise<NotebookRunSummary>
    exportIpynb(request: ExportNotebookKernelRequest): Promise<ExportNotebookResult>
    exportIpynbAll(request: ExportNotebookAllRequest): Promise<ExportNotebookAllResult>
    restart(request: NotebookSessionRequest): Promise<NotebookSessionState>
    shutdown(request: NotebookSessionRequest): Promise<{ sessionId: string; status: 'shutdown' }>
    onAvailable(listener: AcpListener<NotebookAvailableEvent>): RemoveListener
    onChanged(listener: AcpListener<NotebookChangedEvent>): RemoveListener
  }
  notebookEnv: {
    getStatus(): Promise<ProvisionStatus>
    provision(lang: NotebookLanguage, operationId?: string): Promise<void>
    repair(lang: NotebookLanguage, operationId?: string): Promise<void>
    cancel(lang?: NotebookLanguage): Promise<void>
    onProgress(listener: (progress: ProvisionProgress) => void): RemoveListener
  }
  runtime: {
    // Per-language runtime picture (persisted choice + a survey of the managed and external sources).
    survey(): Promise<RuntimeSurvey[]>
    // Persists (or clears, when selection is null) one language's choice; returns its refreshed survey.
    setSelection(
      language: NotebookLanguage,
      selection: RuntimeSelection | null
    ): Promise<RuntimeSurvey>
    // Opens the native file picker to choose an interpreter; resolves null on cancel.
    pickInterpreter(): Promise<string | null>
    // v4: every detected interpreter per language (Settings cards).
    listEnvironments(): Promise<{ python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }>
    // Read-only installed-package inventory for one env (Settings "Packages" dialog).
    listPackages(language: NotebookLanguage, envId: string): Promise<EnvPackage[]>
    // Bulk per-env package counts for the card badges (one discovery sweep per language; null = the
    // listing failed, so the card omits its badge).
    listPackageCounts(language: NotebookLanguage): Promise<Record<string, number | null>>
    // v4: the persisted per-language enablement, so cards reflect the saved state on load.
    getEnablement(language: NotebookLanguage): Promise<RuntimeEnablement>
    // WS11: live-session usage of a runtime (running/idle/dormant), for the disable-impact warning.
    describeUsage(language: NotebookLanguage, envId: string): Promise<RuntimeUsage>
    // v4: set one env's enabled override; rejects (throws) if it would disable the last enabled env
    // for the language. Returns the refreshed per-language enablement.
    setEnvironmentEnabled(
      language: NotebookLanguage,
      envId: string,
      enabled: boolean,
      force?: boolean
    ): Promise<RuntimeEnablement>
    // v4: set one env's high-risk package-install authorization. Returns the refreshed enablement.
    setInstallAuthorized(
      language: NotebookLanguage,
      envId: string,
      authorized: boolean
    ): Promise<RuntimeEnablement>
    // v4: add/remove a manually-picked interpreter path in the discovery catalog; returns the list.
    registerInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
    unregisterInterpreter(language: NotebookLanguage, path: string): Promise<string[]>
  }
  storage: {
    getStatus(): Promise<StorageStatus>
    getInfo(): Promise<StorageInfo>
    revealAppStorage(): Promise<RevealAppStorageResult>
    detectActive(): Promise<ActiveSessionInfo[]>
    // Opens the native folder picker; resolves null on cancel.
    pickDirectory(): Promise<string | null>
    // Onboarding location step: check a candidate parent before letting the user commit to it.
    // The final data root is always `<parent>/OpenScience`, never the parent itself.
    validateDataRoot(parent: string): Promise<DataRootValidationResult>
    // Settings + onboarding: classify a candidate parent (move/adopt/recover/invalid) without
    // committing; `dataRoot` on the result is the derived `<parent>/OpenScience` path.
    inspectDataRoot(parent: string): Promise<DataRootInspection>
    migrate(parent: string): Promise<MigrationOutcome>
    // No-move pointer switch: set dataRoot then relaunch. Accepts both a 'move' (first-run, no
    // data to move yet) and an 'adopt' (existing data folder) target - use `migrate` instead for
    // an already-active data root's move-with-copy. `markOnboarding` is set by onboarding only.
    setDataRootAndRelaunch(
      parent: string,
      markOnboarding?: boolean
    ): Promise<DataRootValidationResult>
    cancelMigrate(): Promise<void>
    commitAndRelaunch(parent: string): Promise<MigrationOutcome>
    discardMigratedCopy(parent: string): Promise<DiscardMigratedCopyResult>
    // Marks the one-time legacy-data-move prompt as answered (declined / keep-here) so it's not shown again.
    dismissLegacyMovePrompt(): Promise<void>
    onProgress(listener: AcpListener<MigrationProgress>): RemoveListener
  }
  reviewer: {
    // Trigger a background review for the given turn. Fire-and-forget; updates come via onUpdated.
    run(request: ReviewRunRequest): Promise<ReviewRunResult>
    // Load persisted reviews for a session (called at workspace startup).
    getForSession(request: ReviewSessionRequest): Promise<ReviewWithChecks[]>
    // Subscribe to review lifecycle/findings updates pushed from the main process.
    onUpdated(listener: AcpListener<ReviewUpdateEvent>): RemoveListener
    // Subscribe to loop-guard events: suppress (or, when clear=true, un-suppress) the next
    // auto-review for the given session.
    onSuppressNextAutoReview(listener: AcpListener<ReviewSuppressionEvent>): RemoveListener
    // Fix loop lock: fired when the loop starts (lock composer) / ends or is aborted (unlock).
    onFixLoopStart(listener: AcpListener<ReviewSessionRequest>): RemoveListener
    onFixLoopEnd(listener: AcpListener<ReviewSessionRequest>): RemoveListener
    // Sends an abort request to stop the running fix loop for a session.
    abortFixLoop(request: ReviewSessionRequest): Promise<void>
  }
  window: {
    // Closes the focused window (the Cmd+W / Ctrl+W fallback when no preview panel is open).
    close(): Promise<void>
    // Fires when Cmd+W / Ctrl+W is pressed; the renderer decides pane-vs-window.
    onCloseActivePane(listener: () => void): RemoveListener
    findInPage?(request: WindowFindRequest): void
    clearFind?(): void
    // Announces the Workspace is mounted (READY) and returns a teardown that announces UNREADY.
    announceWindowFindReady?(): RemoveListener
    // Announces that the full searchable transcript has committed to the renderer DOM.
    announceWindowFindContentReady?(): void
    onFindInPageResult?(listener: AcpListener<WindowFindResult>): RemoveListener
    // Overlay-only: main signals the bar was shown; the overlay asks main to hide it.
    onShowWindowFind?(listener: AcpListener<WindowFindAppearance>): RemoveListener
    // Main renderer only: the overlay was hidden, so temporary searchable content can be released.
    onHideWindowFind?(listener: () => void): RemoveListener
    onWindowFindAppearance?(listener: AcpListener<WindowFindAppearance>): RemoveListener
    announceWindowFindAppearance?(appearance: WindowFindAppearance): void
    closeFind?(): void
    // Fires when main asks to confirm a close/quit; the renderer renders the modal and replies.
    onCloseConfirmRequest?(listener: (payload: CloseConfirmRequest) => void): RemoveListener
    // Renderer -> main: modal-mounted ack, then the user's choice, keyed by requestId.
    sendCloseConfirmResponse?(payload: CloseConfirmResponse): void
  }
}

declare global {
  interface Window {
    api: OpenScienceAPI
  }
}

export {}
