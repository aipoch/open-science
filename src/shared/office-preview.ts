export const OFFICE_PREVIEW_MAX_FILE_BYTES = 40 * 1024 * 1024
export const OFFICE_PREVIEW_PROCESS_MEMORY_LIMIT_BYTES = 1_536 * 1024 * 1024
export const OFFICE_PREVIEW_PROCESS_MEMORY_POLL_MS = 1_000
export const OFFICE_PREVIEW_OPEN_CHANNEL = 'office-preview:open'
export const OFFICE_PREVIEW_ATTACH_FRAME_CHANNEL = 'office-preview:attach-frame'
export const OFFICE_PREVIEW_REPORT_STATE_CHANNEL = 'office-preview:report-state'
export const OFFICE_PREVIEW_CLOSE_CHANNEL = 'office-preview:close'
export const OFFICE_PREVIEW_STATE_CHANNEL = 'office-preview:state'
export const OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL = 'open-science-office-preview'
export const OFFICE_PREVIEW_FRAME_MESSAGE_VERSION = 1
export const OFFICE_PREVIEW_RUNTIME_SCHEME = 'open-science-office-preview'
export const OFFICE_PREVIEW_RUNTIME_HOST = 'runtime'
export const OFFICE_PREVIEW_RUNTIME_ORIGIN = `${OFFICE_PREVIEW_RUNTIME_SCHEME}://${OFFICE_PREVIEW_RUNTIME_HOST}`

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
  | 'PREVIEW_PROCESS_NOT_ISOLATED'
  | 'RENDER_FAILED'

export type OfficePreviewOpenResult =
  | { kind: 'started'; sessionId: string; runtimeUrl: string; size: number; limit: number }
  | { kind: 'cancelled' }
  | {
      kind: 'unavailable'
      reason: OfficePreviewErrorCode
      size?: number
      limit?: number
    }

export type OfficePreviewAttachResult =
  | { kind: 'attached'; start: OfficePreviewRuntimeStart }
  | { kind: 'unavailable'; reason: 'PREVIEW_PROCESS_NOT_ISOLATED' }

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

export type OfficePreviewHostMessage = {
  channel: typeof OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL
  version: typeof OFFICE_PREVIEW_FRAME_MESSAGE_VERSION
  type: 'start'
  sessionId: string
  start: OfficePreviewRuntimeStart
}

export type OfficePreviewRuntimeMessage =
  | {
      channel: typeof OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL
      version: typeof OFFICE_PREVIEW_FRAME_MESSAGE_VERSION
      type: 'ready'
      sessionId: string
    }
  | {
      channel: typeof OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL
      version: typeof OFFICE_PREVIEW_FRAME_MESSAGE_VERSION
      type: 'state'
      sessionId: string
      state: OfficePreviewRuntimeState
    }

const OFFICE_PREVIEW_PHASES = new Set<OfficePreviewPhase>([
  'starting',
  'reading',
  'validating',
  'parsing',
  'rendering',
  'ready',
  'error'
])

const OFFICE_PREVIEW_ERRORS = new Set<OfficePreviewErrorCode>([
  'FILE_TOO_LARGE',
  'UNSUPPORTED_FORMAT',
  'INVALID_PACKAGE',
  'RESOURCE_LIMIT_EXCEEDED',
  'FILE_READ_FAILED',
  'PREVIEW_TIMEOUT',
  'PREVIEW_PROCESS_CRASHED',
  'PREVIEW_PROCESS_NOT_ISOLATED',
  'RENDER_FAILED'
])

const OFFICE_PREVIEW_EXTENSIONS = new Set<OfficePreviewRequestedExtension>([
  'docx',
  'xls',
  'xlsx',
  'pptx',
  'spreadsheet'
])

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

export const isOfficePreviewRuntimeState = (value: unknown): value is OfficePreviewRuntimeState => {
  if (typeof value !== 'object' || value === null) return false

  const state = value as Partial<OfficePreviewRuntimeState>
  return (
    isNonEmptyString(state.sessionId) &&
    typeof state.phase === 'string' &&
    OFFICE_PREVIEW_PHASES.has(state.phase as OfficePreviewPhase) &&
    (state.requestId === undefined || typeof state.requestId === 'string') &&
    (state.title === undefined || typeof state.title === 'string') &&
    (state.description === undefined || typeof state.description === 'string') &&
    (state.error === undefined ||
      (typeof state.error === 'string' &&
        OFFICE_PREVIEW_ERRORS.has(state.error as OfficePreviewErrorCode)))
  )
}

const isOfficePreviewRuntimeStart = (value: unknown): value is OfficePreviewRuntimeStart => {
  if (typeof value !== 'object' || value === null) return false

  const start = value as Partial<OfficePreviewRuntimeStart>
  const resource = start.resource as Partial<OfficePreviewRuntimeResource> | undefined
  return (
    isNonEmptyString(start.sessionId) &&
    typeof start.extension === 'string' &&
    OFFICE_PREVIEW_EXTENSIONS.has(start.extension as OfficePreviewRequestedExtension) &&
    isNonEmptyString(start.name) &&
    Number.isSafeInteger(start.attempt) &&
    (start.attempt ?? -1) >= 0 &&
    typeof resource === 'object' &&
    resource !== null &&
    isNonEmptyString(resource.id) &&
    isNonEmptyString(resource.url) &&
    Number.isFinite(resource.size) &&
    (resource.size ?? -1) >= 0 &&
    isNonEmptyString(resource.mimeType) &&
    Number.isFinite(resource.version)
  )
}

// Both frame directions are untrusted structured-clone inputs, so validate before routing them.
export const isOfficePreviewHostMessage = (value: unknown): value is OfficePreviewHostMessage => {
  if (typeof value !== 'object' || value === null) return false

  const message = value as Partial<OfficePreviewHostMessage>
  return (
    message.channel === OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL &&
    message.version === OFFICE_PREVIEW_FRAME_MESSAGE_VERSION &&
    message.type === 'start' &&
    isNonEmptyString(message.sessionId) &&
    isOfficePreviewRuntimeStart(message.start) &&
    message.start.sessionId === message.sessionId
  )
}

export const isOfficePreviewRuntimeMessage = (
  value: unknown
): value is OfficePreviewRuntimeMessage => {
  if (typeof value !== 'object' || value === null) return false

  const message = value as Partial<OfficePreviewRuntimeMessage>
  if (
    message.channel !== OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL ||
    message.version !== OFFICE_PREVIEW_FRAME_MESSAGE_VERSION ||
    !isNonEmptyString(message.sessionId)
  ) {
    return false
  }
  if (message.type === 'ready') return true
  if (message.type !== 'state' || !('state' in message)) return false
  return isOfficePreviewRuntimeState(message.state) && message.state.sessionId === message.sessionId
}
