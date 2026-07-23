import { isMediaOverflowError } from './media-overflow'

// Classifies a failed run into "expected" (keep the message, no report button) vs "unknown/reportable"
// (an opaque or internal failure worth a GitHub issue). The primary signal is STRUCTURAL, not textual:
// a model/provider failure is tagged `providerError` on the error event at the ACP layer (runtime.ts,
// via isProviderPromptError) and persisted as `session.errorReportable = false`. Text is NEVER used to
// guess whether a failure came from the provider — that was fragile and repeatedly swallowed genuine
// app errors that merely mentioned a provider word.
//
// This module owns only the SECONDARY, text-based tier: recognizing the app's OWN crafted reminder
// strings (which we author, so an exact-match set is reliable) so their report button is hidden even
// on the paths that don't carry the structural flag (a persisted pre-flag session, or a renderer-side
// failRun call). It is a pure, dependency-light leaf module (like media-overflow.ts) usable from both
// processes. Anything it does not recognize stays reportable — including opaque provider text — so the
// structural flag, not this text tier, is what suppresses ordinary provider errors.

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
// actionable reminder, the reworded provider not-found, or a request-size overflow the app auto-
// recovers — so the report button is hidden even without the structural `providerError` flag (an old
// persisted session, or a renderer-side failRun). Recognition is by EXACT crafted string / known
// prefix only; it deliberately does NOT try to recognize arbitrary provider error text (that is the
// structural flag's job), so an unknown/opaque failure it doesn't author stays reportable.
export const isExpectedRunFailure = (error: string | null | undefined): boolean => {
  const message = error?.trim()

  // An empty message is itself an unknown failure (a run failed with nothing to explain it).
  if (!message) return false

  if (EXPECTED_RUN_FAILURE_MESSAGES.has(message)) return true
  // The reworded provider not-found (a model-config problem the user fixes in Settings, not a bug).
  if (message.startsWith(PROVIDER_RESOURCE_NOT_FOUND_PREFIX)) return true
  // Model↔framework incompatibility raised at spawn/createSession. The main-side message names the
  // framework (`…compatible with Codex.`) while the resume path rewords it to a generic form; both
  // share this leading phrase, so one prefix covers the createSession path (which is not reworded) and
  // any framework name. It is app-authored setup guidance ("Open Settings → Model"), not a bug.
  if (message.startsWith(ACTIVE_MODEL_INCOMPATIBLE_PREFIX)) return true
  // A request-size overflow the app auto-recovers from — never a reportable bug.
  return isMediaOverflowError(message)
}

// Whether a run failure should offer the "Report error → open a GitHub issue" affordance. True only for
// unknown/opaque failures; recognized (expected) ones return false so they are not reported as bugs.
export const isReportableRunFailure = (error: string | null | undefined): boolean =>
  !isExpectedRunFailure(error)
