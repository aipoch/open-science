import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

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
import type { OpenLogFileResult, RevealLogFileResult } from '../shared/logs'
import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  NotebookAvailableEvent,
  NotebookChangedEvent,
  ExecuteNotebookCodeRequest,
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
import type { AppInfo, UpdateStatus } from '../shared/update'
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
import { REVIEWER_IPC } from '../shared/reviewer'
import {
  subscribeCloseActivePane,
  WINDOW_CLOSE_CHANNEL,
  WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
  WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL,
  type CloseConfirmRequest,
  type CloseConfirmResponse
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

// Custom APIs for renderer
type OpenScienceAPI = {
  saveBlobFile: (request: SaveBlobFileRequest) => Promise<SaveBlobFileResult>
  saveManagedFile: (request: SaveManagedFileRequest) => Promise<SaveManagedFileResult>
  // Host platform (process.platform), e.g. 'win32' | 'darwin' | 'linux'. Lets the renderer pick
  // platform-correct copy such as the claude install command shown in the onboarding/settings card.
  platform: string
  getRuntimeVersions: () => {
    electron: string
    chrome: string
    node: string
  }
  acp: {
    getState: () => Promise<AcpStateSnapshot>
    connect: (request?: AcpConnectRequest) => Promise<AcpStateSnapshot>
    disconnect: () => Promise<AcpStateSnapshot>
    createSession: (request?: AcpCreateSessionRequest) => Promise<AcpCreateSessionResponse>
    resumeSession: (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
    resetSessionContext: (request: AcpResumeSessionRequest) => Promise<AcpCreateSessionResponse>
    sendPrompt: (request: AcpPromptRequest) => Promise<AcpStateSnapshot>
    cancel: (request: AcpCancelPromptRequest) => Promise<AcpStateSnapshot>
    deleteSession: (request: AcpDeleteSessionRequest) => Promise<AcpStateSnapshot>
    respondToPermission: (response: AcpPermissionResponse) => Promise<AcpStateSnapshot>
    setPermissionProfile: (request: AcpSetPermissionProfileRequest) => Promise<AcpStateSnapshot>
    revokePermissionGrant: (request: AcpRevokePermissionGrantRequest) => Promise<AcpStateSnapshot>
    onState: (listener: AcpListener<AcpStateSnapshot>) => RemoveListener
    onEvent: (listener: AcpListener<AcpRuntimeEvent>) => RemoveListener
    onPermissionRequest: (listener: AcpListener<AcpPermissionRequest>) => RemoveListener
  }
  sessions: {
    loadAll: () => Promise<LoadAllSessionsResult>
    saveSession: (session: PersistedChatSession) => Promise<void>
    deleteSession: (request: DeleteSessionRequest) => Promise<void>
    saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
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
    validateProvider: (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
    cancelCodexLogin: () => Promise<void>
    loginIsolatedCodex: () => Promise<ValidateProviderResult>
    logoutIsolatedCodex: () => Promise<ValidateProviderResult>
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
    scanRepoSkills: (request: ScanRepoRequest) => Promise<ScanRepoResult>
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
    respondConnectorApproval: (request: RespondApprovalRequest) => Promise<void>
    onInstallLog: (listener: AcpListener<ClaudeInstallEvent>) => RemoveListener
  }
  logs: {
    getPath: () => Promise<string | null>
    openFile: () => Promise<OpenLogFileResult>
    revealInFolder: () => Promise<RevealLogFileResult>
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
    onProgress: (listener: (percent: number) => void) => RemoveListener
  }
  projects: {
    list: () => Promise<Project[]>
    get: (id: string) => Promise<Project | null>
    create: (request: CreateProjectRequest) => Promise<Project>
    update: (request: UpdateProjectRequest) => Promise<Project>
    delete: (request: DeleteProjectRequest) => Promise<void>
  }
  projectFiles: {
    getOverview: (request: { projectId: string }) => Promise<ProjectFilesOverview>
    listFiles: (request: ListProjectFilesRequest) => Promise<ProjectFilesPage>
    listArtifactGroups: (request: ListArtifactGroupsRequest) => Promise<ArtifactGroupPage>
    repairIndex: (request: { projectId: string }) => Promise<void>
    onChanged: (listener: AcpListener<ProjectFilesChangedEvent>) => RemoveListener
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
  artifacts: {
    // Finalizes files produced during one runtime event after the renderer has selected a message.
    finalizeRunArtifacts: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
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
  }
  uploads: {
    // Stages files selected or pasted in the renderer into app-managed upload storage.
    stageFiles: (request: StageUploadFilesRequest) => Promise<UploadedAttachment[]>
    // Deletes a staged upload when the composer chip is removed or the draft is abandoned.
    deleteUpload: (request: DeleteUploadRequest) => Promise<void>
    // Moves pending uploads into the durable session directory once a session id exists.
    finalizeSession: (request: FinalizeUploadSessionRequest) => Promise<UploadedAttachment[]>
    // Reads a bounded preview from upload storage using the same preview result shape as artifacts.
    readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  }
  notebook: {
    state: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
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
    cancel: () => Promise<void>
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
    getForSession: (sessionId: string) => Promise<ReviewWithChecks[]>
    onUpdated: (listener: AcpListener<ReviewUpdateEvent>) => RemoveListener
    onSuppressNextAutoReview: (
      listener: AcpListener<{ sessionId: string; clear?: boolean }>
    ) => RemoveListener
    // Fix loop lock events.
    onFixLoopStart: (listener: AcpListener<{ sessionId: string }>) => RemoveListener
    onFixLoopEnd: (listener: AcpListener<{ sessionId: string }>) => RemoveListener
    // Sends an abort request to stop the running fix loop for a session.
    abortFixLoop: (sessionId: string) => Promise<void>
  }
  window: {
    // Closes the focused window (the Cmd+W / Ctrl+W fallback when no preview panel is open).
    close: () => Promise<void>
    // Fires when Cmd+W / Ctrl+W is pressed; the renderer decides pane-vs-window.
    onCloseActivePane: (listener: () => void) => RemoveListener
    // Fires when main asks to confirm a close/quit; the renderer renders the modal and replies.
    onCloseConfirmRequest: (listener: (payload: CloseConfirmRequest) => void) => RemoveListener
    // Renderer -> main: modal-mounted ack, then the user's choice, keyed by requestId.
    sendCloseConfirmResponse: (payload: CloseConfirmResponse) => void
  }
}

// Exposes the small, typed bridge surface available to renderer code.
const api: OpenScienceAPI = {
  saveBlobFile: (request) =>
    ipcRenderer.invoke('file:save-blob', request) as Promise<SaveBlobFileResult>,
  saveManagedFile: (request) =>
    ipcRenderer.invoke('file:save-managed', request) as Promise<SaveManagedFileResult>,
  platform: process.platform,
  getRuntimeVersions: () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }),
  acp: {
    getState: () => ipcRenderer.invoke('acp:get-state') as Promise<AcpStateSnapshot>,
    connect: (request = {}) =>
      ipcRenderer.invoke('acp:connect', request) as Promise<AcpStateSnapshot>,
    disconnect: () => ipcRenderer.invoke('acp:disconnect') as Promise<AcpStateSnapshot>,
    createSession: (request = {}) =>
      ipcRenderer.invoke('acp:create-session', request) as Promise<AcpCreateSessionResponse>,
    resumeSession: (request) =>
      ipcRenderer.invoke('acp:resume-session', request) as Promise<AcpCreateSessionResponse>,
    resetSessionContext: (request) =>
      ipcRenderer.invoke('acp:reset-session-context', request) as Promise<AcpCreateSessionResponse>,
    sendPrompt: (request) =>
      ipcRenderer.invoke('acp:send-prompt', request) as Promise<AcpStateSnapshot>,
    cancel: (request) => ipcRenderer.invoke('acp:cancel', request) as Promise<AcpStateSnapshot>,
    deleteSession: (request) =>
      ipcRenderer.invoke('acp:delete-session', request) as Promise<AcpStateSnapshot>,
    respondToPermission: (response) =>
      ipcRenderer.invoke('acp:respond-permission', response) as Promise<AcpStateSnapshot>,
    setPermissionProfile: (request) =>
      ipcRenderer.invoke('acp:set-permission-profile', request) as Promise<AcpStateSnapshot>,
    revokePermissionGrant: (request) =>
      ipcRenderer.invoke('acp:revoke-permission-grant', request) as Promise<AcpStateSnapshot>,
    onState: (listener) => onIpcMessage('acp:state', listener),
    onEvent: (listener) => onIpcMessage('acp:event', listener),
    onPermissionRequest: (listener) => onIpcMessage('acp:permission-request', listener)
  },
  sessions: {
    // Loads every per-session file plus the last-open manifest from the main process.
    loadAll: () => ipcRenderer.invoke('sessions:load-all') as Promise<LoadAllSessionsResult>,
    // Persists a single sanitized session file.
    saveSession: (session) => ipcRenderer.invoke('sessions:save-session', session) as Promise<void>,
    // Removes one session file.
    deleteSession: (request) =>
      ipcRenderer.invoke('sessions:delete-session', request) as Promise<void>,
    // Persists the last-open project/session pointer.
    saveManifest: (request) =>
      ipcRenderer.invoke('sessions:save-manifest', request) as Promise<void>
  },
  settings: {
    // Model-settings/onboarding surface: secrets stay in main, the renderer only sees masked views.
    getPreflight: () => ipcRenderer.invoke('settings:get-preflight') as Promise<Preflight>,
    getSettings: () => ipcRenderer.invoke('settings:get-settings') as Promise<SettingsSnapshot>,
    isEncryptionAvailable: () =>
      ipcRenderer.invoke('settings:encryption-available') as Promise<boolean>,
    isNpmAvailable: () => ipcRenderer.invoke('settings:npm-available') as Promise<boolean>,
    checkEnvironment: () =>
      ipcRenderer.invoke('settings:check-environment') as Promise<EnvironmentCheckResult>,
    detectClaude: () => ipcRenderer.invoke('settings:detect-claude') as Promise<ClaudeDetectResult>,
    detectOpencode: () =>
      ipcRenderer.invoke('settings:detect-opencode') as Promise<SettingsSnapshot>,
    detectCodex: () => ipcRenderer.invoke('settings:detect-codex') as Promise<SettingsSnapshot>,
    installClaude: (request) =>
      ipcRenderer.invoke('settings:install-claude', request) as Promise<ClaudeInstallResult>,
    installOpencode: (request) =>
      ipcRenderer.invoke('settings:install-opencode', request) as Promise<ClaudeInstallResult>,
    installCodex: (request: InstallCodexRequest) =>
      ipcRenderer.invoke('settings:install-codex', request) as Promise<ClaudeInstallResult>,
    uninstallClaude: () =>
      ipcRenderer.invoke('settings:uninstall-claude') as Promise<SettingsSnapshot>,
    uninstallOpencode: () =>
      ipcRenderer.invoke('settings:uninstall-opencode') as Promise<SettingsSnapshot>,
    uninstallCodex: () =>
      ipcRenderer.invoke('settings:uninstall-codex') as Promise<SettingsSnapshot>,
    upsertProvider: (request) =>
      ipcRenderer.invoke('settings:upsert-provider', request) as Promise<SettingsSnapshot>,
    deleteProvider: (request) =>
      ipcRenderer.invoke('settings:delete-provider', request) as Promise<SettingsSnapshot>,
    setActiveProvider: (request) =>
      ipcRenderer.invoke('settings:set-active-provider', request) as Promise<SettingsSnapshot>,
    setAgentFramework: (request) =>
      ipcRenderer.invoke('settings:set-agent-framework', request) as Promise<SettingsSnapshot>,
    validateProvider: (request) =>
      ipcRenderer.invoke('settings:validate-provider', request) as Promise<ValidateProviderResult>,
    cancelCodexLogin: () => ipcRenderer.invoke('settings:cancel-codex-login') as Promise<void>,
    loginIsolatedCodex: () =>
      ipcRenderer.invoke('settings:login-isolated-codex') as Promise<ValidateProviderResult>,
    logoutIsolatedCodex: () =>
      ipcRenderer.invoke('settings:logout-isolated-codex') as Promise<ValidateProviderResult>,
    refreshProviderModels: (request) =>
      ipcRenderer.invoke(
        'settings:refresh-provider-models',
        request
      ) as Promise<RefreshProviderModelsResult>,
    markOnboardingComplete: () =>
      ipcRenderer.invoke('settings:mark-onboarding-complete') as Promise<SettingsSnapshot>,
    getPackageMirror: () =>
      ipcRenderer.invoke('settings:get-package-mirror') as Promise<PackageMirror>,
    setPackageMirror: (request) =>
      ipcRenderer.invoke('settings:set-package-mirror', request) as Promise<PackageMirror>,
    listSkills: () => ipcRenderer.invoke('settings:list-skills') as Promise<SkillView[]>,
    getSkillDetail: (id: string) =>
      ipcRenderer.invoke('settings:get-skill-detail', id) as Promise<SkillDetailView>,
    setSkillEnabled: (request: SetSkillEnabledRequest) =>
      ipcRenderer.invoke('settings:set-skill-enabled', request) as Promise<SkillView[]>,
    createSkill: (request: CreateSkillRequest) =>
      ipcRenderer.invoke('settings:create-skill', request) as Promise<SkillView[]>,
    updateSkill: (request: UpdateSkillRequest) =>
      ipcRenderer.invoke('settings:update-skill', request) as Promise<SkillView[]>,
    deleteSkill: (request: DeleteSkillRequest) =>
      ipcRenderer.invoke('settings:delete-skill', request) as Promise<SkillView[]>,
    importSkill: (request: ImportSkillRequest) =>
      ipcRenderer.invoke('settings:import-skill', request) as Promise<ImportSkillResult>,
    importSkillZip: (request: ImportSkillZipRequest) =>
      ipcRenderer.invoke('settings:import-skill-zip', request) as Promise<ImportSkillResult>,
    importSkillZipBatch: (request: ImportSkillZipBatchRequest) =>
      ipcRenderer.invoke(
        'settings:import-skill-zip-batch',
        request
      ) as Promise<ImportSkillZipBatchResult>,
    previewSkillZip: (request: PreviewSkillZipRequest) =>
      ipcRenderer.invoke(
        'settings:preview-skill-zip',
        request
      ) as Promise<SkillBundlePreviewResult>,
    scanRepoSkills: (request: ScanRepoRequest) =>
      ipcRenderer.invoke('settings:scan-repo-skills', request) as Promise<ScanRepoResult>,
    listConnectors: () =>
      ipcRenderer.invoke('settings:list-connectors') as Promise<ConnectorsSnapshot>,
    getConnectorDetail: (id: string) =>
      ipcRenderer.invoke('settings:get-connector-detail', id) as Promise<ConnectorDetailView>,
    setConnectorEnabled: (request: SetConnectorEnabledRequest) =>
      ipcRenderer.invoke('settings:set-connector-enabled', request) as Promise<ConnectorsSnapshot>,
    setConnectorAutoAllow: (request: SetConnectorAutoAllowRequest) =>
      ipcRenderer.invoke(
        'settings:set-connector-auto-allow',
        request
      ) as Promise<ConnectorsSnapshot>,
    setToolPermission: (request: SetToolPermissionRequest) =>
      ipcRenderer.invoke('settings:set-tool-permission', request) as Promise<ConnectorDetailView>,
    setNcbiCredentials: (request: SetNcbiCredentialsRequest) =>
      ipcRenderer.invoke('settings:set-ncbi-credentials', request) as Promise<ConnectorsSnapshot>,
    addCustomServer: (request: AddCustomServerRequest) =>
      ipcRenderer.invoke('settings:add-custom-server', request) as Promise<ConnectorsSnapshot>,
    setCustomServerEnabled: (request: SetCustomServerEnabledRequest) =>
      ipcRenderer.invoke(
        'settings:set-custom-server-enabled',
        request
      ) as Promise<ConnectorsSnapshot>,
    removeCustomServer: (request: RemoveCustomServerRequest) =>
      ipcRenderer.invoke('settings:remove-custom-server', request) as Promise<ConnectorsSnapshot>,
    updateCustomServer: (request: UpdateCustomServerRequest) =>
      ipcRenderer.invoke('settings:update-custom-server', request) as Promise<ConnectorsSnapshot>,
    // Fires when a connector call needs the user's approval (external data-egress gate).
    onConnectorApprovalRequest: (listener) => onIpcMessage('connectors:approval-request', listener),
    respondConnectorApproval: (request: RespondApprovalRequest) =>
      ipcRenderer.invoke('connectors:approval-respond', request) as Promise<void>,
    // Streams live installer output while a one-click install runs.
    onInstallLog: (listener) => onIpcMessage('settings:install-log', listener)
  },
  logs: {
    getPath: () => ipcRenderer.invoke('logs:get-path') as Promise<string | null>,
    openFile: () => ipcRenderer.invoke('logs:open-file') as Promise<OpenLogFileResult>,
    revealInFolder: () =>
      ipcRenderer.invoke('logs:reveal-in-folder') as Promise<RevealLogFileResult>
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
    delete: (request) => ipcRenderer.invoke('projects:delete', request) as Promise<void>
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
    repairIndex: (request) =>
      ipcRenderer.invoke('project-files:repair-index', request) as Promise<void>,
    onChanged: (listener) => onIpcMessage('project-files:changed', listener)
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
  artifacts: {
    // Keep generated file movement in the main process where filesystem trust checks live.
    finalizeRunArtifacts: (request) =>
      ipcRenderer.invoke('artifacts:finalize-run', request) as Promise<ArtifactFile[]>,
    // Lists every on-disk artifact for a project so orphaned files (owning session deleted) still show.
    listProjectFiles: (request) =>
      ipcRenderer.invoke('artifacts:list-project-files', request) as Promise<ArtifactFile[]>,
    // Re-finalizes crash-orphaned pending artifacts so the renderer can replace stale pending paths.
    reconcilePendingArtifacts: (request) =>
      ipcRenderer.invoke('artifacts:reconcile-pending', request) as Promise<ArtifactFile[]>,
    openFile: (request) => ipcRenderer.invoke('artifacts:open-file', request) as Promise<void>,
    // Keep preview reads on the same managed-file trust path as opening files.
    readPreview: (request) =>
      ipcRenderer.invoke('artifacts:read-preview', request) as Promise<ArtifactPreviewResult>
  },
  uploads: {
    // Upload IPC remains behind the preload bridge so renderer code never receives raw fs access.
    stageFiles: (request) =>
      ipcRenderer.invoke('uploads:stage-files', request) as Promise<UploadedAttachment[]>,
    deleteUpload: (request) => ipcRenderer.invoke('uploads:delete', request) as Promise<void>,
    finalizeSession: (request) =>
      ipcRenderer.invoke('uploads:finalize-session', request) as Promise<UploadedAttachment[]>,
    readPreview: (request) =>
      ipcRenderer.invoke('uploads:read-preview', request) as Promise<ArtifactPreviewResult>
  },
  notebook: {
    // Notebook commands stay behind typed IPC so renderer code never talks to local RPC directly.
    state: (request) =>
      ipcRenderer.invoke('notebook:state', request) as Promise<NotebookSessionState>,
    getReference: (request) =>
      ipcRenderer.invoke('notebook:reference', request) as Promise<NotebookSessionReference | null>,
    beginCodeCell: (request) =>
      ipcRenderer.invoke('notebook:begin-code-cell', request) as Promise<{
        sessionId: string
        cellId: string
        writeId: string
        status: string
      }>,
    appendCodeCell: (request) =>
      ipcRenderer.invoke('notebook:append-code-cell', request) as Promise<{
        sessionId: string
        cellId: string
        writeId: string
        receivedBytes: number
      }>,
    finishCodeCell: (request) =>
      ipcRenderer.invoke('notebook:finish-code-cell', request) as Promise<{
        sessionId: string
        cellId: string
        code: string
        status: string
      }>,
    runCell: (request) =>
      ipcRenderer.invoke('notebook:run-cell', request) as Promise<NotebookRunSummary>,
    execute: (request) =>
      ipcRenderer.invoke('notebook:execute', request) as Promise<NotebookRunSummary>,
    restart: (request) =>
      ipcRenderer.invoke('notebook:restart', request) as Promise<NotebookSessionState>,
    shutdown: (request) =>
      ipcRenderer.invoke('notebook:shutdown', request) as Promise<{
        sessionId: string
        status: 'shutdown'
      }>,
    onAvailable: (listener) => onIpcMessage('notebook:available', listener),
    onChanged: (listener) => onIpcMessage('notebook:changed', listener)
  },
  notebookEnv: {
    getStatus: () => ipcRenderer.invoke('notebook-env:status') as Promise<ProvisionStatus>,
    provision: (lang) => ipcRenderer.invoke('notebook-env:provision', lang) as Promise<void>,
    repair: (lang) => ipcRenderer.invoke('notebook-env:repair', lang) as Promise<void>,
    cancel: () => ipcRenderer.invoke('notebook-env:cancel') as Promise<void>,
    onProgress: (listener) => onIpcMessage('notebook-env:progress', listener)
  },
  runtime: {
    survey: () => ipcRenderer.invoke('runtime:survey') as Promise<RuntimeSurvey[]>,
    setSelection: (language, selection) =>
      ipcRenderer.invoke('runtime:set-selection', {
        language,
        selection
      }) as Promise<RuntimeSurvey>,
    pickInterpreter: () => ipcRenderer.invoke('runtime:pick-interpreter') as Promise<string | null>,
    listEnvironments: () =>
      ipcRenderer.invoke('runtime:list-environments') as Promise<{
        python: DiscoveredInterpreter[]
        r: DiscoveredInterpreter[]
      }>,
    getEnablement: (language) =>
      ipcRenderer.invoke('runtime:get-enablement', { language }) as Promise<RuntimeEnablement>,
    describeUsage: (language, envId) =>
      ipcRenderer.invoke('runtime:describe-usage', { language, envId }) as Promise<RuntimeUsage>,
    setEnvironmentEnabled: (language, envId, enabled, force) =>
      ipcRenderer.invoke('runtime:set-environment-enabled', {
        language,
        envId,
        enabled,
        force
      }) as Promise<RuntimeEnablement>,
    setInstallAuthorized: (language, envId, authorized) =>
      ipcRenderer.invoke('runtime:set-install-authorized', {
        language,
        envId,
        authorized
      }) as Promise<RuntimeEnablement>,
    registerInterpreter: (language, path) =>
      ipcRenderer.invoke('runtime:register-interpreter', { language, path }) as Promise<string[]>,
    unregisterInterpreter: (language, path) =>
      ipcRenderer.invoke('runtime:unregister-interpreter', { language, path }) as Promise<string[]>
  },
  storage: {
    getInfo: () => ipcRenderer.invoke('storage:get-info') as Promise<StorageInfo>,
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
    getForSession: (sessionId: string) =>
      ipcRenderer.invoke(REVIEWER_IPC.GET_FOR_SESSION, sessionId) as Promise<ReviewWithChecks[]>,
    onUpdated: (listener) => onIpcMessage(REVIEWER_IPC.UPDATED, listener),
    onSuppressNextAutoReview: (listener: AcpListener<{ sessionId: string; clear?: boolean }>) =>
      onIpcMessage(REVIEWER_IPC.SUPPRESS_NEXT_AUTO_REVIEW, listener),
    // Fix loop lock: fired when the loop starts (lock composer) / ends or is aborted (unlock).
    onFixLoopStart: (listener: AcpListener<{ sessionId: string }>) =>
      onIpcMessage(REVIEWER_IPC.FIX_LOOP_START, listener),
    onFixLoopEnd: (listener: AcpListener<{ sessionId: string }>) =>
      onIpcMessage(REVIEWER_IPC.FIX_LOOP_END, listener),
    // Sends an abort request to the main process to stop the running fix loop for a session.
    abortFixLoop: (sessionId: string) =>
      ipcRenderer.invoke(REVIEWER_IPC.ABORT_FIX_LOOP, sessionId) as Promise<void>
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
