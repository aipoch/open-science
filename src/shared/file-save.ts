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
  source: 'artifact' | 'upload'
  path: string
  suggestedName: string
}

type SaveManagedFileResult = SaveBlobFileResult

export type {
  SaveBlobFileRequest,
  SaveBlobFileResult,
  SaveManagedFileRequest,
  SaveManagedFileResult
}
