import { DEFAULT_ARTIFACT_PROJECT_NAME } from './artifacts'

// Uploads share the default project bucket so they live beside the matching session data.
export const DEFAULT_UPLOAD_PROJECT_NAME = DEFAULT_ARTIFACT_PROJECT_NAME
// New-conversation uploads are staged here until the runtime returns a durable session id.
export const PENDING_UPLOAD_SESSION_ID = '.pending'

// Per-file 50 MB cap enforced in both the composer and the main-process staging entry.
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024
// Composer total attachment cap; enforced renderer-side since main is stateless about composer state.
export const MAX_COMPOSER_ATTACHMENTS = 10

export type StageUploadFile = {
  name: string
  content: string
  mimeType?: string
}

export type StageUploadFilesRequest = {
  files: StageUploadFile[]
}

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
