import { z } from 'zod'

import { defineApplicationCommandContract, validationCodec } from './application-command-contract'
import { DEFAULT_ARTIFACT_PROJECT_ID } from './artifacts'

// Uploads share the default project bucket so they live beside the matching session data.
export const DEFAULT_UPLOAD_PROJECT_ID = DEFAULT_ARTIFACT_PROJECT_ID
// New-conversation uploads are staged here until the runtime returns a durable session id.
export const PENDING_UPLOAD_SESSION_ID = '.pending'
// Local-file "Save as artifact" uploads without an associated conversation session.
export const STANDALONE_UPLOAD_SESSION_ID = 'standalone-uploads'

// Per-file storage cap. Content sent to the model has separate, much smaller inline/read limits.
export const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024 * 1024
// Keeps both Electron IPC and the Web JSON/base64 fallback comfortably below their body limits.
export const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
// Shared composer/finalization cap, enforced in both Renderer intake and the main command contract.
export const MAX_COMPOSER_ATTACHMENTS = 10

const GENERIC_UPLOAD_MIME_TYPES = new Set(['application/octet-stream', 'binary/octet-stream'])
const RASTER_IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif']
])

// Shared by renderer replay selection and main-process prompt materialization so generic or missing
// MIME metadata cannot make the two layers disagree about whether an upload is a supported image.
export const imageAttachmentMimeType = (name: string, mimeType?: string): string | undefined => {
  const essence = mimeType?.split(';', 1)[0]?.trim().toLowerCase()

  if (essence?.startsWith('image/')) {
    return essence === 'image/svg+xml' ? undefined : essence
  }
  if (essence && !GENERIC_UPLOAD_MIME_TYPES.has(essence)) return undefined

  const dot = name.lastIndexOf('.')
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return RASTER_IMAGE_MIME_BY_EXTENSION.get(extension)
}

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

// Save-as-artifact from the local-file preview: the renderer already knows the native path, and
// main stats the file itself so neither a stale renderer-side size nor a guessed mime type can
// reach the staging pipeline. The renderer passes its active project id so the upload lands in the
// correct project bucket; falls back to DEFAULT_UPLOAD_PROJECT_ID when absent.
export type StageLocalPathUploadRequest = Omit<StageLocalUploadRequest, 'size' | 'mimeType'> & {
  projectId?: string
}

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

const uploadedAttachmentSchema = z
  .object({
    id: z.string(),
    versionId: z.string().optional(),
    versionNumber: z.number().int().positive().optional(),
    sessionId: z.string(),
    name: z.string(),
    originalName: z.string(),
    path: z.string(),
    mimeType: z.string().optional(),
    size: z.number().finite().nonnegative(),
    checksum: z.string().optional(),
    createdAt: z.string().optional()
  })
  .strict() satisfies z.ZodType<UploadedAttachment>

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
  fileId?: string
}

export const createUploadVersionReference = (
  versionId: string,
  scope?: { projectId: string; sessionId: string; fileId?: string }
): string =>
  scope
    ? `${UPLOAD_VERSION_REFERENCE_PREFIX}${encodeURIComponent(scope.projectId)}/${encodeURIComponent(scope.sessionId)}/${scope.fileId ? `${encodeURIComponent(scope.fileId)}/` : ''}${encodeURIComponent(versionId)}`
    : `${UPLOAD_VERSION_REFERENCE_PREFIX}${versionId}`

export const parseUploadVersionReference = (value: string): UploadVersionReference | undefined => {
  if (!value.startsWith(UPLOAD_VERSION_REFERENCE_PREFIX)) return undefined
  const body = value.slice(UPLOAD_VERSION_REFERENCE_PREFIX.length)
  if (!body) return undefined
  const segments = body.split('/')
  if (segments.length === 1) return { versionId: segments[0] }
  if ((segments.length !== 3 && segments.length !== 4) || segments.some((segment) => !segment)) {
    return undefined
  }
  try {
    return {
      projectId: decodeURIComponent(segments[0]),
      sessionId: decodeURIComponent(segments[1]),
      ...(segments.length === 4 ? { fileId: decodeURIComponent(segments[2]) } : {}),
      versionId: decodeURIComponent(segments.at(-1)!)
    }
  } catch {
    return undefined
  }
}

export const getUploadedAttachmentPath = (
  attachment: Pick<PersistedUploadedAttachment, 'id' | 'path' | 'versionId' | 'sessionId'>,
  projectId?: string
): string => {
  if (attachment.versionId) {
    return createUploadVersionReference(
      attachment.versionId,
      projectId ? { projectId, sessionId: attachment.sessionId, fileId: attachment.id } : undefined
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

const finalizeUploadAttachmentsSchema = z
  .array(uploadedAttachmentSchema)
  .max(MAX_COMPOSER_ATTACHMENTS)
  .refine(
    (attachments) => new Set(attachments.map(({ id }) => id)).size === attachments.length,
    'Upload attachment ids must be unique.'
  )
  .refine(
    (attachments) => new Set(attachments.map(({ path }) => path)).size === attachments.length,
    'Upload attachment paths must be unique.'
  )

const finalizeUploadSessionRequestSchema = z
  .object({
    projectId: z.string().optional(),
    sessionId: z.string(),
    attachments: finalizeUploadAttachmentsSchema
  })
  .strict() satisfies z.ZodType<FinalizeUploadSessionRequest>

export const uploadApplicationCommandContracts = Object.freeze({
  finalizeSession: defineApplicationCommandContract(
    validationCodec(z.tuple([finalizeUploadSessionRequestSchema])),
    validationCodec(finalizeUploadAttachmentsSchema)
  )
})

// Chooses the user-facing name while tolerating older records that only have the safe filename.
export const getUploadedAttachmentName = (
  attachment: Pick<UploadedAttachment, 'originalName' | 'name'>
): string => attachment.originalName || attachment.name
