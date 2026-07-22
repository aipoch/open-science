export const OFFICE_PREVIEW_MAX_FILE_BYTES = 40 * 1024 * 1024
export const OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES = 1_536 * 1024 * 1024
export const OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS = 1_000
export const OFFICE_PREVIEW_OPEN_CHANNEL = 'office-preview:open'
export const OFFICE_PREVIEW_SET_BOUNDS_CHANNEL = 'office-preview:set-bounds'
export const OFFICE_PREVIEW_CLOSE_CHANNEL = 'office-preview:close'
export const OFFICE_PREVIEW_STATE_CHANNEL = 'office-preview:state'
export const OFFICE_PREVIEW_RUNTIME_START_CHANNEL = 'office-preview-runtime:start'
export const OFFICE_PREVIEW_RUNTIME_STATE_CHANNEL = 'office-preview-runtime:state'

const LARGE_OFFICE_PREVIEW_BYTES = 20 * 1024 * 1024
const OFFICE_PREVIEW_TIMEOUT_MS = 30_000
const LARGE_OFFICE_PREVIEW_TIMEOUT_MS = 120_000
const MAX_OFFICE_PREVIEW_TIMEOUT_MS = 300_000

// Retries receive one fixed doubled allowance; repeated attempts never compound the deadline.
export const getOfficePreviewTimeoutMs = (size: number, attempt: number): number => {
  const defaultTimeout =
    size > LARGE_OFFICE_PREVIEW_BYTES ? LARGE_OFFICE_PREVIEW_TIMEOUT_MS : OFFICE_PREVIEW_TIMEOUT_MS
  return attempt > 0 ? Math.min(defaultTimeout * 2, MAX_OFFICE_PREVIEW_TIMEOUT_MS) : defaultTimeout
}

export type OfficePreviewExtension = 'docx' | 'xls' | 'xlsx' | 'pptx'
export type OfficePreviewRequestedExtension = OfficePreviewExtension | 'spreadsheet'
export type OfficePreviewSource = 'artifact' | 'upload'

export type OfficePreviewOpenRequest = {
  requestId: string
  source: OfficePreviewSource
  path: string
  name: string
  extension: OfficePreviewRequestedExtension
  attempt: number
}

export type OfficePreviewErrorCode =
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_PACKAGE'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'FILE_READ_FAILED'
  | 'PREVIEW_TIMEOUT'
  | 'PREVIEW_PROCESS_CRASHED'
  | 'RENDER_FAILED'

export type OfficePreviewOpenResult =
  | { kind: 'started'; sessionId: string; size: number; limit: number }
  | { kind: 'cancelled' }
  | {
      kind: 'unavailable'
      reason: OfficePreviewErrorCode
      size?: number
      limit?: number
    }

export type OfficePreviewResourceSnapshot = {
  size: number
  version: number
}

export type OfficePreviewAdmissionError = Error & {
  code: 'FILE_TOO_LARGE'
  size: number
  limit: number
}

export type OfficePreviewRuntimeResource = {
  id: string
  url: string
  size: number
  mimeType: string
  version: number
}

export type OfficePreviewRuntimeStart = {
  sessionId: string
  resource: OfficePreviewRuntimeResource
  extension: OfficePreviewRequestedExtension
  name: string
  attempt: number
}

export type OfficePreviewPhase =
  'starting' | 'reading' | 'validating' | 'parsing' | 'rendering' | 'ready' | 'error'

export type OfficePreviewRuntimeState = {
  sessionId: string
  requestId?: string
  phase: OfficePreviewPhase
  title?: string
  description?: string
  error?: OfficePreviewErrorCode
}

export type OfficePreviewBounds = {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}
