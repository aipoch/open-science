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
import { RENDERER_FAILURE_CHANNEL, type RendererFailureReport } from '../shared/diagnostics'
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
import {
  OFFICE_PREVIEW_ATTACH_FRAME_CHANNEL,
  OFFICE_PREVIEW_CLOSE_CHANNEL,
  OFFICE_PREVIEW_OPEN_CHANNEL,
  OFFICE_PREVIEW_REPORT_STATE_CHANNEL,
  OFFICE_PREVIEW_STATE_CHANNEL
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
import {
  SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL,
  SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL,
  type SessionPersistenceFlushRequest,
  type SessionPersistenceFlushResponse
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
import { REVIEWER_IPC } from '../shared/reviewer'
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
  WINDOW_CLOSE_CHANNEL,
  WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
  WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL,
  WINDOW_FIND_CLEAR_CHANNEL,
  WINDOW_FIND_CLOSE_CHANNEL,
  WINDOW_FIND_APPEARANCE_CHANNEL,
  WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL,
  WINDOW_FIND_REQUEST_CHANNEL,
  WINDOW_FIND_RESULT_CHANNEL,
  WINDOW_FIND_SHOW_CHANNEL,
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
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener)
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
  saveBlobFile: (request) =>
    ipcRenderer.invoke('file:save-blob', request) as Promise<SaveBlobFileResult>,
  saveManagedFile: (request) =>
    ipcRenderer.invoke('file:save-managed', request) as Promise<SaveManagedFileResult>,
  saveSessionArtifacts: (request) =>
    ipcRenderer.invoke(
      'file:save-session-artifacts',
      request
    ) as Promise<SaveSessionArtifactsResult>,
  platform: process.platform,
  getRuntimeVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }),
  lifecycle: {
    getClientId: () => ipcRenderer.invoke('lifecycle:client-id') as Promise<string>
  },
  diagnostics: {
    reportRendererFailure: (report) => ipcRenderer.send(RENDERER_FAILURE_CHANNEL, report)
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
    loadAll: () => ipcRenderer.invoke('sessions:load-all') as Promise<LoadAllSessionsResult>,
    // Persists a single sanitized session file.
    saveSession: (session, options) =>
      (options
        ? ipcRenderer.invoke('sessions:save-session', session, options)
        : ipcRenderer.invoke('sessions:save-session', session)) as Promise<PersistedChatSession>,
    // Removes one session file.
    deleteSession: (request) =>
      ipcRenderer.invoke('sessions:delete-session', request) as Promise<void>,
    // Persists the last-open project/session pointer.
    saveManifest: (request) =>
      ipcRenderer.invoke('sessions:save-manifest', request) as Promise<void>,
    // Exports the authoritative persisted active branch through a main-owned Save As flow.
    exportConversation: (request) =>
      ipcRenderer.invoke(
        'sessions:export-conversation',
        request
      ) as Promise<ExportConversationResult>,
    onFlushRequest: (listener) => onIpcMessage(SESSION_PERSISTENCE_FLUSH_REQUEST_CHANNEL, listener),
    sendFlushResponse: (response) =>
      ipcRenderer.send(SESSION_PERSISTENCE_FLUSH_RESPONSE_CHANNEL, response),
    onCreated: (listener) => onIpcMessage('session:created', listener),
    onUpdated: (listener) => onIpcMessage('session:updated', listener),
    onDeleted: (listener) => onIpcMessage('session:deleted', listener)
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
    getSnapshot: () =>
      ipcRenderer.invoke('remote-access:get-snapshot') as Promise<RemoteAccessSnapshot>,
    detect: () => ipcRenderer.invoke('remote-access:detect') as Promise<RemoteAccessSnapshot>,
    disable: () => ipcRenderer.invoke('remote-access:disable') as Promise<RemoteAccessSnapshot>,
    setMode: (request) =>
      ipcRenderer.invoke('remote-access:set-mode', request) as Promise<RemoteAccessSnapshot>,
    approve: (request) =>
      ipcRenderer.invoke('remote-access:approve', request) as Promise<RemoteAccessSnapshot>,
    reject: (request) =>
      ipcRenderer.invoke('remote-access:reject', request) as Promise<RemoteAccessSnapshot>,
    revokeBrowser: (request) =>
      ipcRenderer.invoke('remote-access:revoke-browser', request) as Promise<RemoteAccessSnapshot>,
    onChanged: (listener) => onIpcMessage('remote-access:changed', () => listener())
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
    getPath: () => ipcRenderer.invoke('logs:get-path') as Promise<string | null>,
    openFile: () => ipcRenderer.invoke('logs:open-file') as Promise<OpenLogFileResult>,
    revealInFolder: () =>
      ipcRenderer.invoke('logs:reveal-in-folder') as Promise<RevealLogFileResult>
  },
  notifications: {
    // Main-process task notifications route their click through this channel.
    onOpenSession: (listener) => onIpcMessage('notifications:open-session', listener),
    peekPendingOpenSession: () =>
      ipcRenderer.invoke(
        'notifications:peek-pending-open-session'
      ) as Promise<OpenSessionFromNotificationRequest | null>,
    takePendingOpenSession: (expectedToken) =>
      ipcRenderer.invoke(
        'notifications:take-pending-open-session',
        expectedToken
      ) as Promise<OpenSessionFromNotificationRequest | null>,
    syncViewState: (state) => ipcRenderer.send('notifications:sync-unread-view', state),
    onViewProbe: (listener) => onIpcMessage('notifications:probe-unread-view', listener)
  },
  github: {
    getStars: () => ipcRenderer.invoke('github:get-stars') as Promise<number | null>
  },
  cli: {
    getStatus: () => ipcRenderer.invoke('cli:get-status') as Promise<CliLauncherStatus>,
    install: () => ipcRenderer.invoke('cli:install') as Promise<CliLauncherStatus>,
    uninstall: () => ipcRenderer.invoke('cli:uninstall') as Promise<CliLauncherStatus>
  },
  update: {
    getAppInfo: () => ipcRenderer.invoke('update:get-app-info') as Promise<AppInfo>,
    getStatus: () => ipcRenderer.invoke('update:get-status') as Promise<UpdateStatus>,
    check: () => ipcRenderer.invoke('update:check') as Promise<UpdateStatus>,
    download: () => ipcRenderer.invoke('update:download') as Promise<UpdateStatus>,
    cancel: () => ipcRenderer.invoke('update:cancel') as Promise<UpdateStatus>,
    apply: () => ipcRenderer.invoke('update:apply') as Promise<UpdateStatus>,
    onStatus: (listener) => onIpcMessage('update:status', listener),
    onProgress: (listener) => onIpcMessage('update:progress', listener)
  },
  projects: {
    // Project CRUD backed by the SQLite/Prisma layer (scope: projects only).
    list: () => ipcRenderer.invoke('projects:list') as Promise<Project[]>,
    get: (id) => ipcRenderer.invoke('projects:get', id) as Promise<Project | null>,
    create: (request) => ipcRenderer.invoke('projects:create', request) as Promise<Project>,
    update: (request) => ipcRenderer.invoke('projects:update', request) as Promise<Project>,
    delete: (request) => ipcRenderer.invoke('projects:delete', request) as Promise<void>,
    onCreated: (listener) => onIpcMessage('project:created', listener),
    onUpdated: (listener) => onIpcMessage('project:updated', listener),
    onDeleted: (listener) => onIpcMessage('project:deleted', listener)
  },
  // Files exposes metadata pages only. Thumbnail/full-preview bytes continue through the existing
  // artifact/upload APIs after a visible item has been selected or rendered.
  projectFiles: {
    getOverview: (request) =>
      ipcRenderer.invoke('project-files:get-overview', request) as Promise<ProjectFilesOverview>,
    listFiles: (request) =>
      ipcRenderer.invoke('project-files:list-files', request) as Promise<ProjectFilesPage>,
    listArtifactGroups: (request) =>
      ipcRenderer.invoke(
        'project-files:list-artifact-groups',
        request
      ) as Promise<ArtifactGroupPage>,
    searchArtifacts: (request) =>
      ipcRenderer.invoke(
        'project-files:search-artifacts',
        request
      ) as Promise<SearchArtifactsResult>,
    repairIndex: (request) =>
      ipcRenderer.invoke('project-files:repair-index', request) as Promise<void>,
    onChanged: (listener) => onIpcMessage('project-files:changed', listener)
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
    load: (request) =>
      ipcRenderer.invoke('preview:load', request) as Promise<PersistedPreviewState | null>,
    save: (request) => ipcRenderer.invoke('preview:save', request) as Promise<void>,
    delete: (request) => ipcRenderer.invoke('preview:delete', request) as Promise<void>
  },
  previewResources: {
    acquire: (request) =>
      ipcRenderer.invoke('preview-resources:acquire', request) as Promise<ManagedPreviewResource>,
    readRange: (request) =>
      ipcRenderer.invoke(
        'preview-resources:read-range',
        request
      ) as Promise<ManagedPreviewRangeResult>,
    release: (request) => ipcRenderer.invoke('preview-resources:release', request) as Promise<void>
  },
  officePreview: {
    open: (request) =>
      ipcRenderer.invoke(OFFICE_PREVIEW_OPEN_CHANNEL, request) as Promise<OfficePreviewOpenResult>,
    attachFrame: (sessionId) =>
      ipcRenderer.invoke(OFFICE_PREVIEW_ATTACH_FRAME_CHANNEL, sessionId) as Promise<
        OfficePreviewAttachResult | undefined
      >,
    // Runtime phases are one-way notifications relayed from the sandboxed child frame.
    reportState: (sessionId, state) =>
      ipcRenderer.send(OFFICE_PREVIEW_REPORT_STATE_CHANNEL, sessionId, state),
    close: (sessionId) =>
      ipcRenderer.invoke(OFFICE_PREVIEW_CLOSE_CHANNEL, sessionId) as Promise<void>,
    onState: (listener) => onIpcMessage(OFFICE_PREVIEW_STATE_CHANNEL, listener)
  },
  artifacts: {
    // Keep generated file movement in the main process where filesystem trust checks live.
    finalizeRunArtifacts: (request) =>
      ipcRenderer.invoke('artifacts:finalize-run', request) as Promise<FinalizeRunArtifactsResult>,
    // Lists every on-disk artifact for a project so orphaned files (owning session deleted) still show.
    listProjectFiles: (request) =>
      ipcRenderer.invoke('artifacts:list-project-files', request) as Promise<ArtifactFile[]>,
    // Re-finalizes crash-orphaned pending artifacts so the renderer can replace stale pending paths.
    reconcilePendingArtifacts: (request) =>
      ipcRenderer.invoke('artifacts:reconcile-pending', request) as Promise<ArtifactFile[]>,
    openFile: (request) => ipcRenderer.invoke('artifacts:open-file', request) as Promise<void>,
    // Keep preview reads on the same managed-file trust path as opening files.
    readPreview: (request) =>
      ipcRenderer.invoke('artifacts:read-preview', request) as Promise<ArtifactPreviewResult>,
    getLineage: (request) =>
      ipcRenderer.invoke('artifacts:get-lineage', request) as Promise<
        ArtifactLineageProvenance | undefined
      >,
    getVersionProvenance: (request) =>
      ipcRenderer.invoke(
        'artifacts:get-version-provenance',
        request
      ) as Promise<ArtifactVersionProvenance>,
    getVersionExecution: (request) =>
      ipcRenderer.invoke(
        'artifacts:get-version-execution',
        request
      ) as Promise<ArtifactVersionExecutionProvenance>,
    getVersionMessages: (request) =>
      ipcRenderer.invoke(
        'artifacts:get-version-messages',
        request
      ) as Promise<ArtifactVersionMessagesProvenance>,
    getVersionReview: (request) =>
      ipcRenderer.invoke(
        'artifacts:get-version-review',
        request
      ) as Promise<ArtifactVersionReviewProvenance>
  },
  uploads: {
    // Upload IPC remains behind the preload bridge so renderer code never receives raw fs access.
    stageLocalFile: async (file, request) => {
      const sourcePath = webUtils.getPathForFile(file)
      if (!sourcePath) return null
      return (await ipcRenderer.invoke('uploads:stage-local-file', {
        ...request,
        sourcePath
      })) as UploadedAttachment
    },
    claimLocalFile: (request) =>
      ipcRenderer.invoke('uploads:claim-local-file', request) as Promise<void>,
    // Save-as-artifact from the local-file preview; the renderer supplies the path directly.
    stageLocalPath: (request) =>
      ipcRenderer.invoke('uploads:stage-local-path', request) as Promise<UploadedAttachment>,
    beginTransfer: (request) =>
      ipcRenderer.invoke('uploads:begin-transfer', request) as Promise<UploadTransferStatus>,
    appendTransfer: (request) =>
      ipcRenderer.invoke('uploads:append-transfer', request) as Promise<UploadTransferStatus>,
    getTransferStatus: (request) =>
      ipcRenderer.invoke(
        'uploads:transfer-status',
        request
      ) as Promise<UploadTransferStatus | null>,
    finishTransfer: (request) =>
      ipcRenderer.invoke('uploads:finish-transfer', request) as Promise<UploadedAttachment>,
    abortTransfer: (request) =>
      ipcRenderer.invoke('uploads:abort-transfer', request) as Promise<void>,
    onTransferProgress: (listener) => onIpcMessage('uploads:transfer-progress', listener),
    deleteUpload: (request) => ipcRenderer.invoke('uploads:delete', request) as Promise<void>,
    finalizeSession: (request) =>
      ipcRenderer.invoke('uploads:finalize-session', request) as Promise<UploadedAttachment[]>,
    readPreview: (request) =>
      ipcRenderer.invoke('uploads:read-preview', request) as Promise<ArtifactPreviewResult>
  },
  localFs: {
    // Local-fs IPC stays behind the preload bridge so renderer code never receives raw fs access.
    listDir: (path) => ipcRenderer.invoke('local-fs:list-dir', path) as Promise<LocalDirListing>,
    readPreview: (request) =>
      ipcRenderer.invoke('local-fs:read-preview', request) as Promise<ArtifactPreviewResult>,
    getRoots: () => ipcRenderer.invoke('local-fs:get-roots') as Promise<LocalRoots>,
    reveal: (path) => ipcRenderer.invoke('local-fs:reveal', path) as Promise<void>,
    openPath: (path) => ipcRenderer.invoke('local-fs:open-path', path) as Promise<string>
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
    getInfo: () => ipcRenderer.invoke('storage:get-info') as Promise<StorageInfo>,
    revealAppStorage: () =>
      ipcRenderer.invoke('storage:reveal-app-storage') as Promise<RevealAppStorageResult>,
    detectActive: () => ipcRenderer.invoke('storage:detect-active') as Promise<ActiveSessionInfo[]>,
    pickDirectory: () => ipcRenderer.invoke('storage:pick-directory') as Promise<string | null>,
    validateDataRoot: (parent) =>
      ipcRenderer.invoke('storage:validate-data-root', {
        parent
      }) as Promise<DataRootValidationResult>,
    inspectDataRoot: (parent) =>
      ipcRenderer.invoke('storage:inspect-data-root', { parent }) as Promise<DataRootInspection>,
    migrate: (parent) =>
      ipcRenderer.invoke('storage:migrate', { parent }) as Promise<MigrationOutcome>,
    setDataRootAndRelaunch: (parent, markOnboarding) =>
      ipcRenderer.invoke('storage:set-data-root-and-relaunch', {
        parent,
        markOnboarding
      }) as Promise<DataRootValidationResult>,
    cancelMigrate: () => ipcRenderer.invoke('storage:cancel-migrate') as Promise<void>,
    commitAndRelaunch: (parent) =>
      ipcRenderer.invoke('storage:commit-and-relaunch', { parent }) as Promise<MigrationOutcome>,
    discardMigratedCopy: (parent) =>
      ipcRenderer.invoke('storage:discard-migrated-copy', { parent }) as Promise<void>,
    dismissLegacyMovePrompt: () =>
      ipcRenderer.invoke('storage:dismiss-legacy-move-prompt') as Promise<void>,
    onProgress: (listener) => onIpcMessage('storage:migrate-progress', listener)
  },
  reviewer: {
    run: (request: ReviewRunRequest) =>
      ipcRenderer.invoke(REVIEWER_IPC.RUN, request) as Promise<ReviewRunResult>,
    getForSession: (request: ReviewSessionRequest) =>
      ipcRenderer.invoke(REVIEWER_IPC.GET_FOR_SESSION, request) as Promise<ReviewWithChecks[]>,
    onUpdated: (listener) => onIpcMessage(REVIEWER_IPC.UPDATED, listener),
    onSuppressNextAutoReview: (listener: AcpListener<ReviewSuppressionEvent>) =>
      onIpcMessage(REVIEWER_IPC.SUPPRESS_NEXT_AUTO_REVIEW, listener),
    // Fix loop lock: fired when the loop starts (lock composer) / ends or is aborted (unlock).
    onFixLoopStart: (listener: AcpListener<ReviewSessionRequest>) =>
      onIpcMessage(REVIEWER_IPC.FIX_LOOP_START, listener),
    onFixLoopEnd: (listener: AcpListener<ReviewSessionRequest>) =>
      onIpcMessage(REVIEWER_IPC.FIX_LOOP_END, listener),
    // Sends an abort request to the main process to stop the running fix loop for a session.
    abortFixLoop: (request: ReviewSessionRequest) =>
      ipcRenderer.invoke(REVIEWER_IPC.ABORT_FIX_LOOP, request) as Promise<void>
  },
  window: {
    close: () => ipcRenderer.invoke(WINDOW_CLOSE_CHANNEL) as Promise<void>,
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
    findInPage: (request) => ipcRenderer.send(WINDOW_FIND_REQUEST_CHANNEL, request),
    clearFind: () => ipcRenderer.send(WINDOW_FIND_CLEAR_CHANNEL),
    // The Workspace announces it is mounted and searchable so main knows whether to intercept
    // Cmd/Ctrl+F. Returns a teardown that announces UNREADY on unmount.
    announceWindowFindReady: () =>
      announceWindowFindReady({ send: (channel) => ipcRenderer.send(channel) }),
    onFindInPageResult: (listener) => onIpcMessage(WINDOW_FIND_RESULT_CHANNEL, listener),
    // Overlay-only surface: main signals the bar was shown (focus + restore remembered query), and the
    // overlay asks main to hide it. The localhost Web UI never loads this overlay, so both stay optional.
    onShowWindowFind: (listener) => onIpcMessage(WINDOW_FIND_SHOW_CHANNEL, listener),
    onWindowFindAppearance: (listener) => onIpcMessage(WINDOW_FIND_APPEARANCE_CHANNEL, listener),
    announceWindowFindAppearance: (appearance) =>
      ipcRenderer.send(WINDOW_FIND_APPEARANCE_CHANGED_CHANNEL, appearance),
    closeFind: () => ipcRenderer.send(WINDOW_FIND_CLOSE_CHANNEL),
    onCloseConfirmRequest: (listener) =>
      onIpcMessage(WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL, listener),
    sendCloseConfirmResponse: (payload) =>
      ipcRenderer.send(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL, payload)
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
