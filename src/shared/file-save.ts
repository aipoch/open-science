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

export type { SaveBlobFileRequest, SaveBlobFileResult }
