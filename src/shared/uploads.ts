import { DEFAULT_ARTIFACT_PROJECT_NAME } from './artifacts'

// Uploads share the default project bucket so they live beside the matching session data.
export const DEFAULT_UPLOAD_PROJECT_NAME = DEFAULT_ARTIFACT_PROJECT_NAME
// New-conversation uploads are staged here until the runtime returns a durable session id.
export const PENDING_UPLOAD_SESSION_ID = '.pending'

// Per-file storage cap. Content sent to the model has separate, much smaller inline/read limits.
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024 * 1024
// Keeps both Electron IPC and the Web JSON/base64 fallback comfortably below their body limits.
export const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
// Composer total attachment cap; enforced renderer-side since main is stateless about composer state.
export const MAX_COMPOSER_ATTACHMENTS = 10

export const formatUploadSizeLimit = (bytes: number): string => {
  const gibibytes = bytes / (1024 * 1024 * 1024)
  if (bytes >= 1024 * 1024 * 1024) {
    return `${Number.isInteger(gibibytes) ? gibibytes : gibibytes.toFixed(1)} GB`
  }

  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`

  return `${bytes} B`
}

// Preload-only request used by the desktop fast path. The renderer supplies the File object;
// preload resolves its native path so arbitrary renderer-provided paths never cross this boundary.
export type StageLocalUploadRequest = {
  transferId: string
  sourcePath: string
  name: string
  mimeType?: string
  size: number
}

export type UploadTransferProgress = {
  transferId: string
  name: string
  receivedBytes: number
  totalBytes: number
}

export type BeginUploadTransferRequest = Omit<StageLocalUploadRequest, 'sourcePath'>

export type AppendUploadTransferRequest = {
  transferId: string
  offset: number
  chunk: Uint8Array
}

export type UploadTransferRequest = {
  transferId: string
}

export type UploadTransferStatus = UploadTransferProgress

export type UploadedAttachment = {
  id: string
  sessionId: string
  name: string
  originalName: string
  path: string
  mimeType?: string
  size: number
}

export type DeleteUploadRequest = {
  path: string
}

export type FinalizeUploadSessionRequest = {
  sessionId: string
  attachments: UploadedAttachment[]
}

// Chooses the user-facing name while tolerating older records that only have the safe filename.
export const getUploadedAttachmentName = (attachment: UploadedAttachment): string =>
  attachment.originalName || attachment.name
