const REDACTED_MARKER = '[redacted]'

const SENSITIVE_KEY_WORDS = new Set([
  'auth',
  'authentication',
  'authorization',
  'authorizations',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'password',
  'passwords',
  'passphrase',
  'passphrases',
  'passwd',
  'pat',
  'pats',
  'secret',
  'secrets',
  'token',
  'tokens'
])

const TOKEN_METRIC_WORDS = new Set([
  'budget',
  'cached',
  'count',
  'counts',
  'input',
  'limit',
  'max',
  'output',
  'reasoning',
  'remaining',
  'total',
  'usage'
])

const SIGNED_URL_QUERY_WORDS = new Set(['sig', 'signature'])

const diagnosticKeyWords = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const isTokenMetricKey = (words: string[]): boolean =>
  words.some((word) => word === 'token' || word === 'tokens') &&
  words.some((word) => TOKEN_METRIC_WORDS.has(word)) &&
  words.every((word) => word === 'token' || word === 'tokens' || TOKEN_METRIC_WORDS.has(word))

const isSensitiveDiagnosticKey = (key: string): boolean => {
  const words = diagnosticKeyWords(key)
  const normalized = words.join('')

  if (isTokenMetricKey(words)) return false
  if (words.some((word) => SENSITIVE_KEY_WORDS.has(word))) return true

  return [
    'accesstoken',
    'apikey',
    'apikeys',
    'authtoken',
    'bearertoken',
    'clientsecret',
    'clientsecrets',
    'privatekey',
    'privatekeys',
    'refreshtoken',
    'secretaccesskey',
    'securitytoken',
    'sessiontoken',
    'xapikey'
  ].some((suffix) => normalized.endsWith(suffix))
}

const isSensitiveUrlQueryKey = (key: string): boolean =>
  key.toLowerCase() === 'key' ||
  isSensitiveDiagnosticKey(key) ||
  diagnosticKeyWords(key).some((word) => SIGNED_URL_QUERY_WORDS.has(word))

const redactUrlCredentials = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl)
    let changed = false

    if (url.username || url.password) {
      url.username = REDACTED_MARKER
      url.password = ''
      changed = true
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!isSensitiveUrlQueryKey(key)) continue
      url.searchParams.set(key, REDACTED_MARKER)
      changed = true
    }
    if (url.hash) {
      url.hash = ''
      changed = true
    }

    return changed ? url.toString().replaceAll('%5Bredacted%5D', REDACTED_MARKER) : rawUrl
  } catch {
    return REDACTED_MARKER
  }
}

// Shared credential-text policy for diagnostic sinks and user-reviewed public reports. Keep this
// helper unbounded: each caller owns its own output budget, while the credential patterns stay
// identical at both boundaries.
const redactSensitiveText = (value: string): string =>
  value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, redactUrlCredentials)
    .replace(
      /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-amz-security-token|cookie|set-cookie)\b(\s*["']?\s*:\s*["']?)[^"'\r\n}]*/gi,
      `$1$2${REDACTED_MARKER}`
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer[_-]?token|client[_-]?secret|cookie|credential|password|passphrase|passwd|private[_-]?key|refresh[_-]?token|secret|secret[_-]?access[_-]?key|security[_-]?token|session[_-]?token|token)\b(\s*["']?\s*[:=]\s*)(["'])(?:\\.|(?!\3)[^\\\r\n])*\3/gi,
      `$1$2$3${REDACTED_MARKER}$3`
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|authorization|bearer[_-]?token|client[_-]?secret|cookie|credential|password|passphrase|passwd|private[_-]?key|refresh[_-]?token|secret|secret[_-]?access[_-]?key|security[_-]?token|session[_-]?token|token)\b(\s*["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Digest|Negotiate)\s+)?[^\s"'&;}]+/gi,
      `$1$2${REDACTED_MARKER}`
    )
    .replace(
      /\b([a-z][a-z0-9_-]*)(\s*=\s*)(["'])(?:\\.|(?!\3)[^\\\r\n])*\3/gi,
      (match, key: string, separator: string, quote: string) =>
        isSensitiveDiagnosticKey(key)
          ? `${key}${separator}${quote}${REDACTED_MARKER}${quote}`
          : match
    )
    .replace(
      /\b([a-z][a-z0-9_-]*)(\s*=\s*)(?:(?:Bearer|Basic|Digest|Negotiate)\s+)?[^\s"'&;}]+/gi,
      (match, key: string, separator: string) =>
        isSensitiveDiagnosticKey(key) ? `${key}${separator}${REDACTED_MARKER}` : match
    )
    .replace(
      /(--?(?:access[-_]?token|api[-_]?key|auth[-_]?token|authorization|bearer[-_]?token|client[-_]?secret|cookie|credentials?|passphrase|passwd|password|pat|private[-_]?key|secret|token))(\s+|=)(["'])(?:\\.|(?!\3)[^\\\r\n])*\3/gi,
      `$1$2$3${REDACTED_MARKER}$3`
    )
    .replace(
      /(--?(?:access[-_]?token|api[-_]?key|auth[-_]?token|authorization|bearer[-_]?token|client[-_]?secret|cookie|credentials?|passphrase|passwd|password|pat|private[-_]?key|secret|token))(\s+|=)(?:(?:Bearer|Basic|Digest|Negotiate)\s+)?[^\s"'&;]+/gi,
      `$1$2${REDACTED_MARKER}`
    )
    .replace(/\bBearer\s+[^\s"']+/gi, `Bearer ${REDACTED_MARKER}`)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED_MARKER)
    .replace(
      /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g,
      REDACTED_MARKER
    )

export { REDACTED_MARKER, diagnosticKeyWords, isSensitiveDiagnosticKey, redactSensitiveText }
