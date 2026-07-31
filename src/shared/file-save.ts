type SaveBlobFileRequest = {
  suggestedName: string
  mimeType: string
  /** Raw file bytes from the renderer process. */
  data: ArrayBuffer
}

type SaveBlobFileResult = {
  saved: boolean
  filePath?: string
}

type SaveManagedFileRequest = {
  source: 'artifact' | 'upload' | 'notebook-input'
  path: string
  suggestedName: string
}

type SaveManagedFileResult = SaveBlobFileResult

type SaveSessionArtifactFile = {
  path: string
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

export type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult,
  SaveSessionArtifactFailure,
  SaveSessionArtifactFile,
  SaveSessionArtifactsRequest,
  SaveSessionArtifactsResult
}
