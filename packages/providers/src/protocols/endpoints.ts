// Normalizes a user-entered Anthropic-compatible gateway base URL into the value the claude client
// expects for ANTHROPIC_BASE_URL. Both the runtime client and the validation probe append
// `/v1/messages`, so a base URL that already carries a trailing `/v1` (or the full `/v1/messages`
// endpoint) would resolve to `.../v1/v1/messages` → 404. Stripping it here keeps whatever the user
// pastes — the bare root, the `.../v1` base, or the full endpoint — resolving to the same correct URL.

// Scan once: an unanchored trailing-slash regex retries each slash in a long non-matching run.
const stripTrailingSlashes = (value: string): string => {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

const trimTrailingSlash = (value: string): string => stripTrailingSlashes(value.trim())

// Trailing slashes are removed before matching this bounded version/endpoint suffix.
const REDUNDANT_SUFFIX = /\/v1(\/messages)?$/i

const normalizeMessagesRootUrl = (baseUrl: string): string => {
  const trimmed = trimTrailingSlash(baseUrl)

  return trimmed.replace(REDUNDANT_SUFFIX, '')
}

type ChatCompletionsEndpointOptions = { chatCompletionsBaseUrl?: string; baseUrl?: string }

// Appends a leading-slash path segment to a URL's path, preserving query/hash and collapsing double
// slashes. Falls back to plain concatenation only for a non-parseable base.
const appendPath = (base: string, suffix: string): string => {
  const trimmed = base.trim()
  try {
    const url = new URL(trimmed)
    url.pathname = `${stripTrailingSlashes(url.pathname)}${suffix}`.replace(/\/{2,}/g, '/')
    return url.toString()
  } catch {
    return `${trimTrailingSlash(trimmed)}${suffix}`
  }
}

// The Anthropic AI SDK base used by OpenCode. Unlike Claude Code, which appends `/v1/messages`,
// the SDK appends only `/messages`; give it a base ending in exactly one `/v1` so both runtimes hit
// the same endpoint as the provider validator.
const resolveMessagesBaseUrl = (baseUrl: string): string =>
  appendPath(normalizeMessagesRootUrl(baseUrl), '/v1')

// Appends `/chat/completions` to an already-resolved Chat Completions base (see resolveChatCompletionsBaseUrl).
const appendChatCompletionsPath = (base: string): string => appendPath(base, '/chat/completions')

// Strips a redundant trailing `/v1` or `/v1/chat/completions` a user may have pasted into a custom
// gateway root, editing the path so any query/hash survive.
const stripRedundantChatCompletionsSuffix = (base: string): string => {
  const trimmed = base.trim()
  try {
    const url = new URL(trimmed)
    url.pathname = stripTrailingSlashes(url.pathname).replace(/\/v1(\/chat\/completions)?$/i, '')
    return trimTrailingSlash(url.toString())
  } catch {
    return trimTrailingSlash(trimmed).replace(/\/v1(\/chat\/completions)?$/i, '')
  }
}

// The Chat Completions base a client appends `/chat/completions` to. Two shapes, distinguished by the provider,
// NOT by guessing from the path (a custom `/proxy` prefix is indistinguishable from GLM's `/api/paas/v4`
// as a string):
//  - Official vendors publish an exact, version-carrying base (chatCompletionsBaseUrl): GLM `/api/paas/v4`,
//    DeepSeek/Kimi/Xiaomi `/v1`, OpenRouter `/api/v1`. Used verbatim.
//  - A custom gateway's baseUrl is a user-entered ROOT (the form promises "trailing /v1 is added
//    automatically"), so its endpoint is `<root>/v1/chat/completions`; a redundant pasted /v1 is
//    collapsed first.
// Returns undefined when neither base is set.
const resolveChatCompletionsBaseUrl = (
  provider: ChatCompletionsEndpointOptions
): string | undefined => {
  if (provider.chatCompletionsBaseUrl?.trim())
    return trimTrailingSlash(provider.chatCompletionsBaseUrl)
  if (!provider.baseUrl?.trim()) return undefined
  return appendPath(stripRedundantChatCompletionsSuffix(provider.baseUrl), '/v1')
}

// Complete URLs preserve gateway query parameters while appending to the pathname.
const resolveMessagesUrl = (baseUrl: string): string => {
  try {
    const url = new URL(baseUrl.trim())
    url.pathname = `${normalizeMessagesRootUrl(url.pathname)}/v1/messages`
    return url.toString()
  } catch {
    return appendPath(resolveMessagesBaseUrl(baseUrl), '/messages')
  }
}

const resolveResponsesUrl = (provider: ChatCompletionsEndpointOptions): string | undefined => {
  const raw = provider.chatCompletionsBaseUrl || provider.baseUrl
  if (!raw?.trim()) return undefined
  try {
    const url = new URL(raw.trim())
    url.pathname = stripTrailingSlashes(url.pathname).replace(/\/responses$/i, '')
    // Official bases carry their exact version; custom roots follow the same /v1 contract as Chat.
    const base = resolveChatCompletionsBaseUrl(
      provider.chatCompletionsBaseUrl
        ? { chatCompletionsBaseUrl: url.toString() }
        : { baseUrl: url.toString() }
    )!
    return appendPath(base, '/responses')
  } catch {
    return undefined
  }
}

// The complete Chat Completions endpoint URL.
const resolveChatCompletionsUrl = (
  provider: ChatCompletionsEndpointOptions
): string | undefined => {
  const base = resolveChatCompletionsBaseUrl(provider)
  return base === undefined ? undefined : appendChatCompletionsPath(base)
}

export {
  resolveMessagesBaseUrl,
  resolveMessagesUrl,
  resolveResponsesUrl,
  normalizeMessagesRootUrl,
  appendChatCompletionsPath,
  resolveChatCompletionsBaseUrl,
  resolveChatCompletionsUrl
}
