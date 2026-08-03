import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

import { createElectronRendererContractAdapter } from './electron-renderer-contract-adapter'

import type {
  AcpCancelPromptRequest,
  AcpCompactSessionRequest,
  AcpConnectRequest,
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpRuntimeEvent,
  AcpDeleteSessionRequest,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRevokePermissionGrantRequest,
  AcpSetPermissionProfileRequest,
  AcpStateSnapshot
} from '../shared/acp'
import type {
  ArtifactFile,
  ArtifactPreviewResult,
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult,
  ListProjectArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest
} from '../shared/artifacts'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionExecutionProvenance,
  ArtifactVersionMessagesProvenance,
  ArtifactVersionProvenance,
  ArtifactVersionReviewProvenance,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest
} from '../shared/artifact-provenance'
import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
} from '../shared/file-save'
import type {
  ComputeApprovalDecision,
  ComputeApprovalRequest,
  ComputeHost,
  CreateComputeHostRequest,
  DeleteComputeHostRequest,
  DetailsAuthor,
  JobSummary,
  ProbeResult
} from '../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../shared/remote-fs'
import type { LocalDirListing, LocalRoots } from '../shared/local-fs'
import type { RendererFailureReport } from '../shared/diagnostics'
import type { OpenLogFileResult, RevealLogFileResult } from '../shared/logs'
import type {
  OpenSessionFromNotificationRequest,
  UnreadTaskViewState
} from '../shared/notifications'
import type {
  ProjectDeletedEvent,
  SessionDeletedEvent,
  SessionUpsertEvent
} from '../shared/lifecycle-events'
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
  PersistedPreviewState,
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
  UpdateProjectRequest
} from '../shared/projects'
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
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionOptions,
  SaveSessionManifestRequest
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
  InstallClaudeRequest,
  InstallCodexRequest,
  InstallOpencodeRequest,
  Preflight,
  RefreshProviderModelsRequest,
  RefreshProviderModelsResult,
  SetActiveProviderRequest,
  SetPackageMirrorRequest,
  SetAgentFrameworkRequest,
  SetConversationSkillImportEnabledRequest,
  SetNotificationsEnabledRequest,
  SetClosePreferenceRequest,
  SetAppIconVariantRequest,
  SetReasoningEffortRequest,
  SetSkillEnabledRequest,
  SettingsSnapshot,
  AppIconPreview,
  SkillDetailView,
  SkillView,
  CreateSkillRequest,
  UpdateSkillRequest,
  DeleteSkillRequest,
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
  SkillBundlePreviewResult,
  SkillImportPreviewContent,
  ScanRepoRequest,
  ScanRepoResult,
  ConnectorsSnapshot,
  ConnectorDetailView,
  SetConnectorEnabledRequest,
  SetConnectorAutoAllowRequest,
  SetToolPermissionRequest,
  SetNcbiCredentialsRequest,
  AddCustomServerRequest,
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
import type {
  ActiveSessionInfo,
  DataRootInspection,
  DataRootValidationResult,
  MigrationOutcome,
  MigrationProgress,
  RevealAppStorageResult,
  StorageInfo
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
  DeleteSpecialistRequest,
  DuplicateSpecialistRequest,
  SpecialistListItem,
  SpecialistProfileView,
  SetSessionSpecialistRequest,
  SetSessionSpecialistResponse,
  ResolveSessionSpecialistRequest,
  SessionSpecialistResolution,
  PendingSwitchBroadcast,
  CompletionHandoffLifecycleEvent,
  CompletionHandoffCommand
} from '../shared/specialist'
import {
  type HandoffEventsRequest,
  type HandoffLifecycleChange,
  type HandoffLifecycleEvent,
  type HandoffRetryRequest
} from '../shared/handoff-lifecycle'
import {
  announceWindowFindReady,
  subscribeCloseActivePane,
  type CloseConfirmRequest,
  type CloseConfirmResponse,
  type WindowFindAppearance,
  type WindowFindRequest,
  type WindowFindResult
} from '../shared/window-controls'

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

// Custom APIs for renderer
type OpenScienceAPI = {
  saveBlobFile: (request: SaveBlobFileRequest) => Promise<SaveBlobFileResult>
  saveManagedFile: (request: SaveManagedFileRequest) => Promise<SaveManagedFileResult>
  saveSessionArtifacts: (
    request: SaveSessionArtifactsRequest
  ) => Promise<SaveSessionArtifactsResult>
  // Host platform (process.platform), e.g. 'win32' | 'darwin' | 'linux'. Lets the renderer pick
  // platform-correct copy such as the claude install command shown in the onboarding/settings card.
  platform: string
  getRuntimeVersions: () => {
    electron: string
    chrome: string
    node: string
  }
  lifecycle: {
    getClientId: () => Promise<string>
  }
  diagnostics?: {
    reportRendererFailure: (report: RendererFailureReport) => void
  }
  acp: {
    getState: () => Promise<AcpStateSnapshot>
    connect: (request?: AcpConnectRequest) => Promise<AcpStateSnapshot>
    disconnect: () => Promise<AcpStateSnapshot>
    createSession: (request?: AcpCreateSessionRequest) => Promise<AcpCreateSessionResponse>
    resumeSession: (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
    resetSessionContext: (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
    sendPrompt: (request: AcpPromptRequest) => Promise<AcpStateSnapshot>
    compactSession: (request: AcpCompactSessionRequest) => Promise<AcpStateSnapshot>
    cancel: (request: AcpCancelPromptRequest) => Promise<AcpStateSnapshot>
    deleteSession: (request: AcpDeleteSessionRequest) => Promise<AcpStateSnapshot>
    respondToPermission: (response: AcpPermissionResponse) => Promise<AcpStateSnapshot>
    setPermissionProfile: (request: AcpSetPermissionProfileRequest) => Promise<AcpStateSnapshot>
    revokePermissionGrant: (request: AcpRevokePermissionGrantRequest) => Promise<AcpStateSnapshot>
    onState: (listener: AcpListener<AcpStateSnapshot>) => RemoveListener
    onEvent: (listener: AcpListener<AcpRuntimeEvent>) => RemoveListener
    onPermissionRequest: (listener: AcpListener<AcpPermissionRequest>) => RemoveListener
  }
  permissions: {
    list: () => Promise<PermissionGrantSnapshot>
    revoke: (request: PermissionGrantRevokeRequest) => Promise<PermissionGrantMutationView>
    extendUndo: (
      request: PermissionGrantUndoExtendRequest
    ) => Promise<PermissionGrantUndoReceipt | undefined>
    restore: (request: PermissionGrantRestoreRequest) => Promise<PermissionGrantMutationView>
    onChanged: (listener: AcpListener<PermissionGrantsChangedEvent>) => RemoveListener
  }
  sessions: {
    loadAll: () => Promise<LoadAllSessionsResult>
    saveSession: (
      session: PersistedChatSession,
      options?: SaveSessionOptions
    ) => Promise<PersistedChatSession>
    deleteSession: (request: DeleteSessionRequest) => Promise<void>
    saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
    exportConversation: (request: ExportConversationRequest) => Promise<ExportConversationResult>
    onFlushRequest?: (listener: AcpListener<SessionPersistenceFlushRequest>) => RemoveListener
    sendFlushResponse?: (response: SessionPersistenceFlushResponse) => void
    onCreated: (listener: AcpListener<SessionUpsertEvent>) => RemoveListener
    onUpdated: (listener: AcpListener<SessionUpsertEvent>) => RemoveListener
    onDeleted: (listener: AcpListener<SessionDeletedEvent>) => RemoveListener
  }
  settings: {
    getPreflight: () => Promise<Preflight>
    getSettings: () => Promise<SettingsSnapshot>
    isEncryptionAvailable: () => Promise<boolean>
    isNpmAvailable: () => Promise<boolean>
    checkEnvironment: () => Promise<EnvironmentCheckResult>
    detectClaude: () => Promise<ClaudeDetectResult>
    detectOpencode: () => Promise<SettingsSnapshot>
    detectCodex: () => Promise<SettingsSnapshot>
    installClaude: (request: InstallClaudeRequest) => Promise<ClaudeInstallResult>
    installOpencode: (request: InstallOpencodeRequest) => Promise<ClaudeInstallResult>
    installCodex: (request: InstallCodexRequest) => Promise<ClaudeInstallResult>
    uninstallClaude: () => Promise<SettingsSnapshot>
    uninstallOpencode: () => Promise<SettingsSnapshot>
    uninstallCodex: () => Promise<SettingsSnapshot>
    upsertProvider: (request: UpsertProviderRequest) => Promise<SettingsSnapshot>
    deleteProvider: (request: DeleteProviderRequest) => Promise<SettingsSnapshot>
    setActiveProvider: (request: SetActiveProviderRequest) => Promise<SettingsSnapshot>
    setAgentFramework: (request: SetAgentFrameworkRequest) => Promise<SettingsSnapshot>
    setReasoningEffort: (request: SetReasoningEffortRequest) => Promise<SettingsSnapshot>
    setNotificationsEnabled: (request: SetNotificationsEnabledRequest) => Promise<SettingsSnapshot>
    setConversationSkillImportEnabled: (
      request: SetConversationSkillImportEnabledRequest
    ) => Promise<SettingsSnapshot>
    setClosePreference: (request: SetClosePreferenceRequest) => Promise<SettingsSnapshot>
    setAppIconVariant: (request: SetAppIconVariantRequest) => Promise<SettingsSnapshot>
    listAppIcons: () => Promise<AppIconPreview[]>
    validateProvider: (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
    cancelCodexLogin: () => Promise<void>
    cancelClaudeLogin: () => Promise<void>
    loginIsolatedCodex: () => Promise<ValidateProviderResult>
    logoutIsolatedCodex: () => Promise<ValidateProviderResult>
    loginSharedClaude: () => Promise<ValidateProviderResult>
    logoutSharedClaude: () => Promise<ValidateProviderResult>
    loginIsolatedClaude: (token: string) => Promise<ValidateProviderResult>
    loginIsolatedClaudeBrowser: () => Promise<ValidateProviderResult>
    cancelIsolatedClaudeLogin: () => Promise<void>
    logoutIsolatedClaude: () => Promise<ValidateProviderResult>
    refreshProviderModels: (
      request: RefreshProviderModelsRequest
    ) => Promise<RefreshProviderModelsResult>
    markOnboardingComplete: () => Promise<SettingsSnapshot>
    getPackageMirror: () => Promise<PackageMirror>
    setPackageMirror: (request: SetPackageMirrorRequest) => Promise<PackageMirror>
    listSkills: () => Promise<SkillView[]>
    getSkillDetail: (id: string) => Promise<SkillDetailView>
    setSkillEnabled: (request: SetSkillEnabledRequest) => Promise<SkillView[]>
    createSkill: (request: CreateSkillRequest) => Promise<SkillView[]>
    updateSkill: (request: UpdateSkillRequest) => Promise<SkillView[]>
    deleteSkill: (request: DeleteSkillRequest) => Promise<SkillView[]>
    importSkill: (request: ImportSkillRequest) => Promise<ImportSkillResult>
    importSkillZip: (request: ImportSkillZipRequest) => Promise<ImportSkillResult>
    importSkillZipBatch: (request: ImportSkillZipBatchRequest) => Promise<ImportSkillZipBatchResult>
    previewSkillZip: (request: PreviewSkillZipRequest) => Promise<SkillBundlePreviewResult>
    previewGitHubSkill: (request: PreviewGitHubSkillRequest) => Promise<SkillImportPreviewContent>
    scanRepoSkills: (request: ScanRepoRequest) => Promise<ScanRepoResult>
    listAgentHomeSkills: () => Promise<AgentHomeSkillView[]>
    previewAgentHomeSkill: (
      request: PreviewAgentHomeSkillRequest
    ) => Promise<SkillImportPreviewContent>
    importAgentHomeSkills: (
      request: ImportAgentHomeSkillsRequest
    ) => Promise<ImportAgentHomeSkillsResult>
    listConnectors: () => Promise<ConnectorsSnapshot>
    getConnectorDetail: (id: string) => Promise<ConnectorDetailView>
    setConnectorEnabled: (request: SetConnectorEnabledRequest) => Promise<ConnectorsSnapshot>
    setConnectorAutoAllow: (request: SetConnectorAutoAllowRequest) => Promise<ConnectorsSnapshot>
    setToolPermission: (request: SetToolPermissionRequest) => Promise<ConnectorDetailView>
    setNcbiCredentials: (request: SetNcbiCredentialsRequest) => Promise<ConnectorsSnapshot>
    addCustomServer: (request: AddCustomServerRequest) => Promise<ConnectorsSnapshot>
    setCustomServerEnabled: (request: SetCustomServerEnabledRequest) => Promise<ConnectorsSnapshot>
    removeCustomServer: (request: RemoveCustomServerRequest) => Promise<ConnectorsSnapshot>
    updateCustomServer: (request: UpdateCustomServerRequest) => Promise<ConnectorsSnapshot>
    onConnectorApprovalRequest: (listener: AcpListener<ConnectorApprovalRequest>) => RemoveListener
    onSkillImportApprovalRequest: (
      listener: AcpListener<ConversationSkillImportApprovalRequest>
    ) => RemoveListener
    onSkillImportApprovalSettled: (listener: AcpListener<string>) => RemoveListener
    replayPendingSkillImportApprovals: () => Promise<void>
    respondSkillImportApproval: (response: ConversationSkillImportApprovalResponse) => Promise<void>
    respondConnectorApproval: (request: RespondApprovalRequest) => Promise<void>
    onInstallLog: (listener: AcpListener<ClaudeInstallEvent>) => RemoveListener
  }
  remoteAccess: {
    getSnapshot: () => Promise<RemoteAccessSnapshot>
    detect: () => Promise<RemoteAccessSnapshot>
    disable: () => Promise<RemoteAccessSnapshot>
    setMode: (request: SetRemoteAccessModeRequest) => Promise<RemoteAccessSnapshot>
    approve: (request: ApproveRemotePairingRequest) => Promise<RemoteAccessSnapshot>
    reject: (request: RemotePairingRequestId) => Promise<RemoteAccessSnapshot>
    revokeBrowser: (request: RevokeRemoteBrowserRequest) => Promise<RemoteAccessSnapshot>
    onChanged: (listener: () => void) => RemoveListener
  }
  specialist: {
    list: () => Promise<SpecialistListItem[]>
    create: (request: CreateSpecialistRequest) => Promise<SpecialistProfileView>
    update: (request: UpdateSpecialistRequest) => Promise<SpecialistProfileView>
    setEnabled: (request: SetSpecialistEnabledRequest) => Promise<SpecialistProfileView>
    delete(request: DeleteSpecialistRequest): Promise<void>
    duplicate(request: DuplicateSpecialistRequest): Promise<CreateSpecialistRequest>
    onCatalogChanged: (listener: () => void) => RemoveListener
    // host.agents.switch() durable next-message switch broadcast (issue 08b). Main persists the
    // binding and notifies the renderer so it mirrors the pending target WITHOUT switching the live
    // agent mid-reply; the next-send barrier applies the approved identity.
    onPendingSwitch: (listener: AcpListener<PendingSwitchBroadcast>) => RemoveListener
    getHandoffEvents: (sessionId: string) => Promise<CompletionHandoffLifecycleEvent[]>
    onHandoffLifecycleEvent: (
      listener: AcpListener<CompletionHandoffLifecycleEvent>
    ) => RemoveListener
    retryHandoff: (request: CompletionHandoffCommand) => Promise<unknown>
    cancelHandoff: (request: CompletionHandoffCommand) => Promise<void>
    // Session switching (issue 07).
    setSessionSpecialist: (
      request: SetSessionSpecialistRequest
    ) => Promise<SetSessionSpecialistResponse>
    resolveSessionSpecialist: (
      request: ResolveSessionSpecialistRequest
    ) => Promise<SessionSpecialistResolution>
  }
  handoff: {
    list: (request: HandoffEventsRequest) => Promise<readonly HandoffLifecycleEvent[]>
    retry: (request: HandoffRetryRequest) => Promise<void>
    onChanged: (listener: AcpListener<HandoffLifecycleChange>) => RemoveListener
  }
  logs: {
    getPath: () => Promise<string | null>
    openFile: () => Promise<OpenLogFileResult>
    revealInFolder: () => Promise<RevealLogFileResult>
  }
  notifications: {
    // Fires when the user clicks a desktop notification. Payload-less nudge: the renderer then
    // inspects the retained target (a push with payload could be lost mid-load).
    onOpenSession: (listener: () => void) => RemoveListener
    // Returns the retained conversation without consuming it, so partial hydration can defer it.
    peekPendingOpenSession: () => Promise<OpenSessionFromNotificationRequest | null>
    // Clears the target only if it still matches the click the renderer inspected.
    takePendingOpenSession: (
      expectedToken: number
    ) => Promise<OpenSessionFromNotificationRequest | null>
    // Projects hydrated navigation state to main; unread ownership never enters the renderer.
    syncViewState: (state: UnreadTaskViewState) => void
    // Main requests a fresh DOM/navigation projection before suppressing a terminal unread marker.
    onViewProbe: (listener: AcpListener<number>) => RemoveListener
  }
  github: {
    getStars: () => Promise<number | null>
  }
  cli: {
    // The `open-science` command-line launcher: read status, install the shim into the user's PATH,
    // or remove it. Install/uninstall touch only the user's own bin dir (no elevation).
    getStatus: () => Promise<CliLauncherStatus>
    install: () => Promise<CliLauncherStatus>
    uninstall: () => Promise<CliLauncherStatus>
  }
  update: {
    getAppInfo: () => Promise<AppInfo>
    getStatus: () => Promise<UpdateStatus>
    check: () => Promise<UpdateStatus>
    download: () => Promise<UpdateStatus>
    cancel: () => Promise<UpdateStatus>
    apply: () => Promise<UpdateStatus>
    onStatus: (listener: (status: UpdateStatus) => void) => RemoveListener
    onProgress: (listener: (progress: DownloadProgress) => void) => RemoveListener
  }
  projects: {
    list: () => Promise<Project[]>
    get: (id: string) => Promise<Project | null>
    create: (request: CreateProjectRequest) => Promise<Project>
    update: (request: UpdateProjectRequest) => Promise<Project>
    delete: (request: DeleteProjectRequest) => Promise<void>
    onCreated: (listener: AcpListener<Project>) => RemoveListener
    onUpdated: (listener: AcpListener<Project>) => RemoveListener
    onDeleted: (listener: AcpListener<ProjectDeletedEvent>) => RemoveListener
  }
  projectFiles: {
    getOverview: (request: GetProjectFilesOverviewRequest) => Promise<ProjectFilesOverview>
    listFiles: (request: ListProjectFilesRequest) => Promise<ProjectFilesPage>
    listArtifactGroups: (request: ListArtifactGroupsRequest) => Promise<ArtifactGroupPage>
    searchArtifacts: (request: SearchArtifactsRequest) => Promise<SearchArtifactsResult>
    repairIndex: (request: { projectId: string }) => Promise<void>
    onChanged: (listener: AcpListener<ProjectFilesChangedEvent>) => RemoveListener
  }
  compute: {
    // SSH compute host record CRUD (Compute settings tab). No credentials cross this boundary — only
    // an alias + optional non-secret overrides. `sshConfigAliases` returns selectable Host aliases
    // parsed from the user's ~/.ssh/config (patterns and Match blocks excluded).
    list: () => Promise<ComputeHost[]>
    get: (providerId: string) => Promise<ComputeHost | null>
    create: (request: CreateComputeHostRequest) => Promise<ComputeHost>
    delete: (request: DeleteComputeHostRequest) => Promise<void>
    sshConfigAliases: () => Promise<string[]>
    // Runs the probe bundle; persists probeResult + shape. SSH never leaves the main process.
    probe: (providerId: string) => Promise<ProbeResult>
    // Details document: get (with skeleton synthesis when empty) and save (old_text guard).
    detailsGet: (providerId: string) => Promise<{ doc: string; isSkeleton: boolean }>
    detailsSave: (
      providerId: string,
      text: string,
      oldText: string,
      author: DetailsAuthor
    ) => Promise<void>
    // Scratch root: set path and mark pinned.
    scratchSet: (providerId: string, path: string) => Promise<void>
    // Concurrent job limit: store 1..500 (not enforced in Phase 1).
    concurrencySet: (providerId: string, limit: number) => Promise<void>
    // Lists a remote directory (browse experience).
    listDir: (providerId: string, path: string) => Promise<DirListing>
    // Downloads a remote file to OS Downloads (os-downloads) or project artifact (artifact).
    // Human-initiated downloads are NOT approval-gated — only the agent path (session-cache) is.
    download: (providerId: string, remotePath: string, dest: DownloadDest) => Promise<LocalFile>
    // Reveals a local file path in the OS file manager (Finder / Explorer).
    revealInFolder: (filePath: string) => Promise<void>
    // Bookmark folders for the file browser Go-to/Pin feature, persisted in settings JSON.
    bookmarksGet: (providerId: string) => Promise<string[]>
    bookmarksSet: (providerId: string, folders: string[]) => Promise<void>
    // Fires when a compute call needs user approval (runs before any SSH is made).
    onApprovalRequest: (listener: (request: ComputeApprovalRequest) => void) => () => void
    // Renderer sends back the user's decision (once / conversation / project / deny).
    respondApproval: (request: { id: string; decision: ComputeApprovalDecision }) => Promise<void>
    // Returns all jobs for a session as JobSummary[], optionally filtered by status (Phase 3d).
    jobsList: (filter: { sessionId: string; status?: string[] }) => Promise<JobSummary[]>
    // Returns jobs with notifiedAt set and notificationConsumedAt null (issue 05 restart recovery).
    jobsPendingNotification: (sessionId: string) => Promise<JobSummary[]>
    // Marks job ids as notification-consumed after a successful analysis turn (issue 05).
    jobsMarkConsumed: (sessionId: string, jobIds: string[]) => Promise<void>
    // Fires when a job's status or tail changes (broadcast from the main-process poller).
    onJobUpdated: (listener: (job: JobSummary) => void) => () => void
    // Per-session enabled compute hosts (issue 06). The renderer owns durable state (session JSON);
    // the main-process registry is the runtime cache for list_compute RPC ops.
    enabledHostsGet: (sessionId: string) => Promise<string[]>
    enabledHostsSet: (sessionId: string, providerIds: string[]) => Promise<void>
  }
  preview: {
    load: (request: LoadPreviewStateRequest) => Promise<PersistedPreviewState | null>
    save: (request: SavePreviewStateRequest) => Promise<void>
    delete: (request: DeletePreviewStateRequest) => Promise<void>
  }
  previewResources: {
    acquire: (request: AcquireManagedPreviewRequest) => Promise<ManagedPreviewResource>
    readRange: (request: ReadManagedPreviewRangeRequest) => Promise<ManagedPreviewRangeResult>
    release: (request: ReleaseManagedPreviewRequest) => Promise<void>
  }
  officePreview: {
    open: (request: OfficePreviewOpenRequest) => Promise<OfficePreviewOpenResult>
    attachFrame: (sessionId: string) => Promise<OfficePreviewAttachResult | undefined>
    reportState: (sessionId: string, state: OfficePreviewRuntimeState) => void
    close: (sessionId: string) => Promise<void>
    onState: (listener: (state: OfficePreviewRuntimeState) => void) => RemoveListener
  }
  artifacts: {
    // Finalizes files produced during one runtime event after the renderer has selected a message.
    finalizeRunArtifacts: (
      request: FinalizeRunArtifactsRequest
    ) => Promise<FinalizeRunArtifactsResult>
    // Lists every on-disk artifact for a project so orphaned files (owning session deleted) still show.
    listProjectFiles: (request: ListProjectArtifactsRequest) => Promise<ArtifactFile[]>
    // Re-finalizes pending artifacts left behind by a crash, returning the message's finalized files.
    reconcilePendingArtifacts: (
      request: ReconcilePendingArtifactsRequest
    ) => Promise<ArtifactFile[]>
    // Opens only managed files after the main process verifies the path.
    openFile: (request: OpenArtifactFileRequest) => Promise<void>
    // Reads a bounded text preview from managed generated files.
    readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
    getLineage: (
      request: GetArtifactLineageRequest
    ) => Promise<ArtifactLineageProvenance | undefined>
    getVersionProvenance: (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ArtifactVersionProvenance>
    getVersionExecution: (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ArtifactVersionExecutionProvenance>
    getVersionMessages: (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ArtifactVersionMessagesProvenance>
    getVersionReview: (
      request: GetArtifactVersionProvenanceRequest
    ) => Promise<ArtifactVersionReviewProvenance>
  }
  uploads: {
    // Desktop-only path fast path. A null result means this File has no native path.
    stageLocalFile?: (
      file: File,
      request: BeginUploadTransferRequest
    ) => Promise<UploadedAttachment | null>
    // Acknowledges that the renderer committed a native-path upload into its draft state.
    claimLocalFile?: (request: UploadTransferRequest) => Promise<void>
    // Save-as-artifact from the local-file preview; staged like a composer upload.
    stageLocalPath?: (request: StageLocalPathUploadRequest) => Promise<UploadedAttachment>
    beginTransfer: (request: BeginUploadTransferRequest) => Promise<UploadTransferStatus>
    appendTransfer: (request: AppendUploadTransferRequest) => Promise<UploadTransferStatus>
    getTransferStatus: (request: UploadTransferRequest) => Promise<UploadTransferStatus | null>
    finishTransfer: (request: UploadTransferRequest) => Promise<UploadedAttachment>
    abortTransfer: (request: UploadTransferRequest) => Promise<void>
    onTransferProgress: (listener: AcpListener<UploadTransferProgress>) => RemoveListener
    // Deletes a staged upload when the composer chip is removed or the draft is abandoned.
    deleteUpload: (request: DeleteUploadRequest) => Promise<void>
    // Moves pending uploads into the durable session directory once a session id exists.
    finalizeSession: (request: FinalizeUploadSessionRequest) => Promise<UploadedAttachment[]>
    // Reads a bounded preview from upload storage using the same preview result shape as artifacts.
    readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  }
  localFs: {
    // Lists a directory on the machine Kiro runs on (the "This computer" browser).
    listDir: (path: string) => Promise<LocalDirListing>
    // Reads a bounded preview of a local file (same result shape as artifacts/uploads).
    readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
    // Home directory + friendly machine name for the browser's initial location and label.
    getRoots: () => Promise<LocalRoots>
    // Reveals a local file in the OS file manager.
    reveal: (path: string) => Promise<void>
    // Opens a local file with the OS default application; resolves to '' on success.
    openPath: (path: string) => Promise<string>
  }
  notebook: {
    state: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
    readInputPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
    // Resolves an existing notebook entry for a session without creating one, or null when absent.
    getReference: (request: NotebookSessionRequest) => Promise<NotebookSessionReference | null>
    beginCodeCell: (request: BeginNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      writeId: string
      status: string
    }>
    appendCodeCell: (request: AppendNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      writeId: string
      receivedBytes: number
    }>
    finishCodeCell: (request: FinishNotebookCodeCellRequest) => Promise<{
      sessionId: string
      cellId: string
      code: string
      status: string
    }>
    runCell: (request: RunNotebookCellRequest) => Promise<NotebookRunSummary>
    execute: (request: ExecuteNotebookCodeRequest) => Promise<NotebookRunSummary>
    exportIpynb: (request: ExportNotebookKernelRequest) => Promise<ExportNotebookResult>
    exportIpynbAll: (request: ExportNotebookAllRequest) => Promise<ExportNotebookAllResult>
    restart: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
    shutdown: (
      request: NotebookSessionRequest
    ) => Promise<{ sessionId: string; status: 'shutdown' }>
    onAvailable: (listener: AcpListener<NotebookAvailableEvent>) => RemoveListener
    onChanged: (listener: AcpListener<NotebookChangedEvent>) => RemoveListener
  }
  notebookEnv: {
    getStatus: () => Promise<ProvisionStatus>
    provision: (lang: NotebookLanguage) => Promise<void>
    repair: (lang: NotebookLanguage) => Promise<void>
    cancel: (lang?: NotebookLanguage) => Promise<void>
    onProgress: (listener: (progress: ProvisionProgress) => void) => RemoveListener
  }
  runtime: {
    // Per-language runtime picture (persisted choice + a survey of the managed and external sources).
    survey: () => Promise<RuntimeSurvey[]>
    // Persists (or clears, when selection is null) one language's choice; returns its refreshed survey.
    setSelection: (
      language: NotebookLanguage,
      selection: RuntimeSelection | null
    ) => Promise<RuntimeSurvey>
    // Opens the native file picker to choose an interpreter; resolves null on cancel.
    pickInterpreter: () => Promise<string | null>
    // v4: every detected interpreter per language (Settings cards).
    listEnvironments: () => Promise<{ python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }>
    // Read-only installed-package inventory for one env (Settings "Packages" dialog).
    listPackages: (language: NotebookLanguage, envId: string) => Promise<EnvPackage[]>
    // Bulk per-env package counts for the card badges (one discovery sweep per language; null = the
    // listing failed, so the card omits its badge).
    listPackageCounts: (language: NotebookLanguage) => Promise<Record<string, number | null>>
    // v4: the persisted per-language enablement, so cards reflect the saved state on load.
    getEnablement: (language: NotebookLanguage) => Promise<RuntimeEnablement>
    // WS11: how many live sessions use a runtime (running/idle/dormant), for the disable-impact warning.
    describeUsage: (language: NotebookLanguage, envId: string) => Promise<RuntimeUsage>
    // v4: set one env's enabled override; rejects (throws) if it would disable the last enabled env
    // for the language. Returns the refreshed per-language enablement.
    setEnvironmentEnabled: (
      language: NotebookLanguage,
      envId: string,
      enabled: boolean,
      // WS10 force-stop: when disabling, abort a running cell now instead of draining.
      force?: boolean
    ) => Promise<RuntimeEnablement>
    // v4: set one env's high-risk package-install authorization. Returns the refreshed enablement.
    setInstallAuthorized: (
      language: NotebookLanguage,
      envId: string,
      authorized: boolean
    ) => Promise<RuntimeEnablement>
    // v4: add/remove a manually-picked interpreter path to the discovery catalog. Returns the
    // refreshed per-language path list.
    registerInterpreter: (language: NotebookLanguage, path: string) => Promise<string[]>
    unregisterInterpreter: (language: NotebookLanguage, path: string) => Promise<string[]>
  }
  storage: {
    getInfo: () => Promise<StorageInfo>
    revealAppStorage: () => Promise<RevealAppStorageResult>
    detectActive: () => Promise<ActiveSessionInfo[]>
    // Opens the native folder picker; resolves null on cancel.
    pickDirectory: () => Promise<string | null>
    // Onboarding location step: check a candidate parent before letting the user commit to it.
    validateDataRoot: (parent: string) => Promise<DataRootValidationResult>
    // Settings + onboarding: classify a candidate parent (move/adopt/invalid) without committing.
    inspectDataRoot: (parent: string) => Promise<DataRootInspection>
    migrate: (parent: string) => Promise<MigrationOutcome>
    // No-move pointer switch: set dataRoot then relaunch. Accepts both a 'move' (first-run, no
    // data to move yet) and an 'adopt' (existing data folder) target - use `migrate` instead for
    // an already-active data root's move-with-copy. `markOnboarding` is set by onboarding only.
    setDataRootAndRelaunch: (
      parent: string,
      markOnboarding?: boolean
    ) => Promise<DataRootValidationResult>
    cancelMigrate: () => Promise<void>
    // Phase 2: commit the copied-but-uncommitted move (setDataRoot -> delete old -> relaunch).
    // Returns only on failure (switchoverFailed); on success the app relaunches.
    commitAndRelaunch: (parent: string) => Promise<MigrationOutcome>
    // Throw away a completed-but-uncommitted copy ("Keep current location"); stays on the old root.
    discardMigratedCopy: (parent: string) => Promise<void>
    // Mark the one-time legacy-data-move prompt as answered (declined / keep-here) so it's not shown again.
    dismissLegacyMovePrompt: () => Promise<void>
    onProgress: (listener: AcpListener<MigrationProgress>) => RemoveListener
  }
  reviewer: {
    run: (request: ReviewRunRequest) => Promise<ReviewRunResult>
    getForSession: (request: ReviewSessionRequest) => Promise<ReviewWithChecks[]>
    onUpdated: (listener: AcpListener<ReviewUpdateEvent>) => RemoveListener
    onSuppressNextAutoReview: (listener: AcpListener<ReviewSuppressionEvent>) => RemoveListener
    // Fix loop lock events.
    onFixLoopStart: (listener: AcpListener<ReviewSessionRequest>) => RemoveListener
    onFixLoopEnd: (listener: AcpListener<ReviewSessionRequest>) => RemoveListener
    // Sends an abort request to stop the running fix loop for a session.
    abortFixLoop: (request: ReviewSessionRequest) => Promise<void>
  }
  window: {
    // Closes the focused window (the Cmd+W / Ctrl+W fallback when no preview panel is open).
    close: () => Promise<void>
    // Fires when Cmd+W / Ctrl+W is pressed; the renderer decides pane-vs-window.
    onCloseActivePane: (listener: () => void) => RemoveListener
    // Electron-only whole-window find. These are absent in the localhost Web UI, where the browser
    // owns Cmd/Ctrl+F instead. The find bar itself is an Electron overlay; the Workspace only announces
    // readiness, and the overlay subscribes to show events / requests searches via these.
    findInPage?: (request: WindowFindRequest) => void
    clearFind?: () => void
    announceWindowFindReady?: () => RemoveListener
    onFindInPageResult?: (listener: AcpListener<WindowFindResult>) => RemoveListener
    onShowWindowFind?: (listener: AcpListener<WindowFindAppearance>) => RemoveListener
    onWindowFindAppearance?: (listener: AcpListener<WindowFindAppearance>) => RemoveListener
    announceWindowFindAppearance?: (appearance: WindowFindAppearance) => void
    closeFind?: () => void
    // Fires when main asks to confirm a close/quit; the renderer renders the modal and replies.
    onCloseConfirmRequest?: (listener: (payload: CloseConfirmRequest) => void) => RemoveListener
    // Renderer -> main: modal-mounted ack, then the user's choice, keyed by requestId.
    sendCloseConfirmResponse?: (payload: CloseConfirmResponse) => void
  }
}

// Exposes the small, typed bridge surface available to renderer code.
const api: OpenScienceAPI = {
  saveBlobFile: (request) => electronRendererContracts.invoke('saveBlobFile', request),
  saveManagedFile: (request) => electronRendererContracts.invoke('saveManagedFile', request),
  saveSessionArtifacts: (request) =>
    electronRendererContracts.invoke('saveSessionArtifacts', request),
  platform: process.platform,
  getRuntimeVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }),
  lifecycle: {
    getClientId: () => electronRendererContracts.invoke('lifecycle.getClientId')
  },
  diagnostics: {
    reportRendererFailure: (report) =>
      electronRendererContracts.send('diagnostics.reportRendererFailure', report)
  },
  acp: {
    getState: () => electronRendererContracts.invoke('acp.getState'),
    connect: (request) => electronRendererContracts.invoke('acp.connect', request),
    disconnect: () => electronRendererContracts.invoke('acp.disconnect'),
    createSession: (request) => electronRendererContracts.invoke('acp.createSession', request),
    resumeSession: (request) => electronRendererContracts.invoke('acp.resumeSession', request),
    resetSessionContext: (request) =>
      electronRendererContracts.invoke('acp.resetSessionContext', request),
    sendPrompt: (request) => electronRendererContracts.invoke('acp.sendPrompt', request),
    compactSession: (request) => electronRendererContracts.invoke('acp.compactSession', request),
    cancel: (request) => electronRendererContracts.invoke('acp.cancel', request),
    deleteSession: (request) => electronRendererContracts.invoke('acp.deleteSession', request),
    respondToPermission: (response) =>
      electronRendererContracts.invoke('acp.respondToPermission', response),
    setPermissionProfile: (request) =>
      electronRendererContracts.invoke('acp.setPermissionProfile', request),
    revokePermissionGrant: (request) =>
      electronRendererContracts.invoke('acp.revokePermissionGrant', request),
    onState: (listener) => electronRendererContracts.subscribe('acp.onState', listener),
    onEvent: (listener) => electronRendererContracts.subscribe('acp.onEvent', listener),
    onPermissionRequest: (listener) =>
      electronRendererContracts.subscribe('acp.onPermissionRequest', listener)
  },
  permissions: {
    list: () => electronRendererContracts.invoke('permissions.list'),
    revoke: (request) => electronRendererContracts.invoke('permissions.revoke', request),
    extendUndo: (request) => electronRendererContracts.invoke('permissions.extendUndo', request),
    restore: (request) => electronRendererContracts.invoke('permissions.restore', request),
    onChanged: (listener) => electronRendererContracts.subscribe('permissions.onChanged', listener)
  },
  sessions: {
    // Loads every per-session file plus the last-open manifest from the main process.
    loadAll: () => electronRendererContracts.invoke('sessions.loadAll'),
    // Persists a single sanitized session file.
    saveSession: (session, options) =>
      electronRendererContracts.invoke('sessions.saveSession', session, options),
    // Removes one session file.
    deleteSession: (request) => electronRendererContracts.invoke('sessions.deleteSession', request),
    // Persists the last-open project/session pointer.
    saveManifest: (request) => electronRendererContracts.invoke('sessions.saveManifest', request),
    // Exports the authoritative persisted active branch through a main-owned Save As flow.
    exportConversation: (request) =>
      electronRendererContracts.invoke('sessions.exportConversation', request),
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
    setNotificationsEnabled: (request) =>
      electronRendererContracts.invoke('settings.setNotificationsEnabled', request),
    setConversationSkillImportEnabled: (request) =>
      electronRendererContracts.invoke('settings.setConversationSkillImportEnabled', request),
    setClosePreference: (request) =>
      electronRendererContracts.invoke('settings.setClosePreference', request),
    setAppIconVariant: (request) =>
      electronRendererContracts.invoke('settings.setAppIconVariant', request),
    listAppIcons: () => electronRendererContracts.invoke('settings.listAppIcons'),
    validateProvider: (request) =>
      electronRendererContracts.invoke('settings.validateProvider', request),
    cancelCodexLogin: () => electronRendererContracts.invoke('settings.cancelCodexLogin'),
    cancelClaudeLogin: () => electronRendererContracts.invoke('settings.cancelClaudeLogin'),
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
    listSkills: () => electronRendererContracts.invoke('settings.listSkills'),
    getSkillDetail: (id: string) => electronRendererContracts.invoke('settings.getSkillDetail', id),
    setSkillEnabled: (request: SetSkillEnabledRequest) =>
      electronRendererContracts.invoke('settings.setSkillEnabled', request),
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
    // Fires when a connector call needs the user's approval (external data-egress gate).
    onConnectorApprovalRequest: (listener) =>
      electronRendererContracts.subscribe('settings.onConnectorApprovalRequest', listener),
    onSkillImportApprovalRequest: (listener) =>
      electronRendererContracts.subscribe('settings.onSkillImportApprovalRequest', listener),
    onSkillImportApprovalSettled: (listener) =>
      electronRendererContracts.subscribe('settings.onSkillImportApprovalSettled', listener),
    replayPendingSkillImportApprovals: () =>
      electronRendererContracts.invoke('settings.replayPendingSkillImportApprovals'),
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
    create: (request: CreateSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.create', request),
    update: (request: UpdateSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.update', request),
    setEnabled: (request: SetSpecialistEnabledRequest) =>
      electronRendererContracts.invoke('specialist.setEnabled', request),
    delete: (request: DeleteSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.delete', request),
    duplicate: (request: DuplicateSpecialistRequest) =>
      electronRendererContracts.invoke('specialist.duplicate', request),
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
    delete: (request) => electronRendererContracts.invoke('projects.delete', request),
    onCreated: (listener) => electronRendererContracts.subscribe('projects.onCreated', listener),
    onUpdated: (listener) => electronRendererContracts.subscribe('projects.onUpdated', listener),
    onDeleted: (listener) => electronRendererContracts.subscribe('projects.onDeleted', listener)
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
    // Renderer sends back the user's decision (once / conversation / project / deny).
    respondApproval: (request: { id: string; decision: ComputeApprovalDecision }) =>
      electronRendererContracts.invoke('compute.respondApproval', request),
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
      electronRendererContracts.invoke('compute.enabledHostsSet', sessionId, providerIds)
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
      electronRendererContracts.invoke('artifacts.getVersionReview', request)
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
    reveal: (path) => electronRendererContracts.invoke('localFs.reveal', path),
    openPath: (path) => electronRendererContracts.invoke('localFs.openPath', path)
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
    provision: (lang) => electronRendererContracts.invoke('notebookEnv.provision', lang),
    repair: (lang) => electronRendererContracts.invoke('notebookEnv.repair', lang),
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
    onFindInPageResult: (listener) =>
      electronRendererContracts.subscribe('window.onFindInPageResult', listener),
    // Overlay-only surface: main signals the bar was shown (focus + restore remembered query), and the
    // overlay asks main to hide it. The localhost Web UI never loads this overlay, so both stay optional.
    onShowWindowFind: (listener) =>
      electronRendererContracts.subscribe('window.onShowWindowFind', listener),
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
