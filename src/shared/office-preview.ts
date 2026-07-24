export const OFFICE_PREVIEW_MAX_FILE_BYTES = 40 * 1024 * 1024
export const OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES = 1_536 * 1024 * 1024
export const OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS = 1_000
export const OFFICE_PREVIEW_OPEN_CHANNEL = 'office-preview:open'
export const OFFICE_PREVIEW_SET_BOUNDS_CHANNEL = 'office-preview:set-bounds'
export const OFFICE_PREVIEW_CAPTURE_SNAPSHOT_CHANNEL = 'office-preview:capture-snapshot'
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

export type OfficePreviewHorizontalLayout = {
  splitGroupX: number
  splitGroupWidth: number
  panelX: number
  panelWidth: number
}

export type OfficePreviewBounds = {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  occluded?: boolean
  sequence: number
  viewportWidth: number
  viewportHeight: number
  horizontalLayout?: OfficePreviewHorizontalLayout
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isOfficePreviewHorizontalLayout = (
  value: unknown
): value is OfficePreviewHorizontalLayout => {
  if (typeof value !== 'object' || value === null) return false

  const layout = value as Partial<OfficePreviewHorizontalLayout>
  return (
    isFiniteNumber(layout.splitGroupX) &&
    isFiniteNumber(layout.splitGroupWidth) &&
    layout.splitGroupWidth >= 0 &&
    isFiniteNumber(layout.panelX) &&
    isFiniteNumber(layout.panelWidth) &&
    layout.panelWidth >= 0
  )
}

// One-way renderer messages cross an untrusted runtime boundary and must be checked before use.
export const isOfficePreviewBounds = (value: unknown): value is OfficePreviewBounds => {
  if (typeof value !== 'object' || value === null) return false

  const bounds = value as Partial<OfficePreviewBounds>
  return (
    isFiniteNumber(bounds.x) &&
    isFiniteNumber(bounds.y) &&
    isFiniteNumber(bounds.width) &&
    bounds.width >= 0 &&
    isFiniteNumber(bounds.height) &&
    bounds.height >= 0 &&
    typeof bounds.visible === 'boolean' &&
    (bounds.occluded === undefined || typeof bounds.occluded === 'boolean') &&
    Number.isSafeInteger(bounds.sequence) &&
    (bounds.sequence ?? 0) > 0 &&
    isFiniteNumber(bounds.viewportWidth) &&
    bounds.viewportWidth > 0 &&
    isFiniteNumber(bounds.viewportHeight) &&
    bounds.viewportHeight > 0 &&
    (bounds.horizontalLayout === undefined ||
      isOfficePreviewHorizontalLayout(bounds.horizontalLayout))
  )
}
