// 'local' streams a file from an arbitrary absolute filesystem path (the "This computer" browser).
// Unlike artifact/upload it is not confined to a storage root; the resolver validates + realpaths it.
export type ManagedPreviewSource =
  'artifact' | 'upload' | 'compute-output' | 'notebook-input' | 'literature' | 'local'

export const MANAGED_PREVIEW_LOAD_ERROR = 'open-science-preview-load-error'
export const IMAGE_PREVIEW_BUSY_MESSAGE = 'Image preview capacity is busy.'

type ManagedPreviewPresentation = {
  mimeType?: string
  maxBytes?: number
  // Owner-authorized original bytes, served as an opaque download.
  purpose?: 'download'
  // Opt into a bounded image preview, with an optional thumbnail scale.
  imagePreview?: boolean | 'thumbnail'
}

type AcquireManagedVersionPreviewRequest = ManagedPreviewPresentation & {
  projectId: string
  fileId: string
  versionId?: string
  // Live image-tool output only; the Host must resolve an exact owned generation receipt.
  imageGenerationSessionId?: string
} & ({ source: 'artifact' } | { source: 'upload' })

type AcquirePathPreviewRequest = ManagedPreviewPresentation & {
  path: string
  projectId?: string
  sessionId?: string
} & (
    | { source: 'compute-output' }
    | { source: 'notebook-input' }
    | { source: 'literature' }
    | { source: 'local' }
    | { source: 'staged-edit' }
  )

export type AcquireManagedPreviewRequest =
  AcquireManagedVersionPreviewRequest | AcquirePathPreviewRequest

export type ManagedPreviewResource = {
  id: string
  url: string
  size: number
  mimeType: string
  version: number
  // Original name from the authorized immutable Version, when one was acquired.
  filename?: string
  // Optional SHA-256 from the main-owned immutable content lease, never a PDF.js fingerprint.
  // Transient evidence for this acquired resource; older responses may omit it.
  sourceChecksum?: string
  // Original, oriented pixel dimensions for image previews, even when downsampled.
  // Thumbnail requests report the thumbnail dimensions for renderer cache accounting.
  // Absent for non-images and for images whose header could not be parsed.
  width?: number
  height?: number
}

export type ReadManagedPreviewRangeRequest = {
  resourceId: string
  begin: number
  end: number
}

export type ManagedPreviewRangeResult = {
  begin: number
  end: number
  total: number
  data: Uint8Array
}

export type ReleaseManagedPreviewRequest = {
  resourceId: string
}
