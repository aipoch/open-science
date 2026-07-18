// Turns an agent prompt failure into user-visible text. Agents (opencode) relay an upstream provider
// HTTP error wrapped as a JSON-RPC failure like
//   `Internal error: Not Found: {"error":{"message":"The requested resource was not found","type":"resource_not_found_error"}}`
// which is opaque to a user. When the wrapped error is a provider "resource not found" (a wrong model
// id or base URL, by far the most common misconfiguration), we surface the provider's own message plus
// an actionable hint. Any other failure is passed through unchanged so genuinely different problems
// stay visible. Kept as a pure module so the branch matrix is unit-testable.

export type PromptErrorContext = {
  // The active model id, when the framework selects it over the protocol (opencode). Named in the hint
  // so the user knows exactly which value to fix.
  model?: string
}

// The innermost provider detail pulled from a wrapped error message.
type UpstreamDetail = { text: string; type?: string }

// Matches the "resource not found" family across the shapes providers actually return: the resource
// not-found error type, the HTTP status label the wrapper emits (`Not Found:`), the "no such model"
// phrasing, and the Chinese messages some gateways emit (e.g. Moonshot's 没找到对象). Deliberately does
// NOT match a bare "not found" substring, so a benign message like "rate limit config not found" isn't
// mistaken for a model/endpoint problem.
const NOT_FOUND_PATTERN =
  /resource[\s_-]?not[\s_-]?found|no such (?:model|resource)|not[\s_-]?found\s*:|没找到|不存在/i

// Converts an unknown thrown value into its base message string.
const rawErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// True when the agent tagged the failure as an upstream provider API error (vs. an ACP protocol
// error such as a missing session, which the resume path handles separately).
const isApiError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false

  const data = (error as { data?: unknown }).data

  if (typeof data !== 'object' || data === null) return false

  return (data as { errorName?: unknown }).errorName === 'APIError'
}

// Strips the agent's `Internal error:` and HTTP `Not Found:` status prefixes so a text-only provider
// message reads cleanly. Empty result falls back to the original so we never surface a blank string.
const stripWrapperPrefixes = (message: string): string =>
  message
    .replace(/^\s*internal error:\s*/i, '')
    .replace(/^\s*not[\s_-]?found:\s*/i, '')
    .trim() || message

// Returns the first balanced `{…}` JSON object starting at `start`, respecting string literals so an
// escaped or in-string brace doesn't throw off the depth count. Lets us parse a provider payload that
// is followed by trailing text (e.g. `{…} (request id: abc)`), which `JSON.parse` would otherwise reject.
const sliceBalancedJson = (message: string, start: number): string | undefined => {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < message.length; i++) {
    const ch = message[i]

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return message.slice(start, i + 1)
  }

  return undefined
}

// Extracts the provider's own `{ error: { message, type } }` payload when the wrapper carries one, so
// we can show the human message instead of a raw JSON blob. Returns undefined for a text-only wrapper.
const extractUpstreamDetail = (message: string): UpstreamDetail | undefined => {
  const braceStart = message.indexOf('{')

  if (braceStart === -1) return undefined

  const jsonText = sliceBalancedJson(message, braceStart)

  if (jsonText === undefined) return undefined

  try {
    const parsed = JSON.parse(jsonText) as {
      error?: { message?: unknown; type?: unknown }
      message?: unknown
    }
    const err = parsed.error
    const text =
      (typeof err?.message === 'string' && err.message.trim()) ||
      (typeof parsed.message === 'string' && parsed.message.trim()) ||
      ''

    if (!text) return undefined

    return { text, type: typeof err?.type === 'string' ? err.type : undefined }
  } catch {
    return undefined
  }
}

// Whether the failure is an upstream "resource not found" (wrong model id / endpoint), which we reword.
const isProviderNotFound = (
  error: unknown,
  raw: string,
  detail: UpstreamDetail | undefined
): boolean => {
  const matchesNotFound =
    NOT_FOUND_PATTERN.test(raw) || (detail?.type ? NOT_FOUND_PATTERN.test(detail.type) : false)

  if (!matchesNotFound) return false

  // Require an upstream signal so an ACP-level not-found isn't mistaken for a model problem.
  return isApiError(error) || /resource_not_found/i.test(raw) || detail !== undefined
}

// Produces the session-visible error text for a failed prompt: an actionable message for a provider
// not-found, else the original message untouched.
export const describePromptError = (error: unknown, ctx: PromptErrorContext = {}): string => {
  const raw = rawErrorMessage(error)
  const detail = extractUpstreamDetail(raw)

  if (!isProviderNotFound(error, raw, detail)) return raw

  const providerText = detail?.text ?? stripWrapperPrefixes(raw)
  const modelPart = ctx.model ? ` for model "${ctx.model}"` : ''

  return `The model provider could not find the requested resource${modelPart}. The model name or endpoint is likely incorrect — check it in Settings → Model. Provider response: ${providerText}`
}
