import type { ValidateProviderResult, ValidationCategory } from '../../shared/settings'
import { normalizeAnthropicBaseUrl } from './base-url'
import type { ResolvedProvider } from './provider-env'

// Runs a real connectivity/auth probe for a provider and classifies the outcome into an actionable
// category. Request construction and classification are pure so the branch matrix is unit-testable;
// the network/subprocess calls are injected.

// Default probe timeout; a stuck gateway should fail fast rather than hang the wizard.
const DEFAULT_VALIDATE_TIMEOUT_MS = 20_000
const ANTHROPIC_VERSION = '2023-06-01'

// A minimal, cheap Messages request used only to confirm the endpoint + credentials + model work.
type ValidationHttpRequest = {
  url: string
  headers: Record<string, string>
  body: string
}

// Builds the /v1/messages probe request for a custom provider. Throws on an unusable base URL so the
// caller can classify it as bad-url instead of firing a doomed fetch.
const buildValidationRequest = (provider: ResolvedProvider): ValidationHttpRequest => {
  if (!provider.baseUrl) {
    throw new Error('Missing base URL.')
  }

  let url: string

  try {
    // Mirror how the claude client builds requests: ANTHROPIC_BASE_URL + "/v1/messages". The base URL
    // is normalized first so a user-supplied trailing `/v1` isn't doubled into `.../v1/v1/messages`
    // (a 404). Validate it parses as a URL so an unusable base is classified as bad-url instead of
    // firing a doomed fetch.
    url = new URL(`${normalizeAnthropicBaseUrl(provider.baseUrl)}/v1/messages`).toString()
  } catch {
    throw new Error('Invalid base URL.')
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION
  }

  // Custom gateways authenticate with a bearer token.
  if (provider.key) {
    headers.authorization = `Bearer ${provider.key}`
  }

  const body = JSON.stringify({
    model: provider.model ?? '',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }]
  })

  return { url, headers, body }
}

// Maps an HTTP status to a validation category. 2xx is success; auth/model errors are distinguished
// so the UI can point the user at the credential vs. the model field.
const classifyStatus = (status: number): ValidationCategory => {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404 || status === 400) return 'model-not-found'

  return 'unknown'
}

// Maps a thrown fetch error (or URL failure) to a category.
const classifyFetchError = (error: unknown): ValidationCategory => {
  const message = error instanceof Error ? error.message : String(error)

  if (/invalid base url|missing base url/i.test(message)) return 'bad-url'
  if (error instanceof Error && error.name === 'AbortError') return 'timeout'
  if (/timed out|timeout/i.test(message)) return 'timeout'

  return 'network'
}

const toResult = (
  category: ValidationCategory,
  extra: { status?: number; message?: string } = {}
): ValidateProviderResult => ({
  ok: category === 'ok',
  category,
  ...extra
})

// Cap on a surfaced provider error so a runaway HTML/error page can't flood the UI.
const MAX_ERROR_MESSAGE_LENGTH = 300

// Digs the human-readable error string out of a parsed error body. Anthropic- and
// OpenAI/DeepSeek-compatible gateways nest it under `error.message`; some return a bare `message` or
// a string `error` (e.g. DeepSeek's "Insufficient Balance" on a 402).
const pickErrorMessage = (parsed: unknown): string | undefined => {
  if (!parsed || typeof parsed !== 'object') return undefined

  const { error, message } = parsed as { error?: unknown; message?: unknown }

  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const nested = (error as { message?: unknown }).message
    if (typeof nested === 'string') return nested
  }
  if (typeof message === 'string') return message

  return undefined
}

// Turns a provider's raw error body into a short, single-line message, or undefined when it carries
// nothing usable. Non-JSON bodies (an HTML/plain-text gateway error page) fall back to the raw text.
const extractProviderErrorMessage = (bodyText: string): string | undefined => {
  const trimmed = bodyText.trim()
  if (!trimmed) return undefined

  let message: string | undefined
  try {
    message = pickErrorMessage(JSON.parse(trimmed))
  } catch {
    // Not JSON — surface a short plain-text error, but skip an HTML/markup body (a 5xx gateway error
    // page from nginx/Cloudflare) whose tags would be noise rather than a reason.
    message = trimmed.startsWith('<') ? undefined : trimmed
  }
  if (!message) return undefined

  const collapsed = message.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined

  return collapsed.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : collapsed
}

// Reads and extracts a failed response's error message, tolerating a body that can't be read.
const readProviderErrorMessage = async (response: Response): Promise<string | undefined> => {
  try {
    return extractProviderErrorMessage(await response.text())
  } catch {
    return undefined
  }
}

// Outcome of the one-shot claude-default probe. `timedOut` lets the UI show a timeout message instead
// of a misleading auth failure when the local claude never responds.
export type ClaudeProbeResult = {
  ok: boolean
  timedOut?: boolean
  message?: string
}

export type ValidateProviderDeps = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  // Runs a one-shot `claude -p "ok"` probe for claude-default providers.
  runClaudeProbe?: () => Promise<ClaudeProbeResult>
}

// Validates a custom provider by hitting its Messages endpoint with a 1-token request.
const validateCustomProvider = async (
  provider: ResolvedProvider,
  { fetchImpl = fetch, timeoutMs = DEFAULT_VALIDATE_TIMEOUT_MS }: ValidateProviderDeps
): Promise<ValidateProviderResult> => {
  let request: ValidationHttpRequest

  try {
    request = buildValidationRequest(provider)
  } catch (error) {
    return toResult(classifyFetchError(error), {
      message: error instanceof Error ? error.message : String(error)
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    })
    const category = classifyStatus(response.status)

    // Only the catch-all 'unknown' status (402 billing, 429 rate limit, 5xx, …) lacks guidance of its
    // own, so surface the gateway's error text there — whatever it actually says — rather than an
    // assumed meaning. auth/model-not-found already map to targeted advice, so their raw bodies would
    // only muddy it.
    if (category === 'unknown') {
      return toResult(category, {
        status: response.status,
        message: await readProviderErrorMessage(response)
      })
    }

    return toResult(category, { status: response.status })
  } catch (error) {
    return toResult(classifyFetchError(error), {
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    clearTimeout(timer)
  }
}

// Validates a claude-default provider by running a one-shot claude probe against the user's auth.
const validateClaudeDefaultProvider = async (
  deps: ValidateProviderDeps
): Promise<ValidateProviderResult> => {
  if (!deps.runClaudeProbe) {
    return toResult('unknown', { message: 'Claude probe is not configured.' })
  }

  try {
    const probe = await deps.runClaudeProbe()

    if (probe.ok) return toResult('ok')

    return toResult(probe.timedOut ? 'timeout' : 'auth', {
      message:
        probe.message ??
        (probe.timedOut
          ? 'Local claude did not respond in time.'
          : 'Local claude could not complete a request.')
    })
  } catch (error) {
    return toResult('unknown', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

// Dispatches validation by provider type.
const validateProvider = (
  provider: ResolvedProvider,
  deps: ValidateProviderDeps = {}
): Promise<ValidateProviderResult> =>
  provider.type === 'claude-default'
    ? validateClaudeDefaultProvider(deps)
    : validateCustomProvider(provider, deps)

export {
  ANTHROPIC_VERSION,
  DEFAULT_VALIDATE_TIMEOUT_MS,
  buildValidationRequest,
  classifyFetchError,
  classifyStatus,
  extractProviderErrorMessage,
  validateProvider
}
