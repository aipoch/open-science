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

export { normalizeAnthropicBaseUrl }
