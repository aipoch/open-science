export type AdapterErrorPhase =
  | 'response'
  | 'stream'
  | 'event-json'
  | 'provider'
  | 'choice'
  | 'usage'
  | 'tool-delta'
  | 'missing-done'
  | 'missing-finish'
  | 'tool-arguments'

/** Expose fixed reasons only; keep provider messages and unknown codes inside the adapter. */
export type ProviderErrorReason =
  | 'authentication_error'
  | 'insufficient_quota'
  | 'rate_limit_exceeded'
  | 'model_not_found'
  | 'endpoint_not_found'
  | 'context_length_exceeded'
  | 'invalid_request_error'
  | 'server_error'
  | 'provider_error'

/** Optional host policy. Only return a public, allowlisted excerpt suitable for diagnostics. */
export type SummarizeProviderError = (message: string) => string | undefined

export type UpstreamErrorDiagnostics = Readonly<{
  providerExcerpt?: string
  phase?: AdapterErrorPhase
  reason?: ProviderErrorReason
  requestId?: string
}>

const MAX_ERROR_BODY_BYTES = 16_384
const ERROR_BODY_TIMEOUT_MS = 2_000
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'openai-request-id'] as const
const MODEL_UNAVAILABLE =
  /model[_ -](?:not[_ -]found|unavailable)|\bno such model\b|\bmodel\b[^\n]{0,180}?\b(?:is unavailable|does not exist|not found|isn't included|is not included|has been retired|has been deprecated|is no longer available)\b/i
const ENDPOINT_INVALID =
  /\b(?:endpoint|base\s*url|url|route|path)\b[^\n.!?]{0,160}\b(?:not found|does not exist|invalid|unavailable)\b|\b(?:not found|invalid)\b[^\n.!?]{0,160}\b(?:endpoint|url|route|path)\b/i
const AUTH =
  /invalid[_ -]api[_ -]key|api key (?:is )?missing|authentication[_ -](?:fails?|failed|error)|unauthorized|token[_ -]expired/i
const BILLING =
  /insufficient[_ -]quota|quota[_ -]exceeded|billing[_ -](?:error|limit|quota|balance)|credit balance (?:is )?too low|usage_limit_reached|subscription_sharing_usage_limit_exceeded/i
const CONTEXT =
  /media[_\s-]?unstrippable|request[_\s-]?(?:entity[_\s-]?)?too[_\s-]?large|maximum context length|context[_\s-]?(?:length|window)[_\s-]?exceeded|prompt is too long/i
const INVALID_REQUEST =
  /invalid[_ -]request[_ -]error|invalid (?:parameter|temperature|output format)|unsupported parameter/i

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Accept only short request IDs from declared headers; never truncate or read JSON request_id fields. */
export const responseErrorDiagnostics = (response: Response): UpstreamErrorDiagnostics => {
  const requestId = REQUEST_ID_HEADERS.map((name) => response.headers.get(name)).find(
    (value) => value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
  return requestId ? { requestId } : {}
}

/** Map status and upstream semantics to finite reasons without exposing unknown response content. */
const identifyReason = (codes: string[], message: string, status?: number): ProviderErrorReason => {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 413) return 'context_length_exceeded'
  if (status === 429)
    return codes.some((code) => BILLING.test(code)) || BILLING.test(message)
      ? 'insufficient_quota'
      : 'rate_limit_exceeded'
  if (status !== undefined && status >= 500 && status <= 599) return 'server_error'
  if (codes.includes('endpoint_not_found')) return 'endpoint_not_found'
  const detail = [...codes, message].join(' ')
  if (AUTH.test(detail)) return 'authentication_error'
  if (BILLING.test(detail)) return 'insufficient_quota'
  if (MODEL_UNAVAILABLE.test(detail)) return 'model_not_found'
  if (CONTEXT.test(detail)) return 'context_length_exceeded'
  if (/rate[_ -]?limit|too many requests/i.test(detail)) return 'rate_limit_exceeded'
  if (ENDPOINT_INVALID.test(detail)) return 'endpoint_not_found'
  if (
    codes.some((code) =>
      ['server_error', 'internal_server_error', 'overloaded_error', 'api_error'].includes(code)
    )
  )
    return 'server_error'
  if (status === 422 || INVALID_REQUEST.test(detail)) return 'invalid_request_error'
  return 'provider_error'
}

/** Keep normalized evidence; arbitrary provider wording stays inside this boundary. */
export const normalizeProviderError = (
  value: unknown,
  status?: number,
  summarize?: SummarizeProviderError
): UpstreamErrorDiagnostics => {
  const root = object(value)
  const error = object(root?.error) ?? root
  const codes = [error?.code, error?.type].filter(
    (code): code is string => typeof code === 'string'
  )
  const message = typeof error?.message === 'string' ? error.message : ''
  const excerpt = summarize?.(message)
  return {
    reason: identifyReason(codes, message, status),
    ...(excerpt && excerpt.length <= 300 ? { providerExcerpt: excerpt } : {})
  }
}

/**
 * Read bounded error content and release the stream on timeout, cancellation, or overflow.
 * Read failures preserve the HTTP status.
 *
 * Args:
 *   response: The upstream HTTP response.
 *   signal: The cancellation signal for the current model call.
 *
 * Returns:
 *   A finite standard failure reason and a validated request ID from response headers.
 */
export const normalizeUpstreamError = async (
  response: Response,
  signal: AbortSignal,
  summarize?: SummarizeProviderError
): Promise<UpstreamErrorDiagnostics> => {
  signal.throwIfAborted()
  const headers = {
    ...normalizeProviderError(undefined, response.status),
    ...responseErrorDiagnostics(response)
  }
  const reader = response.body?.getReader()
  if (!reader) return headers
  let body = ''
  let size = 0
  let complete = false
  const decoder = new TextDecoder()
  // Some underlying streams never settle cancel(), so do not await it.
  const stop = AbortSignal.any([signal, AbortSignal.timeout(ERROR_BODY_TIMEOUT_MS)])
  let stopped!: () => void
  const cancelled = new Promise<undefined>((resolve) => {
    stopped = () => resolve(undefined)
  })
  const cancel = (): void => {
    stopped()
    void reader.cancel().catch(() => undefined)
  }
  stop.addEventListener('abort', cancel, { once: true })
  try {
    while (!stop.aborted) {
      const chunk = await Promise.race([reader.read(), cancelled])
      if (!chunk) break
      if (chunk.done) {
        complete = true
        body += decoder.decode()
        break
      }
      const remaining = MAX_ERROR_BODY_BYTES - size
      const part = chunk.value.subarray(0, remaining)
      size += part.byteLength
      body += decoder.decode(part, { stream: true })
      // Confirm EOF at the exact limit; only extra bytes imply truncation, and they are not retained.
      if (chunk.value.byteLength > remaining) break
    }
  } catch {
    // Preserve the header request ID on interruption without recording exceptions or request details.
  } finally {
    stop.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
  signal.throwIfAborted()
  const text = body.trim()
  if (response.headers.get('content-type')?.toLowerCase().includes('html') || text.startsWith('<'))
    return headers
  const isJson =
    response.headers.get('content-type')?.toLowerCase().includes('json') || /^[{[]/.test(text)
  if (isJson) {
    if (!complete) return headers
    try {
      return { ...headers, ...normalizeProviderError(JSON.parse(text), response.status, summarize) }
    } catch {
      // Never use malformed or truncated JSON as a raw error message.
      return headers
    }
  }
  return {
    ...headers,
    ...normalizeProviderError({ message: text }, response.status, complete ? summarize : undefined)
  }
}
