export const RENDERER_FAILURE_CHANNEL = 'diagnostics:renderer-failure'

export const RENDERER_FAILURE_SOURCES = ['window-error', 'unhandled-rejection'] as const
export type RendererFailureSource = (typeof RENDERER_FAILURE_SOURCES)[number]

export const RENDERER_FAILURE_SURFACES = [
  'home',
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

export type RendererFailureReport = {
  source: RendererFailureSource
  surface: RendererFailureSurface
  errorCategory: RendererErrorCategory
  fingerprint?: string
}

const isOneOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === 'string' && values.includes(value as Value)

export const isRendererFailureReport = (value: unknown): value is RendererFailureReport => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some((key) => !['source', 'surface', 'errorCategory', 'fingerprint'].includes(key))) {
    return false
  }
  if (!keys.includes('source') || !keys.includes('surface') || !keys.includes('errorCategory')) {
    return false
  }

  return (
    isOneOf(RENDERER_FAILURE_SOURCES, record.source) &&
    isOneOf(RENDERER_FAILURE_SURFACES, record.surface) &&
    isOneOf(RENDERER_ERROR_CATEGORIES, record.errorCategory) &&
    (record.fingerprint === undefined ||
      (typeof record.fingerprint === 'string' && /^[a-f0-9]{8,64}$/.test(record.fingerprint)))
  )
}
