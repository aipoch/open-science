import { DEFAULT_ARTIFACT_PROJECT_NAME } from './artifacts'

// Uploads share the default project bucket so they live beside the matching session data.
export const DEFAULT_UPLOAD_PROJECT_NAME = DEFAULT_ARTIFACT_PROJECT_NAME
// New-conversation uploads are staged here until the runtime returns a durable session id.
export const PENDING_UPLOAD_SESSION_ID = '.pending'

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

export type ReadUploadBytesRequest = {
  path: string
}

// Full-file bytes for a managed upload, base64-encoded so it survives IPC structured cloning.
export type UploadBytesResult = {
  data: string
  size: number
}

export type FinalizeUploadSessionRequest = {
  sessionId: string
  attachments: UploadedAttachment[]
}

// Chooses the user-facing name while tolerating older records that only have the safe filename.
export const getUploadedAttachmentName = (attachment: UploadedAttachment): string =>
  attachment.originalName || attachment.name
