import { isMediaOverflowError } from './media-overflow'

// Classifies a failed run's error text into "expected" (the app already recognized the failure and
// showed actionable guidance, or the provider returned a well-understood error) vs "unknown" (an
// opaque or internal failure worth a GitHub issue). Only unknown failures get the "Report error"
// affordance; expected ones keep their message but drop the report button, so the issue tracker is
// not flooded with wrong-config / provider-side problems the user is meant to fix themselves.
//
// Kept as a pure, dependency-light leaf module (like media-overflow.ts) so both the main process
// (the error producers) and the renderer (the report gate) reference the SAME constants and patterns,
// and the branch matrix is unit-testable. The persisted `session.error` string is classified at
// display time, so recognition survives a reload without a schema change.

// App-crafted resume-failure messages (useWorkspaceAgentRuntime.getResumeFailureMessage). Each is the
// actionable text the app writes when it recognizes a specific resume cause. The generic
// "Agent session resume failed: …" fallback is deliberately NOT here — an unrecognized resume cause
// stays reportable.
export const RESUME_WORKSPACE_MISSING_MESSAGE =
  'Session workspace is missing; start a new conversation.'
export const RESUME_TIMED_OUT_MESSAGE = 'Agent session resume timed out; click Resume to try again.'
export const RESUME_UNSUPPORTED_MESSAGE =
  'This agent build cannot resume sessions; start a new conversation.'
export const RESUME_RECONNECT_FAILED_MESSAGE =
  'Could not reconnect to the agent; check it is installed, then click Resume to retry.'
export const RESUME_MODEL_INCOMPATIBLE_MESSAGE =
  "The active model isn't compatible with this agent framework. Open Settings → Model to pick a compatible model or switch frameworks."

// A conversation that needs image replay on a text-only model (useWorkspaceAgentRuntime).
export const IMAGE_REPLAY_UNSUPPORTED_MESSAGE =
  'This conversation needs image replay, but the selected model does not support image input.'

// Stable prefix of the provider "resource not found" message produced by main's describePromptError.
// That message interpolates the model name and the provider's own response, so the classifier matches
// on this leading, model-independent phrase. prompt-error.ts builds its message from the SAME constant
// so the two can never drift (a drift-guard test feeds describePromptError's real output through the
// classifier).
export const PROVIDER_RESOURCE_NOT_FOUND_PREFIX =
  'The model provider could not find the requested resource'

// The exact app-crafted messages an equality check recognizes as expected.
const EXPECTED_RUN_FAILURE_MESSAGES = new Set<string>([
  RESUME_WORKSPACE_MISSING_MESSAGE,
  RESUME_TIMED_OUT_MESSAGE,
  RESUME_UNSUPPORTED_MESSAGE,
  RESUME_RECONNECT_FAILED_MESSAGE,
  RESUME_MODEL_INCOMPATIBLE_MESSAGE,
  IMAGE_REPLAY_UNSUPPORTED_MESSAGE
])

// Recognizes provider-side API errors that are the user's or provider's to resolve, not app bugs:
// bad/absent credentials, rate limits, exhausted quota or billing, and provider "overloaded/
// unavailable" responses. Matching stays language-agnostic (no localized message bodies) but is
// deliberately anchored to signals that DO NOT occur in ordinary app-error prose, so a genuine app
// failure that merely mentions one of these words ("EACCES: permission denied", "Failed to parse rate
// limit configuration", "Record 503 could not be decoded") is never swallowed:
//   - Structured error-type slugs in their exact underscore form, each \b-bounded (a provider payload
//     field, e.g. `authentication_error`) — a bare "permission denied"/"rate limit" with spaces is NOT
//     a slug, and a longer identifier like `rate_limiter`/`permission_denied_handler` does not match.
//   - An auth/rate/5xx status code (401|403|429|5xx, not any 3-digit number) carrying an explicit
//     `HTTP`/`status` marker, or a status code immediately followed by its canonical reason phrase.
//   - A few multi-word HTTP reason phrases, and narrow billing/quota phrases, unmistakable on their own.
// Resource-not-found and request-size overflow are recognized separately (their own dedicated paths).
const PROVIDER_ERROR_PATTERN = new RegExp(
  [
    // Structured provider error-type slugs, each bounded by \b so a longer identifier that merely
    // starts with one (e.g. `rate_limiter`, `permission_denied_handler`) is NOT matched. The trailing
    // \b sits at the end of the slug's own word chars — `_` is a word char, so `permission_denied\b`
    // cannot fire inside `permission_denied_handler`.
    '\\bauthentication_error\\b',
    '\\binvalid_api_key\\b',
    '\\bpermission_denied\\b',
    '\\brate_limit(?:ed|_error|_exceeded)?\\b',
    '\\binsufficient_quota\\b',
    '\\bquota_exceeded\\b',
    '\\bbilling_(?:hard_limit|not_active)\\b',
    '\\boverloaded_error\\b',
    // A provider auth/rate/5xx status code carrying an explicit HTTP/status marker. Restricted to those
    // families (not any 3-digit number) so an incidental "status 200"/"expected status 404" in an app
    // error is not swallowed. 5\d\d covers every 5xx.
    '(?:\\bhttp\\b|\\bstatus(?:\\s*code)?\\b)[\\s:]*(?:401|403|429|5\\d\\d)\\b',
    // A status code immediately followed by its canonical reason phrase.
    '\\b(?:401|403|429|500|502|503|504)\\s+(?:unauthorized|forbidden|too\\s+many\\s+requests|internal\\s+server\\s+error|bad\\s+gateway|service\\s+unavailable|gateway\\s+time-?out)\\b',
    // Unmistakable multi-word HTTP reason phrases on their own.
    'too\\s+many\\s+requests',
    'service\\s+unavailable',
    'bad\\s+gateway',
    'gateway\\s+time-?out',
    // Narrow billing/quota reason phrases (a bare "billing" is too broad — it recurs in app prose).
    'billing\\s+(?:plan|account|period|issue|hard[_\\s-]?limit)',
    'no\\s+remaining\\s+credit',
    'insufficient\\s+(?:credit|balance|funds)'
  ].join('|'),
  'i'
)

// Whether a run failure is one the app already recognizes — either app-crafted actionable guidance or
// a well-understood provider error. These keep their message but hide the "Report error" button.
export const isExpectedRunFailure = (error: string | null | undefined): boolean => {
  const message = error?.trim()

  // An empty message is itself an unknown failure (a run failed with nothing to explain it).
  if (!message) return false

  if (EXPECTED_RUN_FAILURE_MESSAGES.has(message)) return true
  if (message.startsWith(PROVIDER_RESOURCE_NOT_FOUND_PREFIX)) return true
  if (isMediaOverflowError(message)) return true

  return PROVIDER_ERROR_PATTERN.test(message)
}

// Whether a run failure should offer the "Report error → open a GitHub issue" affordance. True only for
// unknown/opaque failures; recognized (expected) ones return false so they are not reported as bugs.
export const isReportableRunFailure = (error: string | null | undefined): boolean =>
  !isExpectedRunFailure(error)
