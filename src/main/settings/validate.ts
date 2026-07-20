import type { ValidateProviderResult, ValidationCategory } from '../../shared/settings'
import { preferredEndpoint } from '../../shared/settings'
import {
  normalizeAnthropicBaseUrl,
  openAiChatCompletionsUrl,
  openAiCompletionsBase
} from './base-url'
import type { ResolvedProvider } from './provider-env'
import { ResponsesBridge, responsesToChatRequest } from './responses-bridge'

// Runs a real connectivity/auth probe for a provider and classifies the outcome into an actionable
// category. Request construction and classification are pure so the branch matrix is unit-testable;
// the network/subprocess calls are injected.

// Default probe timeout; a stuck gateway should fail fast rather than hang the wizard.
const DEFAULT_VALIDATE_TIMEOUT_MS = 20_000
const ANTHROPIC_VERSION = '2023-06-01'
// Keep an unmodified loopback fetch for the temporary local bridge. Tests and callers may inject/mock
// the upstream fetch, but that must not intercept the request from the validator into 127.0.0.1.
const loopbackFetch = globalThis.fetch.bind(globalThis)

// A minimal, cheap Messages request used only to confirm the endpoint + credentials + model work.
type ValidationHttpRequest = {
  url: string
  headers: Record<string, string>
  body: string
  requiresBridgeToolCall?: boolean
}

const BRIDGE_PROBE_TOOL = 'open_science_bridge_probe'

const bridgeProbeResponsesBody = (model: string): Record<string, unknown> => ({
  model,
  input: 'Call the validation tool now. Do not answer with text.',
  // Reasoning models may spend the first tokens deciding to call the tool. A tiny budget can end
  // with finish_reason=length before any tool delta, falsely marking a compatible provider invalid.
  max_output_tokens: 512,
  tools: [
    {
      type: 'function',
      name: BRIDGE_PROBE_TOOL,
      description: 'Validates function-tool support for the local Responses bridge.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  ],
  // Match Codex's real bridge requests. Some compatible providers reject a forced-function object even
  // though they correctly choose and stream the function under `auto`.
  tool_choice: 'auto',
  stream: true
})

// Builds the probe request for a custom provider against the endpoint it actually speaks: an
// OpenAI-compatible gateway gets a `/v1/chat/completions` request, an Anthropic one `/v1/messages`.
// The endpoint is chosen from the provider's apiType (OpenAI wins when it offers both), matching how
// the model is driven. Throws on an unusable base URL so the caller can classify it as bad-url.
const buildValidationRequest = (
  provider: ResolvedProvider,
  requireBridgeToolCall = false
): ValidationHttpRequest => {
  if (!provider.baseUrl) {
    throw new Error('Missing base URL.')
  }

  const endpoint = preferredEndpoint(provider.apiEndpoints ?? ['anthropic'], [
    'anthropic',
    'openai',
    'responses'
  ])

  if (endpoint === 'responses') return buildResponsesValidationRequest(provider)
  if (endpoint === 'openai') return buildOpenAiValidationRequest(provider, requireBridgeToolCall)

  return buildAnthropicValidationRequest(provider)
}

// A minimal /v1/messages probe (Anthropic). The base URL is normalized first so a trailing `/v1`
// isn't doubled into `.../v1/v1/messages` (a 404).
const buildAnthropicValidationRequest = (provider: ResolvedProvider): ValidationHttpRequest => {
  let url: string

  try {
    url = new URL(`${normalizeAnthropicBaseUrl(provider.baseUrl ?? '')}/v1/messages`).toString()
  } catch {
    throw new Error('Invalid base URL.')
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION
  }

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

// A bridge contract probe for /v1/chat/completions. Codex depends on function calls, so a plain text
// ping is insufficient: providers that ignore/reject this tool request must remain unverified.
const buildOpenAiValidationRequest = (
  provider: ResolvedProvider,
  requireBridgeToolCall: boolean
): ValidationHttpRequest => {
  let url: string

  // Probe the same OpenAI endpoint the bridge/opencode will use: an official vendor's versioned base,
  // or a custom root normalized to `<root>/v1`.
  const endpoint = openAiChatCompletionsUrl(provider)
  if (!endpoint) throw new Error('Missing base URL.')

  try {
    url = new URL(endpoint).toString()
  } catch {
    throw new Error('Invalid base URL.')
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json'
  }

  if (provider.key) {
    headers.authorization = `Bearer ${provider.key}`
  }

  const body = JSON.stringify(
    requireBridgeToolCall
      ? responsesToChatRequest(bridgeProbeResponsesBody(provider.model ?? ''), provider.model)
      : {
          model: provider.model ?? '',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false
        }
  )

  return {
    url,
    headers,
    body,
    ...(requireBridgeToolCall ? { requiresBridgeToolCall: true } : {})
  }
}

// A minimal OpenAI Responses request. Responses is a separate wire protocol from Chat Completions;
// normalize either a root, `/v1`, or full `/v1/responses` value to exactly one endpoint suffix.
const buildResponsesValidationRequest = (provider: ResolvedProvider): ValidationHttpRequest => {
  let url: string

  try {
    const base = (provider.openaiBaseUrl ?? provider.baseUrl ?? '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1(\/responses)?$/i, '')
    url = new URL(`${base}/v1/responses`).toString()
  } catch {
    throw new Error('Invalid base URL.')
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (provider.key) headers.authorization = `Bearer ${provider.key}`

  return {
    url,
    headers,
    body: JSON.stringify({
      model: provider.model ?? '',
      input: 'ping',
      max_output_tokens: 16
    })
  }
}

// Maps an HTTP status to a validation category. 2xx is success; auth/model errors are distinguished
// so the UI can point the user at the credential vs. the model field.
const classifyStatus = (status: number): ValidationCategory => {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'model-not-found'

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

const isModelNotFoundMessage = (message: string | undefined): boolean =>
  Boolean(
    message &&
    /(?:model\b.*(?:not found|does not exist|unknown|invalid)|(?:not found|unknown|invalid)\b.*model)/i.test(
      message
    )
  )

const hasBridgeProbeToolCall = (bodyText: string): boolean => {
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  let terminated = false

  for (const line of bodyText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      terminated = true
      continue
    }
    if (!data) continue

    try {
      const event = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            tool_calls?: Array<{
              index?: unknown
              id?: unknown
              function?: { name?: unknown; arguments?: unknown }
            }>
          }
          finish_reason?: unknown
        }>
      }
      for (const choice of event.choices ?? []) {
        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
          terminated = true
        }
        for (const delta of choice.delta?.tool_calls ?? []) {
          const index = typeof delta.index === 'number' ? delta.index : 0
          const current = calls.get(index) ?? { id: '', name: '', arguments: '' }
          if (typeof delta.id === 'string') current.id += delta.id
          if (typeof delta.function?.name === 'string') current.name += delta.function.name
          if (typeof delta.function?.arguments === 'string') {
            current.arguments += delta.function.arguments
          }
          calls.set(index, current)
        }
      }
    } catch {
      return false
    }
  }

  return (
    terminated &&
    Array.from(calls.values()).some((call) => {
      if (!call.id || call.name !== BRIDGE_PROBE_TOOL) return false
      try {
        const parsed = JSON.parse(call.arguments)
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      } catch {
        return false
      }
    })
  )
}

const hasResponsesBridgeProbeToolCall = (bodyText: string): boolean => {
  let completed = false
  let found = false

  for (const line of bodyText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data) continue

    try {
      const event = JSON.parse(data) as {
        type?: unknown
        item?: { type?: unknown; name?: unknown; arguments?: unknown }
        response?: { output?: Array<{ type?: unknown; name?: unknown; arguments?: unknown }> }
      }
      if (event.type === 'response.completed') completed = true
      const items = [event.item, ...(event.response?.output ?? [])].filter(Boolean)
      if (
        items.some(
          (item) =>
            item?.type === 'function_call' &&
            item.name === BRIDGE_PROBE_TOOL &&
            typeof item.arguments === 'string'
        )
      ) {
        found = true
      }
    } catch {
      return false
    }
  }

  return completed && found
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
  requireBridgeToolCall?: boolean
  // Runs a one-shot `claude -p "ok"` probe for claude-default providers.
  runClaudeProbe?: () => Promise<ClaudeProbeResult>
}

const validateProviderThroughResponsesBridge = async (
  provider: ResolvedProvider,
  { fetchImpl = fetch, timeoutMs = DEFAULT_VALIDATE_TIMEOUT_MS }: ValidateProviderDeps
): Promise<ValidateProviderResult> => {
  const targetBaseUrl = openAiCompletionsBase(provider)
  if (!targetBaseUrl) return toResult('bad-url', { message: 'Missing base URL.' })

  const bridge = new ResponsesBridge(
    { baseUrl: targetBaseUrl, key: provider.key, model: provider.model },
    fetchImpl
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const connection = await bridge.start()
    const response = await loopbackFetch(`${connection.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${connection.token}`
      },
      body: JSON.stringify(bridgeProbeResponsesBody(provider.model ?? '')),
      signal: controller.signal
    })
    let category = classifyStatus(response.status)
    const bodyText = await response.text()
    const providerMessage = extractProviderErrorMessage(bodyText)

    if ((response.status === 400 || response.status === 404) && providerMessage) {
      category = isModelNotFoundMessage(providerMessage) ? 'model-not-found' : 'unknown'
    }
    if (category !== 'ok') {
      return toResult(category, {
        status: response.status,
        ...(category === 'unknown' ? { message: providerMessage } : {})
      })
    }
    if (!hasResponsesBridgeProbeToolCall(bodyText)) {
      return toResult('unknown', {
        status: response.status,
        message:
          'The provider answered through the bridge, but did not complete the required streaming function tool call.'
      })
    }

    return toResult('ok', { status: response.status })
  } catch (error) {
    return toResult(classifyFetchError(error), {
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    clearTimeout(timer)
    await bridge.close().catch(() => undefined)
  }
}

// Validates a custom provider by hitting its Messages endpoint with a 1-token request.
const validateCustomProvider = async (
  provider: ResolvedProvider,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_VALIDATE_TIMEOUT_MS,
    requireBridgeToolCall = false
  }: ValidateProviderDeps
): Promise<ValidateProviderResult> => {
  if (requireBridgeToolCall) {
    return validateProviderThroughResponsesBridge(provider, {
      fetchImpl,
      timeoutMs,
      requireBridgeToolCall
    })
  }

  let request: ValidationHttpRequest

  try {
    request = buildValidationRequest(provider, requireBridgeToolCall)
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
    let category = classifyStatus(response.status)
    let providerMessage: string | undefined

    if (response.status < 200 || response.status >= 300) {
      providerMessage = await readProviderErrorMessage(response)
      if ((response.status === 400 || response.status === 404) && providerMessage) {
        category = isModelNotFoundMessage(providerMessage) ? 'model-not-found' : 'unknown'
      }
    }

    // Only the catch-all 'unknown' status (402 billing, 429 rate limit, 5xx, …) lacks guidance of its
    // own, so surface the gateway's error text there — whatever it actually says — rather than an
    // assumed meaning. auth/model-not-found already map to targeted advice, so their raw bodies would
    // only muddy it.
    if (category === 'unknown') {
      return toResult(category, {
        status: response.status,
        message: providerMessage
      })
    }

    if (category === 'ok' && request.requiresBridgeToolCall) {
      let bodyText = ''
      try {
        bodyText = await response.text()
      } catch {
        // An unreadable success body cannot prove the bridge contract.
      }
      if (!hasBridgeProbeToolCall(bodyText)) {
        return toResult('unknown', {
          status: response.status,
          message:
            'The provider answered, but did not complete the required streaming function tool call.'
        })
      }
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
  hasBridgeProbeToolCall,
  hasResponsesBridgeProbeToolCall,
  classifyFetchError,
  classifyStatus,
  extractProviderErrorMessage,
  validateProvider
}
