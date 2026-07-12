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
  AcpStateSnapshot
} from '../shared/acp'
import type {
  ArtifactFile,
  ArtifactPreviewResult,
  FinalizeRunArtifactsRequest,
  ManagedFileBytesResult,
  OpenArtifactFileRequest,
  ReadArtifactBytesRequest,
  ReadArtifactPreviewRequest
} from '../shared/artifacts'
import type { SaveBlobFileRequest, SaveBlobFileResult } from '../shared/file-save'
import type { OpenLogFileResult } from '../shared/logs'
import type {
  AppendNotebookCodeCellRequest,
  BeginNotebookCodeCellRequest,
  NotebookAvailableEvent,
  NotebookChangedEvent,
  ExecuteNotebookCodeRequest,
  FinishNotebookCodeCellRequest,
  NotebookRunSummary,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionState,
  RunNotebookCellRequest
} from '../shared/notebook'
import type {
  DeletePreviewStateRequest,
  LoadPreviewStateRequest,
  PersistedPreviewState,
  SavePreviewStateRequest
} from '../shared/preview-state'
import type {
  CreateProjectRequest,
  DeleteProjectRequest,
  Project,
  UpdateProjectRequest
} from '../shared/projects'
import type {
  DeleteProjectSessionsRequest,
  DeleteSessionRequest,
  LoadAllSessionsResult,
  PersistedChatSession,
  SaveSessionManifestRequest
} from '../shared/session-persistence'
import type {
  ClaudeDetectResult,
  ClaudeInstallLogEvent,
  ClaudeInstallResult,
  DeleteProviderRequest,
  InstallClaudeRequest,
  Preflight,
  SetActiveProviderRequest,
  SettingsSnapshot,
  UpsertProviderRequest,
  ValidateProviderRequest,
  ValidateProviderResult
} from '../shared/settings'
import type {
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  ReadUploadBytesRequest,
  StageUploadFilesRequest,
  UploadBytesResult,
  UploadedAttachment
} from '../shared/uploads'

type RemoveListener = () => void
type AcpListener<Payload> = (payload: Payload) => void

interface OpenScienceAPI {
  saveBlobFile(request: SaveBlobFileRequest): Promise<SaveBlobFileResult>
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
    sendPrompt(request: AcpPromptRequest): Promise<AcpStateSnapshot>
    cancel(request: AcpCancelPromptRequest): Promise<AcpStateSnapshot>
    deleteSession(request: AcpDeleteSessionRequest): Promise<AcpStateSnapshot>
    respondToPermission(response: AcpPermissionResponse): Promise<AcpStateSnapshot>
    onState(listener: AcpListener<AcpStateSnapshot>): RemoveListener
    onEvent(listener: AcpListener<AcpRuntimeEvent>): RemoveListener
    onPermissionRequest(listener: AcpListener<AcpPermissionRequest>): RemoveListener
  }
  sessions: {
    loadAll(): Promise<LoadAllSessionsResult>
    saveSession(session: PersistedChatSession): Promise<void>
    deleteSession(request: DeleteSessionRequest): Promise<void>
    deleteProjectSessions(request: DeleteProjectSessionsRequest): Promise<void>
    saveManifest(request: SaveSessionManifestRequest): Promise<void>
  }
  settings: {
    getPreflight(): Promise<Preflight>
    getSettings(): Promise<SettingsSnapshot>
    isEncryptionAvailable(): Promise<boolean>
    isNpmAvailable(): Promise<boolean>
    detectClaude(): Promise<ClaudeDetectResult>
    installClaude(request: InstallClaudeRequest): Promise<ClaudeInstallResult>
    upsertProvider(request: UpsertProviderRequest): Promise<SettingsSnapshot>
    deleteProvider(request: DeleteProviderRequest): Promise<SettingsSnapshot>
    setActiveProvider(request: SetActiveProviderRequest): Promise<SettingsSnapshot>
    validateProvider(request: ValidateProviderRequest): Promise<ValidateProviderResult>
    markOnboardingComplete(): Promise<SettingsSnapshot>
    onInstallLog(listener: AcpListener<ClaudeInstallLogEvent>): RemoveListener
  }
  logs: {
    getPath(): Promise<string | null>
    openFile(): Promise<OpenLogFileResult>
  }
  projects: {
    list(): Promise<Project[]>
    get(id: string): Promise<Project | null>
    create(request: CreateProjectRequest): Promise<Project>
    update(request: UpdateProjectRequest): Promise<Project>
    delete(request: DeleteProjectRequest): Promise<void>
  }
  preview: {
    load(request: LoadPreviewStateRequest): Promise<PersistedPreviewState | null>
    save(request: SavePreviewStateRequest): Promise<void>
    delete(request: DeletePreviewStateRequest): Promise<void>
  }
  artifacts: {
    finalizeRunArtifacts(request: FinalizeRunArtifactsRequest): Promise<ArtifactFile[]>
    openFile(request: OpenArtifactFileRequest): Promise<void>
    readPreview(request: ReadArtifactPreviewRequest): Promise<ArtifactPreviewResult>
    readBytes(request: ReadArtifactBytesRequest): Promise<ManagedFileBytesResult>
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
    // Reads a whole upload as base64 bytes for viewers that need the full file (e.g. PDF preview).
    readBytes(request: ReadUploadBytesRequest): Promise<UploadBytesResult>
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
    restart(request: NotebookSessionRequest): Promise<NotebookSessionState>
    shutdown(request: NotebookSessionRequest): Promise<{ sessionId: string; status: 'shutdown' }>
    onAvailable(listener: AcpListener<NotebookAvailableEvent>): RemoveListener
    onChanged(listener: AcpListener<NotebookChangedEvent>): RemoveListener
  }
}

declare global {
  interface Window {
    api: OpenScienceAPI
  }
}

export {}
