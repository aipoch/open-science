import { PROVIDER_RESOURCE_NOT_FOUND_PREFIX } from '../../shared/run-error-classification'

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

// The "resource not found" family. The agent renders the provider's HTTP error with an English status
// label (`Not Found:`) and the provider's structured error type is an ASCII slug (`resource_not_found`),
// so matching stays language-agnostic without pattern-matching localized message text — the provider's
// own (possibly non-English) message is still surfaced verbatim as data. Deliberately does NOT match a
// bare "not found" substring, so a benign message like "rate limit config not found" isn't reworded.
const NOT_FOUND_PATTERN =
  /resource[\s_-]?not[\s_-]?found|no such (?:model|resource)|not[\s_-]?found\s*:/i

// Converts an unknown thrown value into its base message string.
const rawErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// The JSON-RPC code the agent attached, when present. -32002 is the ACP "resource not found" protocol
// code (a missing session), which must not be confused with an upstream provider not-found.
const errorCode = (error: unknown): number | undefined => {
  const code = (error as { code?: unknown } | null)?.code

  return typeof code === 'number' ? code : undefined
}

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

// Whether the failure is an upstream provider "resource not found" (wrong model id / endpoint), which
// we reword. Requires a genuine provider signal so an ACP-level protocol not-found (e.g. a -32002
// missing-session error, even one that carries a JSON body) is never mistaken for a model problem.
const isProviderNotFound = (
  error: unknown,
  raw: string,
  detail: UpstreamDetail | undefined
): boolean => {
  const hasNotFoundType = detail?.type ? NOT_FOUND_PATTERN.test(detail.type) : false
  const matchesNotFound = NOT_FOUND_PATTERN.test(raw) || hasNotFoundType

  if (!matchesNotFound) return false

  // The ACP resume path owns protocol not-founds; never reword one unless the agent explicitly tagged
  // it as an upstream API error.
  if (errorCode(error) === -32002 && !isApiError(error)) return false

  // Require an upstream signal: the API-error tag, the provider's resource_not_found slug, or a
  // structured provider error type in the not-found family. A parseable JSON body alone is not enough.
  return isApiError(error) || /resource_not_found/i.test(raw) || hasNotFoundType
}

// Produces the session-visible error text for a failed prompt: an actionable message for a provider
// not-found, else the original message untouched.
export const describePromptError = (error: unknown, ctx: PromptErrorContext = {}): string => {
  const raw = rawErrorMessage(error)
  const detail = extractUpstreamDetail(raw)

  if (!isProviderNotFound(error, raw, detail)) return raw

  const providerText = detail?.text ?? stripWrapperPrefixes(raw)
  const modelPart = ctx.model ? ` for model "${ctx.model}"` : ''

  return `${PROVIDER_RESOURCE_NOT_FOUND_PREFIX}${modelPart}. The model name or endpoint is likely incorrect — check it in Settings → Model. Provider response: ${providerText}`
}

// The agent's structured tag for a failure it relayed from the upstream model provider (as opposed to
// an ACP protocol/session error). The bridges attach `data.errorKind: 'provider-error'` for these.
const isProviderErrorKind = (error: unknown): boolean => {
  try {
    const data = (error as { data?: unknown } | null)?.data
    const kind = (data as { errorKind?: unknown } | null | undefined)?.errorKind

    return (
      typeof kind === 'string' &&
      kind
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '-') === 'provider-error'
    )
  } catch {
    return false
  }
}

// Whether a failed prompt originates from the model provider (an upstream LLM/HTTP failure the agent
// relayed) rather than from the app's own ACP layer. Provider failures are the user's/provider's to
// resolve (wrong key, rate limit, quota, model id, a provider 5xx), so the renderer does NOT offer a
// "Report error → GitHub issue" affordance for them — only genuinely unexpected ACP-layer exceptions
// are worth a bug report. Determined structurally, from the signals the agent attaches, so it needs no
// message-text pattern matching:
//   - the agent tagged the failure as an upstream `APIError` (covers auth/rate/quota/5xx/etc.), or
//   - the agent tagged `data.errorKind: 'provider-error'` (the bridges' machine-readable marker), or
//   - it is a provider "resource not found" (wrong model id / endpoint), which requires the same
//     upstream signal (see isProviderNotFound) and is never a bare ACP protocol not-found.
export const isProviderPromptError = (error: unknown): boolean => {
  if (isApiError(error)) return true
  if (isProviderErrorKind(error)) return true

  const raw = rawErrorMessage(error)

  return isProviderNotFound(error, raw, extractUpstreamDetail(raw))
}
