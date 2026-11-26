import { providerErrorExcerpt } from '@aipoch/providers/errors'

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
  providerExcerpt?: string
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
  providerExcerpt?: string
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

// Decode the same bounded diagnostics on the wire and when restoring a saved turn.
export const readHarnessErrorDiagnostics = (
  data: Record<string, unknown>
): Pick<FailureDiagnostics, 'code' | 'adapterCode' | 'phase' | 'requestId' | 'providerExcerpt'> => {
  const excerpt = providerErrorExcerpt(data.providerExcerpt)
  const code = readProviderErrorCode(data.code)
  const adapterCode =
    typeof data.adapterCode === 'string' &&
    [
      'http',
      'network',
      'protocol',
      'limit',
      'insufficient_quota',
      'rate_limit_exceeded',
      'model_not_found',
      'authentication_error'
    ].includes(data.adapterCode)
      ? data.adapterCode
      : undefined
  const phase =
    typeof data.phase === 'string' &&
    [
      'response',
      'stream',
      'event-json',
      'provider',
      'choice',
      'usage',
      'tool-delta',
      'missing-done',
      'missing-finish',
      'tool-arguments'
    ].includes(data.phase)
      ? data.phase
      : undefined
  const requestId =
    typeof data.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(data.requestId)
      ? data.requestId
      : undefined
  return {
    ...(excerpt && excerpt === data.providerExcerpt ? { providerExcerpt: excerpt } : {}),
    ...(code ? { code } : {}),
    ...(adapterCode ? { adapterCode } : {}),
    ...(phase ? { phase } : {}),
    ...(requestId ? { requestId } : {})
  }
}
