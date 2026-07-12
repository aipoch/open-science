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
    sendPrompt: (request: AcpPromptRequest) => Promise<AcpStateSnapshot>
    cancel: (request: AcpCancelPromptRequest) => Promise<AcpStateSnapshot>
    deleteSession: (request: AcpDeleteSessionRequest) => Promise<AcpStateSnapshot>
    respondToPermission: (response: AcpPermissionResponse) => Promise<AcpStateSnapshot>
    onState: (listener: AcpListener<AcpStateSnapshot>) => RemoveListener
    onEvent: (listener: AcpListener<AcpRuntimeEvent>) => RemoveListener
    onPermissionRequest: (listener: AcpListener<AcpPermissionRequest>) => RemoveListener
  }
  sessions: {
    loadAll: () => Promise<LoadAllSessionsResult>
    saveSession: (session: PersistedChatSession) => Promise<void>
    deleteSession: (request: DeleteSessionRequest) => Promise<void>
    deleteProjectSessions: (request: DeleteProjectSessionsRequest) => Promise<void>
    saveManifest: (request: SaveSessionManifestRequest) => Promise<void>
  }
  settings: {
    getPreflight: () => Promise<Preflight>
    getSettings: () => Promise<SettingsSnapshot>
    isEncryptionAvailable: () => Promise<boolean>
    isNpmAvailable: () => Promise<boolean>
    detectClaude: () => Promise<ClaudeDetectResult>
    installClaude: (request: InstallClaudeRequest) => Promise<ClaudeInstallResult>
    upsertProvider: (request: UpsertProviderRequest) => Promise<SettingsSnapshot>
    deleteProvider: (request: DeleteProviderRequest) => Promise<SettingsSnapshot>
    setActiveProvider: (request: SetActiveProviderRequest) => Promise<SettingsSnapshot>
    validateProvider: (request: ValidateProviderRequest) => Promise<ValidateProviderResult>
    markOnboardingComplete: () => Promise<SettingsSnapshot>
    onInstallLog: (listener: AcpListener<ClaudeInstallLogEvent>) => RemoveListener
  }
  logs: {
    getPath: () => Promise<string | null>
    openFile: () => Promise<OpenLogFileResult>
  }
  projects: {
    list: () => Promise<Project[]>
    get: (id: string) => Promise<Project | null>
    create: (request: CreateProjectRequest) => Promise<Project>
    update: (request: UpdateProjectRequest) => Promise<Project>
    delete: (request: DeleteProjectRequest) => Promise<void>
  }
  preview: {
    load: (request: LoadPreviewStateRequest) => Promise<PersistedPreviewState | null>
    save: (request: SavePreviewStateRequest) => Promise<void>
    delete: (request: DeletePreviewStateRequest) => Promise<void>
  }
  artifacts: {
    // Finalizes files produced during one runtime event after the renderer has selected a message.
    finalizeRunArtifacts: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
    // Opens only managed files after the main process verifies the path.
    openFile: (request: OpenArtifactFileRequest) => Promise<void>
    // Reads a bounded text preview from managed generated files.
    readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
    // Reads a whole managed artifact as base64 bytes for viewers that need the full file.
    readBytes: (request: ReadArtifactBytesRequest) => Promise<ManagedFileBytesResult>
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
    // Reads a whole upload as base64 bytes for viewers that need the full file (e.g. PDF preview).
    readBytes: (request: ReadUploadBytesRequest) => Promise<UploadBytesResult>
  }
  notebook: {
    state: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
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
}

// Exposes the small, typed bridge surface available to renderer code.
const api: OpenScienceAPI = {
  saveBlobFile: (request) =>
    ipcRenderer.invoke('file:save-blob', request) as Promise<SaveBlobFileResult>,
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
    sendPrompt: (request) =>
      ipcRenderer.invoke('acp:send-prompt', request) as Promise<AcpStateSnapshot>,
    cancel: (request) => ipcRenderer.invoke('acp:cancel', request) as Promise<AcpStateSnapshot>,
    deleteSession: (request) =>
      ipcRenderer.invoke('acp:delete-session', request) as Promise<AcpStateSnapshot>,
    respondToPermission: (response) =>
      ipcRenderer.invoke('acp:respond-permission', response) as Promise<AcpStateSnapshot>,
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
    // Removes every session under a project (used when the project is deleted).
    deleteProjectSessions: (request) =>
      ipcRenderer.invoke('sessions:delete-project-sessions', request) as Promise<void>,
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
    detectClaude: () => ipcRenderer.invoke('settings:detect-claude') as Promise<ClaudeDetectResult>,
    installClaude: (request) =>
      ipcRenderer.invoke('settings:install-claude', request) as Promise<ClaudeInstallResult>,
    upsertProvider: (request) =>
      ipcRenderer.invoke('settings:upsert-provider', request) as Promise<SettingsSnapshot>,
    deleteProvider: (request) =>
      ipcRenderer.invoke('settings:delete-provider', request) as Promise<SettingsSnapshot>,
    setActiveProvider: (request) =>
      ipcRenderer.invoke('settings:set-active-provider', request) as Promise<SettingsSnapshot>,
    validateProvider: (request) =>
      ipcRenderer.invoke('settings:validate-provider', request) as Promise<ValidateProviderResult>,
    markOnboardingComplete: () =>
      ipcRenderer.invoke('settings:mark-onboarding-complete') as Promise<SettingsSnapshot>,
    // Streams live installer output while a one-click install runs.
    onInstallLog: (listener) => onIpcMessage('settings:install-log', listener)
  },
  logs: {
    getPath: () => ipcRenderer.invoke('logs:get-path') as Promise<string | null>,
    openFile: () => ipcRenderer.invoke('logs:open-file') as Promise<OpenLogFileResult>
  },
  projects: {
    // Project CRUD backed by the SQLite/Prisma layer (scope: projects only).
    list: () => ipcRenderer.invoke('projects:list') as Promise<Project[]>,
    get: (id) => ipcRenderer.invoke('projects:get', id) as Promise<Project | null>,
    create: (request) => ipcRenderer.invoke('projects:create', request) as Promise<Project>,
    update: (request) => ipcRenderer.invoke('projects:update', request) as Promise<Project>,
    delete: (request) => ipcRenderer.invoke('projects:delete', request) as Promise<void>
  },
  preview: {
    // Per-project preview panel state, persisted alongside projects in SQLite.
    load: (request) =>
      ipcRenderer.invoke('preview:load', request) as Promise<PersistedPreviewState | null>,
    save: (request) => ipcRenderer.invoke('preview:save', request) as Promise<void>,
    delete: (request) => ipcRenderer.invoke('preview:delete', request) as Promise<void>
  },
  artifacts: {
    // Keep generated file movement in the main process where filesystem trust checks live.
    finalizeRunArtifacts: (request) =>
      ipcRenderer.invoke('artifacts:finalize-run', request) as Promise<ArtifactFile[]>,
    openFile: (request) => ipcRenderer.invoke('artifacts:open-file', request) as Promise<void>,
    // Keep preview reads on the same managed-file trust path as opening files.
    readPreview: (request) =>
      ipcRenderer.invoke('artifacts:read-preview', request) as Promise<ArtifactPreviewResult>,
    readBytes: (request) =>
      ipcRenderer.invoke('artifacts:read-bytes', request) as Promise<ManagedFileBytesResult>
  },
  uploads: {
    // Upload IPC remains behind the preload bridge so renderer code never receives raw fs access.
    stageFiles: (request) =>
      ipcRenderer.invoke('uploads:stage-files', request) as Promise<UploadedAttachment[]>,
    deleteUpload: (request) => ipcRenderer.invoke('uploads:delete', request) as Promise<void>,
    finalizeSession: (request) =>
      ipcRenderer.invoke('uploads:finalize-session', request) as Promise<UploadedAttachment[]>,
    readPreview: (request) =>
      ipcRenderer.invoke('uploads:read-preview', request) as Promise<ArtifactPreviewResult>,
    readBytes: (request) =>
      ipcRenderer.invoke('uploads:read-bytes', request) as Promise<UploadBytesResult>
  },
  notebook: {
    // Notebook commands stay behind typed IPC so renderer code never talks to local RPC directly.
    state: (request) =>
      ipcRenderer.invoke('notebook:state', request) as Promise<NotebookSessionState>,
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
