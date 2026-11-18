export type FailureCategory =
  'configuration' | 'service' | 'environment' | 'input' | 'session' | 'internal'

export type FailureReason = `${FailureCategory}/${string}`

export type FailureDiagnostics = Readonly<{
  status?: number
  code?: string
  adapterCode?: string
  protocol?: 'chat-completions' | 'responses' | 'messages'
  phase?: string
  provider?: string
  model?: string
  requestId?: string
  providerCode?: string
  parameter?: string
  raw?: string
}>

export type ClassifiedFailure = Readonly<{
  responseMessage?: string
  category: FailureCategory
  reason?: FailureReason
  diagnostics: FailureDiagnostics
}>

export type FailureFacts = Readonly<{
  responseMessage?: string
  origin: 'provider' | 'agent-runtime' | 'environment' | 'session' | 'operation'
  protocol?: 'chat-completions' | 'responses' | 'messages'
  status?: number
  code?: string | number
  adapterCode?: string
  phase?: string
  provider?: string
  model?: string
  requestId?: string
  text?: string
}>

export type Recognizer = (facts: FailureFacts) => ClassifiedFailure | undefined

/** The built-in harness exposes only these standard codes, never provider-defined identifiers. */
export const PROVIDER_ERROR_CODES = [
  'authentication_error',
  'insufficient_quota',
  'rate_limit_exceeded',
  'model_not_found',
  'endpoint_not_found',
  'context_length_exceeded',
  'invalid_request_error',
  'server_error',
  'provider_error'
] as const
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number]
export const readProviderErrorCode = (value: unknown): ProviderErrorCode | undefined =>
  typeof value === 'string' && (PROVIDER_ERROR_CODES as readonly string[]).includes(value)
    ? (value as ProviderErrorCode)
    : undefined
