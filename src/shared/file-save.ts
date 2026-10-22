type SaveBlobFileRequest = {
  suggestedName: string
  mimeType: string
  /** Raw file bytes from the renderer process. */
  data: ArrayBuffer
}

const WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME = 'WebManagedFileSizeLimitError'

type SaveBlobFileResult = {
  saved: boolean
  filePath?: string
}

type SaveManagedVersionFileRequest = {
  source: 'artifact' | 'upload'
  projectId: string
  fileId: string
  versionId?: string
  suggestedName: string
}

type SavePathFileRequest = {
  source: 'notebook-input' | 'literature' | 'local'
  path: string
  suggestedName: string
}

type SaveManagedFileRequest = SaveManagedVersionFileRequest | SavePathFileRequest

type SaveManagedFileResult = SaveBlobFileResult

type SaveSessionArtifactFile = {
  fileId: string
  versionId: string
  suggestedName: string
}

type ArtifactSaveOperationRequest = { operationId: string }

type ArtifactSaveProgress = {
  phase: 'preparing' | 'running' | 'cancelling'
  completedFiles: number
  totalFiles: number
}

type SaveSessionArtifactsRequest = {
  operationId?: string
  projectId: string
  sessionId: string
  files: SaveSessionArtifactFile[]
}

type SaveSessionArtifactFailure = SaveSessionArtifactFile & {
  message: string
}

type SaveSessionArtifactsResult =
  | { saved: false; cancelled?: true }
  | {
      saved: true
      filePaths: string[]
      failures?: SaveSessionArtifactFailure[]
      cancelled?: true
      completedFileIds?: string[]
    }

type SaveProjectArtifactFile = {
  source: 'artifact' | 'upload'
  sessionId: string
  fileId: string
  versionId: string
  suggestedName: string
}

type SaveProjectArtifactsRequest = {
  operationId?: string
  projectId: string
  // Presentation-only filename seed prepared by the renderer. Project identity stays with projectId.
  suggestedArchiveName: string
  files: SaveProjectArtifactFile[]
}

type SaveProjectArtifactFailure = SaveProjectArtifactFile & {
  message: string
}

// filePath is absent when every file fails after Save As confirmation: no archive is written.
type SaveProjectArtifactsResult =
  | { saved: false; cancelled?: true }
  | { saved: true; filePath?: string; failures?: SaveProjectArtifactFailure[] }

export { WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME }
export type {
  ArtifactSaveOperationRequest,
  ArtifactSaveProgress,
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveProjectArtifactFailure,
  SaveProjectArtifactFile,
  SaveProjectArtifactsRequest,
  SaveProjectArtifactsResult,
  SaveSessionArtifactFailure,
  SaveSessionArtifactFile,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
}
