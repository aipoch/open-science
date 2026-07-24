// Normalizes a user-entered Anthropic-compatible gateway base URL into the value the claude client
// expects for ANTHROPIC_BASE_URL. Both the runtime client and the validation probe append
// `/v1/messages`, so a base URL that already carries a trailing `/v1` (or the full `/v1/messages`
// endpoint) would resolve to `.../v1/v1/messages` → 404. Stripping it here keeps whatever the user
// pastes — the bare root, the `.../v1` base, or the full endpoint — resolving to the same correct URL.

// Matches a trailing `/v1` or `/v1/messages` segment (case-insensitive), with optional trailing slash.
const REDUNDANT_SUFFIX = /\/v1(\/messages)?\/*$/i

const normalizeAnthropicBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')

  return trimmed.replace(REDUNDANT_SUFFIX, '')
}

type OpenAiProviderBase = { openaiBaseUrl?: string; baseUrl?: string }

const trimTrailingSlash = (value: string): string => value.trim().replace(/\/+$/, '')

// Appends a leading-slash path segment to a URL's path, preserving query/hash and collapsing double
// slashes. Falls back to plain concatenation only for a non-parseable base.
const appendPath = (base: string, suffix: string): string => {
  const trimmed = base.trim()
  try {
    const url = new URL(trimmed)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`.replace(/\/{2,}/g, '/')
    return url.toString()
  } catch {
    return `${trimTrailingSlash(trimmed)}${suffix}`
  }
}

// The Anthropic AI SDK base used by OpenCode. Unlike Claude Code, which appends `/v1/messages`,
// the SDK appends only `/messages`; give it a base ending in exactly one `/v1` so both runtimes hit
// the same endpoint as the provider validator.
const anthropicMessagesBase = (baseUrl: string): string =>
  appendPath(normalizeAnthropicBaseUrl(baseUrl), '/v1')

// Appends `/chat/completions` to an already-resolved OpenAI base (see openAiCompletionsBase).
const appendChatCompletions = (base: string): string => appendPath(base, '/chat/completions')

// Strips a redundant trailing `/v1` or `/v1/chat/completions` a user may have pasted into a custom
// gateway root, editing the path so any query/hash survive.
const stripRedundantOpenAiSuffix = (base: string): string => {
  const trimmed = base.trim()
  try {
    const url = new URL(trimmed)
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1(\/chat\/completions)?$/i, '')
    return trimTrailingSlash(url.toString())
  } catch {
    return trimTrailingSlash(trimmed).replace(/\/v1(\/chat\/completions)?$/i, '')
  }
}

// The OpenAI base a client appends `/chat/completions` to. Two shapes, distinguished by the provider,
// NOT by guessing from the path (a custom `/proxy` prefix is indistinguishable from GLM's `/api/paas/v4`
// as a string):
//  - Official vendors publish an exact, version-carrying base (openaiBaseUrl): GLM `/api/paas/v4`,
//    DeepSeek/Kimi/Xiaomi `/v1`, OpenRouter `/api/v1`. Used verbatim.
//  - A custom gateway's baseUrl is a user-entered ROOT (the form promises "trailing /v1 is added
//    automatically"), so its endpoint is `<root>/v1/chat/completions`; a redundant pasted /v1 is
//    collapsed first.
// Returns undefined when neither base is set.
const openAiCompletionsBase = (provider: OpenAiProviderBase): string | undefined => {
  if (provider.openaiBaseUrl?.trim()) return trimTrailingSlash(provider.openaiBaseUrl)
  if (!provider.baseUrl?.trim()) return undefined
  return appendPath(stripRedundantOpenAiSuffix(provider.baseUrl), '/v1')
}

// The full OpenAI `/chat/completions` endpoint URL for an OpenAI-compatible provider.
const openAiChatCompletionsUrl = (provider: OpenAiProviderBase): string | undefined => {
  const base = openAiCompletionsBase(provider)
  return base === undefined ? undefined : appendChatCompletions(base)
}

export {
  anthropicMessagesBase,
  normalizeAnthropicBaseUrl,
  appendChatCompletions,
  openAiCompletionsBase,
  openAiChatCompletionsUrl
}
