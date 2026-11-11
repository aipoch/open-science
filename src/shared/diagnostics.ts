export const RENDERER_FAILURE_CHANNEL = 'diagnostics:renderer-failure'

export const RENDERER_FAILURE_SOURCES = [
  'window-error',
  'unhandled-rejection',
  'handled-error'
] as const
export type RendererFailureSource = (typeof RENDERER_FAILURE_SOURCES)[number]

export const RENDERER_FAILURE_CONTEXTS = [
  'settings-load',
  'settings-capability',
  'network-check',
  'session-load',
  'session-serialize',
  'session-serialize-create',
  'session-serialize-messages',
  'session-serialize-messages-active-frame',
  'session-serialize-messages-active-branch',
  'session-serialize-messages-off-branch',
  'session-serialize-messages-invalid-graph',
  'session-serialize-activities',
  'session-save',
  'session-apply-durable',
  'session-manifest-save',
  'artifact-reconcile',
  'session-persistence-unknown'
] as const
export type RendererFailureContext = (typeof RENDERER_FAILURE_CONTEXTS)[number]

export const RENDERER_FAILURE_SURFACES = [
  'home',
  'library',
  'marketplace',
  'workspace',
  'settings',
  'onboarding',
  'unknown'
] as const
export type RendererFailureSurface = (typeof RENDERER_FAILURE_SURFACES)[number]

export const RENDERER_ERROR_CATEGORIES = [
  'error',
  'type',
  'reference',
  'range',
  'syntax',
  'unknown'
] as const
export type RendererErrorCategory = (typeof RENDERER_ERROR_CATEGORIES)[number]

export const SESSION_WRITE_FAILURE_CODES = [
  'desktop-runtime-not-submitted',
  'desktop-runtime-disconnected',
  'session-size-limit',
  'session-revision-conflict',
  'session-save-unconfirmed',
  'command-failed',
  'invalid-command-result',
  'invalid-command-arguments',
  'command-unavailable',
  'unknown'
] as const

export const SESSION_WRITE_RECOVERY_EVENTS = [
  'retained',
  'reconcile-started',
  'reconcile-unconfirmed',
  'reconcile-stale',
  'resolved',
  'retry-started',
  'retry-skipped',
  'retry-failed',
  'discard-started',
  'discard-failed',
  'notice-changed',
  'warning-dismissed',
  'forgotten'
] as const

export const SESSION_WRITE_RECOVERY_REASONS = [
  'save-acknowledged',
  'authority-confirmed',
  'intent-mismatch',
  'session-missing',
  'manifest-mismatch',
  'read-failed',
  'runtime-changed',
  'write-replaced',
  'explicit-discard',
  'authoritative-deletion',
  'missing-command-receipts'
] as const

export type RendererSessionWriteRecoveryDiagnostics = Readonly<{
  event: (typeof SESSION_WRITE_RECOVERY_EVENTS)[number]
  reason?: (typeof SESSION_WRITE_RECOVERY_REASONS)[number]
  state?: 'checking' | 'failed'
  notice?: 'checking' | 'attention' | 'size-limit' | 'hidden'
  reviewRequired?: boolean
  attempt?: number
  elapsedMs?: number
  expectedRevision?: number
  actualRevision?: number
  commandCount?: number
  runtimePhase?: 'connected' | 'disconnected' | 'reconnecting' | 'reconciling' | 'unavailable'
}>

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isRendererSessionWriteRecoveryDiagnostics = (
  value: unknown
): value is RendererSessionWriteRecoveryDiagnostics => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).every((key) =>
      [
        'event',
        'reason',
        'state',
        'notice',
        'reviewRequired',
        'attempt',
        'elapsedMs',
        'expectedRevision',
        'actualRevision',
        'commandCount',
        'runtimePhase'
      ].includes(key)
    ) &&
    isOneOf(SESSION_WRITE_RECOVERY_EVENTS, record.event) &&
    (record.reason === undefined || isOneOf(SESSION_WRITE_RECOVERY_REASONS, record.reason)) &&
    (record.state === undefined || isOneOf(['checking', 'failed'], record.state)) &&
    (record.notice === undefined ||
      isOneOf(['checking', 'attention', 'size-limit', 'hidden'], record.notice)) &&
    (record.reviewRequired === undefined || typeof record.reviewRequired === 'boolean') &&
    ['attempt', 'elapsedMs', 'expectedRevision', 'actualRevision', 'commandCount'].every(
      (key) => record[key] === undefined || isNonNegativeInteger(record[key])
    ) &&
    (record.runtimePhase === undefined ||
      isOneOf(
        ['connected', 'disconnected', 'reconnecting', 'reconciling', 'unavailable'],
        record.runtimePhase
      ))
  )
}

export type RendererSessionWriteDiagnostics = Readonly<{
  target: 'session' | 'manifest'
  sessionId?: string
  projectId?: string
  code: (typeof SESSION_WRITE_FAILURE_CODES)[number]
  epoch: number
  phase: 'before-submit' | 'result-unknown' | 'rejected'
  recovery?: RendererSessionWriteRecoveryDiagnostics
}>

export const isRendererSessionWriteDiagnostics = (
  value: unknown
): value is RendererSessionWriteDiagnostics => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) =>
        !['target', 'sessionId', 'projectId', 'code', 'epoch', 'phase', 'recovery'].includes(key)
    )
  )
    return false
  const identifier = (id: unknown): boolean =>
    id === undefined || (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id))
  return (
    (record.target === 'session' || record.target === 'manifest') &&
    identifier(record.sessionId) &&
    identifier(record.projectId) &&
    (record.target === 'session' ||
      (record.sessionId === undefined && record.projectId === undefined)) &&
    isOneOf(SESSION_WRITE_FAILURE_CODES, record.code) &&
    isNonNegativeInteger(record.epoch) &&
    isOneOf(['before-submit', 'result-unknown', 'rejected'], record.phase) &&
    (record.recovery === undefined || isRendererSessionWriteRecoveryDiagnostics(record.recovery))
  )
}

export type RendererFailureReport = {
  source: RendererFailureSource
  surface: RendererFailureSurface
  errorCategory: RendererErrorCategory
  context?: RendererFailureContext
  fingerprint?: string
  sessionWrite?: RendererSessionWriteDiagnostics
}

const isOneOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === 'string' && values.includes(value as Value)

export const isRendererFailureReport = (value: unknown): value is RendererFailureReport => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    keys.some(
      (key) =>
        !['source', 'surface', 'errorCategory', 'context', 'fingerprint', 'sessionWrite'].includes(
          key
        )
    )
  ) {
    return false
  }
  if (!keys.includes('source') || !keys.includes('surface') || !keys.includes('errorCategory')) {
    return false
  }

  return (
    isOneOf(RENDERER_FAILURE_SOURCES, record.source) &&
    isOneOf(RENDERER_FAILURE_SURFACES, record.surface) &&
    isOneOf(RENDERER_ERROR_CATEGORIES, record.errorCategory) &&
    (record.context === undefined || isOneOf(RENDERER_FAILURE_CONTEXTS, record.context)) &&
    (record.sessionWrite === undefined || isRendererSessionWriteDiagnostics(record.sessionWrite)) &&
    (record.fingerprint === undefined ||
      (typeof record.fingerprint === 'string' && /^[a-f0-9]{8,64}$/.test(record.fingerprint)))
  )
}
