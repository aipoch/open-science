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
export type RendererSessionWriteDiagnostics = Readonly<{
  target: 'session' | 'manifest'
  sessionId?: string
  projectId?: string
  code: (typeof SESSION_WRITE_FAILURE_CODES)[number]
  epoch: number
  phase: 'before-submit' | 'result-unknown' | 'rejected'
}>

export const isRendererSessionWriteDiagnostics = (
  value: unknown
): value is RendererSessionWriteDiagnostics => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => !['target', 'sessionId', 'projectId', 'code', 'epoch', 'phase'].includes(key)
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
    typeof record.epoch === 'number' &&
    Number.isSafeInteger(record.epoch) &&
    record.epoch >= 0 &&
    isOneOf(['before-submit', 'result-unknown', 'rejected'], record.phase)
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
