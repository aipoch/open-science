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
  source: 'notebook-input' | 'local'
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

type SaveSessionArtifactsRequest = {
  projectId: string
  sessionId: string
  files: SaveSessionArtifactFile[]
}

type SaveSessionArtifactFailure = SaveSessionArtifactFile & {
  message: string
}

type SaveSessionArtifactsResult =
  { saved: false } | { saved: true; filePaths: string[]; failures?: SaveSessionArtifactFailure[] }

type SaveProjectArtifactFile = {
  source: 'artifact' | 'upload'
  sessionId: string
  fileId: string
  versionId: string
  suggestedName: string
}

type SaveProjectArtifactsRequest = {
  projectId: string
  // Presentation-only filename seed prepared by the renderer. Project identity stays with projectId.
  suggestedArchiveName: string
  files: SaveProjectArtifactFile[]
}

type SaveProjectArtifactFailure = SaveProjectArtifactFile & {
  message: string
}

// filePath is absent when every file failed to resolve: no dialog is shown and nothing is written.
type SaveProjectArtifactsResult =
  { saved: false } | { saved: true; filePath?: string; failures?: SaveProjectArtifactFailure[] }

export { WEB_MANAGED_FILE_SIZE_LIMIT_ERROR_NAME }
export type {
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
