import type { TFunction } from 'i18next'

import type { ValidateProviderResult, ValidationCategory } from '../../../../shared/settings'

// Maps a validation category to its English message. Centralized so the wizard and the settings
// page phrase failures identically.
const CATEGORY_KEYS = {
  ok: 'Connection succeeded.',
  network: 'Could not reach the endpoint. Check your network and base URL.',
  auth: 'Authentication failed. Check the API key.',
  'model-not-found': 'The model was rejected. Check the model name for this gateway.',
  'bad-url': 'The base URL is invalid. Enter a full URL like https://gateway.example/v1.',
  timeout: 'The request timed out and was stopped.',
  incompatible: "This provider isn't compatible with the active agent framework.",
  'server-error': 'The gateway or upstream service is temporarily unavailable. Try again later.',
  unknown: 'Validation failed for an unknown reason.'
} as const satisfies Record<ValidationCategory, string>

// Categories whose generic text benefits from the specific error/probe message (a timeout or network
// failure). Auth/model/bad-url already carry actionable text.
const MESSAGE_CATEGORIES = new Set<ValidationCategory>([
  'network',
  'timeout',
  'server-error',
  'unknown'
])

// Produces the message to show for a validation result, appending a specific server/probe message when
// the category is generic and an HTTP status when one is available.
//
// Takes `t` rather than reaching for the i18next singleton so it stays a pure function of (result,
// locale) and a test can pin the language. Gateway-supplied `message` text passes through verbatim in
// every locale — it comes from the provider, not from us, so there is nothing to translate.
const describeValidation = (result: ValidateProviderResult, t: TFunction): string => {
  const base = t(CATEGORY_KEYS[result.category])

  // Some gateways return their own actionable auth text; prefer it over the generic HTTP 401/403 copy.
  if (result.category === 'auth' && result.message) {
    return result.message
  }

  // An incompatible pairing carries the specific route mismatch (which API format the framework needs
  // vs. what this provider speaks); surface it instead of the generic fallback.
  if (result.category === 'incompatible' && result.message) {
    return result.message
  }

  // A gateway that rejected the probe with its own error text (e.g. "Insufficient Balance" on a
  // billing 402) has already told us the reason — surface it instead of the generic "unknown" copy.
  if (result.category === 'unknown' && result.message) {
    return result.status
      ? t('{{base}} (HTTP {{status}})', { base: result.message, status: result.status })
      : result.message
  }

  if (result.message && MESSAGE_CATEGORIES.has(result.category)) {
    return t('{{base}} ({{detail}})', { base, detail: result.message })
  }

  if (result.status) {
    return t('{{base}} (HTTP {{status}})', { base, status: result.status })
  }

  return base
}

export { CATEGORY_KEYS, describeValidation }
