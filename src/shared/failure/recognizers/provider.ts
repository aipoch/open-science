import type { Recognizer } from '../contract'

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
const NETWORK =
  /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|DNS|TLS|connection (?:reset|closed|interrupted)/i

export const recognizeProvider: Recognizer = ({
  origin,
  status,
  code,
  adapterCode,
  protocol,
  phase,
  responseMessage,
  text = ''
}) => {
  if (origin === 'provider' && protocol) {
    // Built-in adapters discard upstream messages; classify by actual status, standard code, and phase.
    const reasons = {
      authentication_error: 'configuration/auth-failed',
      insufficient_quota: 'configuration/billing',
      rate_limit_exceeded: 'service/rate-limited',
      model_not_found: 'configuration/model-unavailable',
      endpoint_not_found: 'configuration/endpoint-invalid',
      invalid_request_error: 'configuration/request-invalid',
      server_error: 'service/unavailable',
      provider_error: 'service/provider-error'
    } as const
    if (status === 413 || code === 'context_length_exceeded') return undefined
    const reason =
      status === 401 || status === 403
        ? 'configuration/auth-failed'
        : status === 429
          ? code === 'insufficient_quota'
            ? 'configuration/billing'
            : 'service/rate-limited'
          : status !== undefined && status >= 500 && status <= 599
            ? 'service/unavailable'
            : (reasons[code as keyof typeof reasons] ??
              (adapterCode === 'network'
                ? phase === 'stream'
                  ? 'service/response-interrupted'
                  : 'service/connection-failed'
                : adapterCode === 'protocol' && phase !== 'provider'
                  ? 'service/response-invalid'
                  : 'service/provider-error'))
    return {
      category: reason.startsWith('configuration/') ? 'configuration' : 'service',
      reason,
      diagnostics: {}
    }
  }

  // Keep legacy framework wrappers; use provider messages for classification only after verifying their origin.
  if (
    /^(?:(?:ApplicationCommandError|RequestError|Error|Agent session resume failed):\s*)*Authentication required\.?$/i.test(
      text.trim()
    )
  )
    return { category: 'configuration', reason: 'configuration/auth-failed', diagnostics: {} }
  if (/(?:^|:\s*)api error:\s*connection closed mid-response\b/i.test(text))
    return { category: 'service', reason: 'service/response-interrupted', diagnostics: {} }
  if (
    /(?:^|:\s*)api error:\s*unable to connect to api\b/i.test(text) ||
    text.startsWith('Could not connect to the model provider')
  )
    return { category: 'service', reason: 'service/connection-failed', diagnostics: {} }
  if (origin !== 'provider') return undefined

  const structuredCode = String(code ?? '').toLowerCase()
  const detail = responseMessage ?? text
  const billingCode = BILLING.test(structuredCode)
  // Explicit transport status takes precedence; structured quota errors in 429 indicate account configuration.
  if (status === 413) return undefined
  if (status === 401 || status === 403)
    return { category: 'configuration', reason: 'configuration/auth-failed', diagnostics: {} }
  if (status === 429)
    return billingCode
      ? { category: 'configuration', reason: 'configuration/billing', diagnostics: {} }
      : { category: 'service', reason: 'service/rate-limited', diagnostics: {} }
  if (status !== undefined && status >= 500 && status <= 599)
    return { category: 'service', reason: 'service/unavailable', diagnostics: {} }

  if (AUTH.test(structuredCode))
    return { category: 'configuration', reason: 'configuration/auth-failed', diagnostics: {} }
  if (billingCode)
    return { category: 'configuration', reason: 'configuration/billing', diagnostics: {} }
  if (MODEL_UNAVAILABLE.test(structuredCode))
    return { category: 'configuration', reason: 'configuration/model-unavailable', diagnostics: {} }
  if (/rate[_ -]?limit/.test(structuredCode))
    return { category: 'service', reason: 'service/rate-limited', diagnostics: {} }
  if (code === 'ContextOverflowError' || CONTEXT.test(`${structuredCode} ${detail}`))
    return undefined
  if (AUTH.test(detail))
    return { category: 'configuration', reason: 'configuration/auth-failed', diagnostics: {} }
  if (BILLING.test(detail))
    return { category: 'configuration', reason: 'configuration/billing', diagnostics: {} }
  if (MODEL_UNAVAILABLE.test(detail))
    return { category: 'configuration', reason: 'configuration/model-unavailable', diagnostics: {} }
  if (status === 404)
    return ENDPOINT_INVALID.test(detail)
      ? { category: 'configuration', reason: 'configuration/endpoint-invalid', diagnostics: {} }
      : { category: 'service', reason: 'service/provider-error', diagnostics: {} }
  if (/rate[_ -]?limit|too many requests/i.test(detail))
    return { category: 'service', reason: 'service/rate-limited', diagnostics: {} }
  if (
    ['server_error', 'internal_server_error', 'overloaded_error', 'api_error'].includes(
      structuredCode
    )
  )
    return { category: 'service', reason: 'service/unavailable', diagnostics: {} }
  if (status === 400 || status === 422)
    return { category: 'configuration', reason: 'configuration/request-invalid', diagnostics: {} }
  if (adapterCode === 'network' && phase === 'stream')
    return { category: 'service', reason: 'service/response-interrupted', diagnostics: {} }
  if (adapterCode === 'network' || NETWORK.test(`${structuredCode} ${detail}`))
    return { category: 'service', reason: 'service/connection-failed', diagnostics: {} }
  if (adapterCode === 'protocol' && phase !== 'provider')
    return { category: 'service', reason: 'service/response-invalid', diagnostics: {} }
  return { category: 'service', reason: 'service/provider-error', diagnostics: {} }
}
