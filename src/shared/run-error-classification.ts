import { isMediaOverflowError } from './media-overflow'
import { isUnsupportedCodexAcpVersionError } from './codex-runtime'

// Classifies a failed run into "expected" (keep the message, no report button) vs "unknown/reportable"
// (an opaque or internal failure worth a GitHub issue). The primary signal is STRUCTURAL, not textual:
// a model/provider failure is tagged `providerError` on the error event at the ACP layer (runtime.ts,
// via isProviderPromptError) and persisted as `session.errorReportable = false`. Arbitrary provider
// wording is not guessed from text — that was fragile and repeatedly swallowed genuine app errors.
//
// This module owns only the SECONDARY, text-based tier: recognizing the app's OWN crafted reminder
// strings (which we author, so an exact-match set is reliable) so their report button is hidden even
// on the paths that don't carry the structural flag (a persisted pre-flag session, or a renderer-side
// failRun call). One additional fixed Claude Code wrapper is recognized here (`API Error: Unable to
// connect to API`) so historical sessions and createSession failRun hide Report without rewriting
// stored records. Arbitrary provider text is still not guessed. It is a pure, dependency-light leaf
// module (like media-overflow.ts) usable from both processes.

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

// App-owned Vision relay failures cross Electron's invoke boundary as Error text, so public error
// identity is kept in shared constants instead of depending on non-enumerable Error properties.
export const VISION_MODEL_NOT_CONFIGURED_MESSAGE =
  "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."
const LEGACY_VISION_MODEL_NOT_CONFIGURED_MESSAGE =
  'Configure a Vision model in Settings > Model before sending images to this model.'
export const VISION_IMAGE_TOO_LARGE_MESSAGE =
  'The attached image is too large to prepare for the Vision model.'
export const VISION_IMAGE_INVALID_MESSAGE = 'The attached image is invalid.'
export const VISION_IMAGE_BUDGET_MESSAGE =
  'The current images exceed the Vision evidence request budget.'
export const VISION_EVIDENCE_BUDGET_MESSAGE =
  'The current Vision evidence exceeds the request budget.'
export const VISION_EVIDENCE_INVALID_MESSAGE = 'The Vision model returned invalid image evidence.'

const VISION_RUN_FAILURE_MESSAGES = [
  VISION_MODEL_NOT_CONFIGURED_MESSAGE,
  VISION_IMAGE_TOO_LARGE_MESSAGE,
  VISION_IMAGE_INVALID_MESSAGE,
  VISION_IMAGE_BUDGET_MESSAGE,
  VISION_EVIDENCE_BUDGET_MESSAGE,
  VISION_EVIDENCE_INVALID_MESSAGE
] as const

export type VisionRunFailureMessage = (typeof VISION_RUN_FAILURE_MESSAGES)[number]

export const visionRunFailureMessage = (
  error: string | null | undefined
): VisionRunFailureMessage | undefined => {
  const message = error?.trim()
  if (!message) return undefined
  if (
    message === LEGACY_VISION_MODEL_NOT_CONFIGURED_MESSAGE ||
    message.endsWith(`Error: ${LEGACY_VISION_MODEL_NOT_CONFIGURED_MESSAGE}`)
  ) {
    return VISION_MODEL_NOT_CONFIGURED_MESSAGE
  }
  return VISION_RUN_FAILURE_MESSAGES.find(
    (candidate) => message === candidate || message.endsWith(`Error: ${candidate}`)
  )
}

// App-authored agent-setup guidance thrown by settings/service.ts:resolveActiveAgentBackend at spawn
// time — surfaced when a conversation FAILS TO START (createSession), which does not route through the
// resume-path softener. All three are wrong-config the user fixes in Settings → Model, not app bugs, so
// they must hide the report button. service.ts builds its throws from these SAME constants/builder so
// the text can never drift from what the classifier recognizes.
export const NO_ACTIVE_PROVIDER_MESSAGE =
  'No active model provider is configured. Configure one in settings.'
export const CLAUDE_EXECUTABLE_MISSING_MESSAGE =
  'Claude executable is not configured. Complete onboarding in settings.'
export const CODEX_BRIDGE_UNSUPPORTED_MESSAGE =
  'The active model is not supported over the Codex Chat Completions bridge. Pick another model in Settings → Model.'
// The model↔framework mismatch message interpolates the framework name, so the classifier matches on
// this leading, framework-independent phrase. It also covers the resume-path RESUME_MODEL_INCOMPATIBLE
// wording (both begin here), so either surfacing is recognized.
export const ACTIVE_MODEL_INCOMPATIBLE_PREFIX = "The active model isn't compatible with"
export const buildActiveModelIncompatibleMessage = (frameworkDisplayName: string): string =>
  `${ACTIVE_MODEL_INCOMPATIBLE_PREFIX} ${frameworkDisplayName}. Open Settings → Model to pick a compatible model or switch the agent framework.`

// Stable prefix of the provider "resource not found" message produced by main's describePromptError.
// That message interpolates the model name and the provider's own response, so the classifier matches
// on this leading, model-independent phrase. prompt-error.ts builds its message from the SAME constant
// so the two can never drift (a drift-guard test feeds describePromptError's real output through the
// classifier).
export const PROVIDER_RESOURCE_NOT_FOUND_PREFIX =
  'The model provider could not find the requested resource'
export const PROVIDER_CONNECTION_FAILED_PREFIX = 'Could not connect to the model provider'

// Claude Code's fixed unreachable-API wrapper. Recognized here so createSession failRun and persisted
// pre-flag sessions hide Report without a stored-schema migration. Match the distinctive
// `API Error: Unable to connect to API` phrase only — not a generic "connection" or "connect" word.
const CLAUDE_API_CONNECTION_FAILURE_PATTERN = /(?:^|:\s*)api error:\s*unable to connect to api\b/i

export const isClaudeApiConnectionFailure = (error: string | null | undefined): boolean => {
  const message = error?.trim()
  if (!message) return false
  return CLAUDE_API_CONNECTION_FAILURE_PATTERN.test(message)
}

// The exact app-crafted messages an equality check recognizes as expected.
const EXPECTED_RUN_FAILURE_MESSAGES = new Set<string>([
  RESUME_WORKSPACE_MISSING_MESSAGE,
  RESUME_TIMED_OUT_MESSAGE,
  RESUME_UNSUPPORTED_MESSAGE,
  RESUME_RECONNECT_FAILED_MESSAGE,
  RESUME_MODEL_INCOMPATIBLE_MESSAGE,
  IMAGE_REPLAY_UNSUPPORTED_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE,
  CLAUDE_EXECUTABLE_MISSING_MESSAGE,
  CODEX_BRIDGE_UNSUPPORTED_MESSAGE
])

// Whether a run failure is one the app itself already surfaced with a purpose — an app-crafted
// actionable reminder, the reworded provider not-found, Claude Code's fixed unreachable-API wrapper,
// or a request-size overflow the app auto-recovers — so the report button is hidden even without the
// structural `providerError` flag (an old persisted session, or a renderer-side failRun). Recognition
// is by EXACT crafted string / known prefix only; it deliberately does NOT try to recognize arbitrary
// provider error text (that is the structural flag's job), so an unknown/opaque failure it doesn't
// author stays reportable.
export const isExpectedRunFailure = (error: string | null | undefined): boolean => {
  const message = error?.trim()

  // An empty message is itself an unknown failure (a run failed with nothing to explain it).
  if (!message) return false

  if (EXPECTED_RUN_FAILURE_MESSAGES.has(message)) return true
  if (visionRunFailureMessage(message)) return true
  // An outdated app-managed adapter is an actionable Settings problem, not a reportable app bug.
  if (isUnsupportedCodexAcpVersionError(message)) return true
  // The reworded provider not-found (a model-config problem the user fixes in Settings, not a bug).
  if (message.startsWith(PROVIDER_RESOURCE_NOT_FOUND_PREFIX)) return true
  // The actionable provider connection reminder produced for Claude Code connection failures.
  if (message.startsWith(PROVIDER_CONNECTION_FAILED_PREFIX)) return true
  // Model↔framework incompatibility raised at spawn/createSession. The main-side message names the
  // framework (`…compatible with Codex.`) while the resume path rewords it to a generic form; both
  // share this leading phrase, so one prefix covers the createSession path (which is not reworded) and
  // any framework name. It is app-authored setup guidance ("Open Settings → Model"), not a bug.
  if (message.startsWith(ACTIVE_MODEL_INCOMPATIBLE_PREFIX)) return true
  // Claude Code's fixed unreachable-API wrapper (createSession / persisted pre-flag sessions).
  if (isClaudeApiConnectionFailure(message)) return true
  // A request-size overflow the app auto-recovers from — never a reportable bug.
  return isMediaOverflowError(message)
}

// Whether a run failure should offer the "Report error → open a GitHub issue" affordance. True only for
// unknown/opaque failures; recognized (expected) ones return false so they are not reported as bugs.
export const isReportableRunFailure = (error: string | null | undefined): boolean =>
  !isExpectedRunFailure(error)
