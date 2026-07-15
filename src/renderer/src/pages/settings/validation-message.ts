import type { ValidateProviderResult, ValidationCategory } from '../../../../shared/settings'

// Maps a validation category to an actionable, user-facing message. Centralized so the wizard and the
// settings page phrase failures identically.
const CATEGORY_MESSAGES: Record<ValidationCategory, string> = {
  ok: 'Connection succeeded.',
  network: 'Could not reach the endpoint. Check your network and base URL.',
  auth: 'Authentication failed. Check the API key.',
  'model-not-found': 'The model was rejected. Check the model name for this gateway.',
  'bad-url': 'The base URL is invalid. Enter a full URL like https://gateway.example/v1.',
  timeout: 'The request timed out and was stopped.',
  unknown: 'Validation failed for an unknown reason.'
}

// Categories whose generic text benefits from the specific error/probe message (e.g. a local-Claude
// timeout or network failure). Auth/model/bad-url already carry actionable text.
const MESSAGE_CATEGORIES = new Set<ValidationCategory>(['network', 'timeout', 'unknown'])

// Produces the message to show for a validation result, appending a specific server/probe message when
// the category is generic and an HTTP status when one is available.
const describeValidation = (result: ValidateProviderResult): string => {
  const base = CATEGORY_MESSAGES[result.category]

  // Local Claude has no API-key field. Its subprocess probe supplies a controlled, actionable auth
  // message, so prefer that over the generic gateway wording used for HTTP 401/403 responses.
  if (result.category === 'auth' && result.message) {
    return result.message
  }

  // A gateway that rejected the probe with its own error text (e.g. "Insufficient Balance" on a
  // billing 402) has already told us the reason — surface it instead of the generic "unknown" copy.
  if (result.category === 'unknown' && result.message) {
    return result.status ? `${result.message} (HTTP ${result.status})` : result.message
  }

  if (result.message && MESSAGE_CATEGORIES.has(result.category)) {
    return `${base} (${result.message})`
  }

  if (result.status) {
    return `${base} (HTTP ${result.status})`
  }

  return base
}

export { CATEGORY_MESSAGES, describeValidation }
