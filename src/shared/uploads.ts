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
  // Native durable uploads expose one stable file identity plus one immutable byte Version.
  // These stay optional while legacy Session JSON records are upgraded on their next finalize.
  versionId?: string
  versionNumber?: number
  sessionId: string
  name: string
  originalName: string
  path: string
  mimeType?: string
  size: number
  checksum?: string
  createdAt?: string
}

// Path-free projection stored on a Message. Native finalization always supplies the immutable
// Version fields; they remain optional in the reader type only so legacy Session JSON can be
// loaded and lazily upgraded without preserving its historical absolute path.
export type PersistedUploadedAttachment = {
  id: string
  versionId?: string
  versionNumber?: number
  createdAt?: string
  sessionId: string
  name: string
  originalName: string
  mimeType?: string
  size: number
  sha256?: string
  // Reader-only legacy fields. The Session sanitizer deliberately never emits either field, so
  // every newly written Session JSON remains path-free and uses sha256 as its checksum name.
  path?: string
  checksum?: string
}

export const toPersistedUploadedAttachment = (
  attachment: UploadedAttachment
): PersistedUploadedAttachment => ({
  id: attachment.id,
  ...(attachment.versionId ? { versionId: attachment.versionId } : {}),
  ...(attachment.versionNumber ? { versionNumber: attachment.versionNumber } : {}),
  ...(attachment.createdAt ? { createdAt: attachment.createdAt } : {}),
  sessionId: attachment.sessionId,
  name: attachment.name,
  originalName: attachment.originalName,
  ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
  size: attachment.size,
  ...(attachment.checksum ? { sha256: attachment.checksum } : {})
})

const UPLOAD_VERSION_REFERENCE_PREFIX = 'upload-version:'

export type UploadVersionReference = {
  versionId: string
  projectId?: string
  sessionId?: string
}

export const createUploadVersionReference = (
  versionId: string,
  scope?: { projectId: string; sessionId: string }
): string =>
  scope
    ? `${UPLOAD_VERSION_REFERENCE_PREFIX}${encodeURIComponent(scope.projectId)}/${encodeURIComponent(scope.sessionId)}/${encodeURIComponent(versionId)}`
    : `${UPLOAD_VERSION_REFERENCE_PREFIX}${versionId}`

export const parseUploadVersionReference = (value: string): UploadVersionReference | undefined => {
  if (!value.startsWith(UPLOAD_VERSION_REFERENCE_PREFIX)) return undefined
  const body = value.slice(UPLOAD_VERSION_REFERENCE_PREFIX.length)
  if (!body) return undefined
  const segments = body.split('/')
  if (segments.length === 1) return { versionId: segments[0] }
  if (segments.length !== 3 || segments.some((segment) => !segment)) return undefined
  try {
    return {
      projectId: decodeURIComponent(segments[0]),
      sessionId: decodeURIComponent(segments[1]),
      versionId: decodeURIComponent(segments[2])
    }
  } catch {
    return undefined
  }
}

export const getUploadedAttachmentPath = (
  attachment: Pick<PersistedUploadedAttachment, 'path' | 'versionId' | 'sessionId'>,
  projectId?: string
): string => {
  if (attachment.versionId) {
    return createUploadVersionReference(
      attachment.versionId,
      projectId ? { projectId, sessionId: attachment.sessionId } : undefined
    )
  }
  if (attachment.path) return attachment.path
  throw new Error('Upload attachment has no immutable Version identity or legacy path.')
}

export const toRuntimeUploadedAttachment = (
  attachment: PersistedUploadedAttachment,
  projectId?: string
): UploadedAttachment => ({
  id: attachment.id,
  ...(attachment.versionId ? { versionId: attachment.versionId } : {}),
  ...(attachment.versionNumber ? { versionNumber: attachment.versionNumber } : {}),
  ...(attachment.createdAt ? { createdAt: attachment.createdAt } : {}),
  sessionId: attachment.sessionId,
  name: attachment.name,
  originalName: attachment.originalName,
  path: getUploadedAttachmentPath(attachment, projectId),
  ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
  size: attachment.size,
  ...(attachment.sha256 || attachment.checksum
    ? { checksum: attachment.sha256 ?? attachment.checksum }
    : {})
})

export type DeleteUploadRequest = {
  path: string
}

export type FinalizeUploadSessionRequest = {
  projectId?: string
  sessionId: string
  attachments: UploadedAttachment[]
}

// Chooses the user-facing name while tolerating older records that only have the safe filename.
export const getUploadedAttachmentName = (
  attachment: Pick<UploadedAttachment, 'originalName' | 'name'>
): string => attachment.originalName || attachment.name
