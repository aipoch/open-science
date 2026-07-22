import type {
  AcpCancelPromptRequest,
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
  ListProjectArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest
} from '../shared/artifacts'
import type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult
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
import type { OpenLogFileResult, RevealLogFileResult } from '../shared/logs'
import type { OpenSessionFromNotificationRequest } from '../shared/notifications'
import type {
  ProjectDeletedEvent,
  SessionDeletedEvent,
  SessionSavedEvent
} from '../shared/lifecycle-events'
import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  NotebookAvailableEvent,
  NotebookChangedEvent,
  ExecuteNotebookCodeRequest,
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
  ListArtifactGroupsRequest,
  ListProjectFilesRequest,
  ProjectFilesChangedEvent,
  ProjectFilesOverview,
  ProjectFilesPage
} from '../shared/project-files'
import type {
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../shared/session-persistence'
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
  SetNotificationsEnabledRequest,
  SetReasoningEffortRequest,
  SetSkillEnabledRequest,
  SettingsSnapshot,
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
  PreviewSkillZipRequest,
  SkillBundlePreviewResult,
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
  StorageInfo
} from '../shared/storage'
import type { CliLauncherStatus } from '../shared/cli'
import type { AppInfo, DownloadProgress, UpdateStatus } from '../shared/update'
import type {
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageUploadFilesRequest,
  UploadedAttachment
} from '../shared/uploads'
import type {
  ReviewWithChecks,
  ReviewRunRequest,
  ReviewRunResult,
  ReviewUpdateEvent
} from '../shared/reviewer'
import type { CloseConfirmRequest, CloseConfirmResponse } from '../shared/window-controls'

type RemoveListener = () => void
type AcpListener<Payload> = (payload: Payload) => void

interface OpenScienceAPI {
  saveBlobFile(request: SaveBlobFileRequest): Promise<SaveBlobFileResult>
  saveManagedFile(request: SaveManagedFileRequest): Promise<SaveManagedFileResult>
  // Host platform (process.platform), e.g. 'win32' | 'darwin' | 'linux'.
  platform: string
  getRuntimeVersions(): {
    electron: string
    chrome: string
    node: string
  }
  acp: {
    getState(): Promise<AcpStateSnapshot>
    connect(request?: AcpConnectRequest): Promise<AcpStateSnapshot>
    disconnect(): Promise<AcpStateSnapshot>
    createSession(request?: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse>
    resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
    resetSessionContext(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
    sendPrompt(request: AcpPromptRequest): Promise<AcpStateSnapshot>
    cancel(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot>
    deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot>
    respondToPermission(response: AcpPermissionResponse): Promise<AcpStateSnapshot>
    setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<AcpStateSnapshot>
    revokePermissionGrant(request: AcpRevokePermissionGrantRequest): Promise<AcpStateSnapshot>
    onState(listener: AcpListener<AcpStateSnapshot>): RemoveListener
    onEvent(listener: AcpListener<AcpRuntimeEvent>): RemoveListener
    onPermissionRequest(listener: AcpListener<AcpPermissionRequest>): RemoveListener
  }
  sessions: {
    loadAll(): Promise<LoadAllSessionsResult>
    saveSession(session: PersistedChatSession): Promise<void>
    deleteSession(request: DeleteSessionRequest): Promise<void>
    saveManifest(request: SaveSessionManifestRequest): Promise<void>
    onSaved(listener: AcpListener<SessionSavedEvent>): RemoveListener
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
    setNotificationsEnabled(request: SetNotificationsEnabledRequest): Promise<SettingsSnapshot>
    validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult>
    cancelCodexLogin(): Promise<void>
    loginIsolatedCodex(): Promise<ValidateProviderResult>
    logoutIsolatedCodex(): Promise<ValidateProviderResult>
    refreshProviderModels(
      request: RefreshProviderModelsRequest
    ): Promise<RefreshProviderModelsResult>
    markOnboardingComplete(): Promise<SettingsSnapshot>
    getPackageMirror(): Promise<PackageMirror>
    setPackageMirror(request: SetPackageMirrorRequest): Promise<PackageMirror>
    listSkills(): Promise<SkillView[]>
    getSkillDetail(id: string): Promise<SkillDetailView>
    setSkillEnabled(request: SetSkillEnabledRequest): Promise<SkillView[]>
    createSkill(request: CreateSkillRequest): Promise<SkillView[]>
    updateSkill(request: UpdateSkillRequest): Promise<SkillView[]>
    deleteSkill(request: DeleteSkillRequest): Promise<SkillView[]>
    importSkill(request: ImportSkillRequest): Promise<ImportSkillResult>
    importSkillZip(request: ImportSkillZipRequest): Promise<ImportSkillResult>
    importSkillZipBatch(request: ImportSkillZipBatchRequest): Promise<ImportSkillZipBatchResult>
    previewSkillZip(request: PreviewSkillZipRequest): Promise<SkillBundlePreviewResult>
    scanRepoSkills(request: ScanRepoRequest): Promise<ScanRepoResult>
    listConnectors(): Promise<ConnectorsSnapshot>
    getConnectorDetail(id: string): Promise<ConnectorDetailView>
    setConnectorEnabled(request: SetConnectorEnabledRequest): Promise<ConnectorsSnapshot>
    setConnectorAutoAllow(request: SetConnectorAutoAllowRequest): Promise<ConnectorsSnapshot>
    setToolPermission(request: SetToolPermissionRequest): Promise<ConnectorDetailView>
    setNcbiCredentials(request: SetNcbiCredentialsRequest): Promise<ConnectorsSnapshot>
    addCustomServer(request: AddCustomServerRequest): Promise<ConnectorsSnapshot>
    setCustomServerEnabled(request: SetCustomServerEnabledRequest): Promise<ConnectorsSnapshot>
    removeCustomServer(request: RemoveCustomServerRequest): Promise<ConnectorsSnapshot>
    updateCustomServer(request: UpdateCustomServerRequest): Promise<ConnectorsSnapshot>
    onConnectorApprovalRequest(listener: AcpListener<ConnectorApprovalRequest>): RemoveListener
    respondConnectorApproval(request: RespondApprovalRequest): Promise<void>
    onInstallLog(listener: AcpListener<ClaudeInstallEvent>): RemoveListener
  }
  logs: {
    getPath(): Promise<string | null>
    openFile(): Promise<OpenLogFileResult>
    revealInFolder(): Promise<RevealLogFileResult>
  }
  notifications: {
    onOpenSession(listener: () => void): RemoveListener
    takePendingOpenSession(): Promise<OpenSessionFromNotificationRequest | null>
  }
  github: {
    getStars(): Promise<number | null>
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
    delete(request: DeleteProjectRequest): Promise<void>
    onCreated(listener: AcpListener<Project>): RemoveListener
    onUpdated(listener: AcpListener<Project>): RemoveListener
    onDeleted(listener: AcpListener<ProjectDeletedEvent>): RemoveListener
  }
  projectFiles: {
    getOverview(request: { projectId: string }): Promise<ProjectFilesOverview>
    listFiles(request: ListProjectFilesRequest): Promise<ProjectFilesPage>
    listArtifactGroups(request: ListArtifactGroupsRequest): Promise<ArtifactGroupPage>
    repairIndex(request: { projectId: string }): Promise<void>
    onChanged(listener: AcpListener<ProjectFilesChangedEvent>): RemoveListener
  }
  compute: {
    // SSH compute host record CRUD (Compute settings tab). No credentials cross this boundary.
    list(): Promise<ComputeHost[]>
    get(providerId: string): Promise<ComputeHost | null>
    create(request: CreateComputeHostRequest): Promise<ComputeHost>
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
    // Concurrent job limit: store 1..500 (not enforced in Phase 1).
    concurrencySet(providerId: string, limit: number): Promise<void>
    // Fires when a compute call needs user approval (runs before any SSH is made).
    onApprovalRequest(listener: (request: ComputeApprovalRequest) => void): () => void
    // Renderer sends back the user's decision (once / conversation / project / deny).
    respondApproval(request: { id: string; decision: ComputeApprovalDecision }): Promise<void>
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
    // Per-session enabled compute hosts (issue 06). The renderer owns the durable state (session JSON);
    // the main-process registry is the runtime cache for list_compute RPC ops.
    enabledHostsGet(sessionId: string): Promise<string[]>
    enabledHostsSet(sessionId: string, providerIds: string[]): Promise<void>
  }
  preview: {
    load(request: LoadPreviewStateRequest): Promise<PersistedPreviewState | null>
    save(request: SavePreviewStateRequest): Promise<void>
    delete(request: DeletePreviewStateRequest): Promise<void>
  }
  previewResources: {
    acquire(request: AcquireManagedPreviewRequest): Promise<ManagedPreviewResource>
    readRange(request: ReadManagedPreviewRangeRequest): Promise<ManagedPreviewRangeResult>
    release(request: ReleaseManagedPreviewRequest): Promise<void>
  }
  artifacts: {
    finalizeRunArtifacts(request: FinalizeRunArtifactsRequest): Promise<ArtifactFile[]>
    listProjectFiles(request: ListProjectArtifactsRequest): Promise<ArtifactFile[]>
    reconcilePendingArtifacts(request: ReconcilePendingArtifactsRequest): Promise<ArtifactFile[]>
    openFile(request: OpenArtifactFileRequest): Promise<void>
    readPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
  }
  uploads: {
    // Stages files selected or pasted in the renderer into app-managed upload storage.
    stageFiles(request: StageUploadFilesRequest): Promise<UploadedAttachment[]>
    // Deletes a staged upload when the composer chip is removed or the draft is abandoned.
    deleteUpload(request: DeleteUploadRequest): Promise<void>
    // Moves pending uploads into the durable session directory once a session id exists.
    finalizeSession(request: FinalizeUploadSessionRequest): Promise<UploadedAttachment[]>
    // Reads a bounded preview from upload storage using the same preview result shape as artifacts.
    readPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
  }
  notebook: {
    state(request: NotebookSessionRequest): Promise<NotebookSessionState>
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
    exportIpynb(request: NotebookSessionRequest): Promise<ExportNotebookResult>
    restart(request: NotebookSessionRequest): Promise<NotebookSessionState>
    shutdown(request: NotebookSessionRequest): Promise<{ sessionId: string; status: 'shutdown' }>
    onAvailable(listener: AcpListener<NotebookAvailableEvent>): RemoveListener
    onChanged(listener: AcpListener<NotebookChangedEvent>): RemoveListener
  }
  notebookEnv: {
    getStatus(): Promise<ProvisionStatus>
    provision(lang: NotebookLanguage): Promise<void>
    repair(lang: NotebookLanguage): Promise<void>
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
    getInfo(): Promise<StorageInfo>
    detectActive(): Promise<ActiveSessionInfo[]>
    // Opens the native folder picker; resolves null on cancel.
    pickDirectory(): Promise<string | null>
    // Onboarding location step: check a candidate parent before letting the user commit to it.
    // The final data root is always `<parent>/OpenScience`, never the parent itself.
    validateDataRoot(parent: string): Promise<DataRootValidationResult>
    // Settings + onboarding: classify a candidate parent (move/adopt/invalid) without committing;
    // `dataRoot` on the result is the derived `<parent>/OpenScience` path.
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
    discardMigratedCopy(parent: string): Promise<void>
    // Marks the one-time legacy-data-move prompt as answered (declined / keep-here) so it's not shown again.
    dismissLegacyMovePrompt(): Promise<void>
    onProgress(listener: AcpListener<MigrationProgress>): RemoveListener
  }
  reviewer: {
    // Trigger a background review for the given turn. Fire-and-forget; updates come via onUpdated.
    run(request: ReviewRunRequest): Promise<ReviewRunResult>
    // Load persisted reviews for a session (called at workspace startup).
    getForSession(sessionId: string): Promise<ReviewWithChecks[]>
    // Subscribe to review lifecycle/findings updates pushed from the main process.
    onUpdated(listener: AcpListener<ReviewUpdateEvent>): RemoveListener
    // Subscribe to loop-guard events: suppress (or, when clear=true, un-suppress) the next
    // auto-review for the given session.
    onSuppressNextAutoReview(
      listener: AcpListener<{ sessionId: string; clear?: boolean }>
    ): RemoveListener
    // Fix loop lock: fired when the loop starts (lock composer) / ends or is aborted (unlock).
    onFixLoopStart(listener: AcpListener<{ sessionId: string }>): RemoveListener
    onFixLoopEnd(listener: AcpListener<{ sessionId: string }>): RemoveListener
    // Sends an abort request to stop the running fix loop for a session.
    abortFixLoop(sessionId: string): Promise<void>
  }
  window: {
    // Closes the focused window (the Cmd+W / Ctrl+W fallback when no preview panel is open).
    close(): Promise<void>
    // Fires when Cmd+W / Ctrl+W is pressed; the renderer decides pane-vs-window.
    onCloseActivePane(listener: () => void): RemoveListener
    // Fires when main asks to confirm a close/quit; the renderer renders the modal and replies.
    onCloseConfirmRequest(listener: (payload: CloseConfirmRequest) => void): RemoveListener
    // Renderer -> main: modal-mounted ack, then the user's choice, keyed by requestId.
    sendCloseConfirmResponse(payload: CloseConfirmResponse): void
  }
}

declare global {
  interface Window {
    api: OpenScienceAPI
  }
}

export {}
