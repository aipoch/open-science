import type { Recognizer } from '../contract'

export const recognizeProvider: Recognizer = ({ origin, status, code, text = '' }) => {
  const diagnosticCode = String(code ?? '').toLowerCase()
  // Transport status wins over provider prose, which can quote an unrelated previous failure.
  if (origin === 'provider') {
    if (status === 413) return undefined
    if (status === 401 || status === 403)
      return { category: 'configuration', reason: 'configuration/auth-failed', diagnostics: {} }
    if (status === 429)
      return { category: 'service', reason: 'service/rate-limited', diagnostics: {} }
    if (status !== undefined && status >= 500 && status <= 599)
      return { category: 'service', reason: 'service/unavailable', diagnostics: {} }
    if (status === 404)
      return {
        category: 'configuration',
        reason: 'configuration/model-unavailable',
        diagnostics: {}
      }
    if (['invalid_api_key', 'authentication_error', 'unauthorized'].includes(diagnosticCode))
      return { category: 'configuration', reason: 'configuration/auth-failed', diagnostics: {} }
    if (['insufficient_quota', 'billing_error', 'quota_exceeded'].includes(diagnosticCode))
      return { category: 'configuration', reason: 'configuration/billing', diagnostics: {} }
    if (['rate_limit_exceeded', 'rate_limit_error'].includes(diagnosticCode))
      return { category: 'service', reason: 'service/rate-limited', diagnostics: {} }
  }
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
  if (
    /\b(?:invalid api key|api key (?:is )?missing|authentication failed|unauthorized)\b/i.test(text)
  )
    return { category: 'configuration', reason: 'configuration/auth-failed', diagnostics: {} }
  if (
    /insufficient[_ ]quota|billing (?:limit|quota|balance)|credit balance (?:is )?too low/i.test(
      text
    )
  )
    return { category: 'configuration', reason: 'configuration/billing', diagnostics: {} }
  if (/model[_ ]not[_ ]found|no such model|model .+ (?:does not exist|not found)/i.test(text))
    return { category: 'configuration', reason: 'configuration/model-unavailable', diagnostics: {} }
  if (/rate[_ -]?limit|too many requests/i.test(text))
    return { category: 'service', reason: 'service/rate-limited', diagnostics: {} }
  if (
    /timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection (?:reset|closed|interrupted)/i.test(
      `${diagnosticCode} ${text}`
    )
  )
    return { category: 'service', reason: 'service/connection-failed', diagnostics: {} }
  return undefined
}
