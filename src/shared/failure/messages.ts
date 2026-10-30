export const INTERRUPTED_TURN_ERROR = 'This turn was interrupted. Resume to continue.'

export { CLAUDE_CLI_INCOMPATIBLE_MESSAGE } from '../claude-runtime'
export const RESUME_WORKSPACE_MISSING_MESSAGE =
  'Session workspace is missing; start a new conversation.'

export const RESUME_TIMED_OUT_MESSAGE = 'Agent session resume timed out; click Resume to try again.'

export const RESUME_UNSUPPORTED_MESSAGE =
  'This agent build cannot resume sessions; start a new conversation.'

export const RESUME_RECONNECT_FAILED_MESSAGE =
  'Could not reconnect to the agent; check it is installed, then click Resume to retry.'

export const RESUME_MODEL_INCOMPATIBLE_MESSAGE =
  "The active model isn't compatible with this agent framework. Open Settings → Model to pick a compatible model or switch frameworks."

export const IMAGE_REPLAY_UNSUPPORTED_MESSAGE =
  'This conversation needs image replay, but the selected model does not support image input.'

export const SPECIALIST_CAPABILITY_READ_FAILED_MESSAGE =
  'The Specialist Skills or Connectors could not be loaded. Try sending again.'

export const VISION_MODEL_NOT_CONFIGURED_MESSAGE =
  "The selected model doesn't support images. Configure a Vision model in Settings > Model to enable image support."

export const VISION_IMAGE_TOO_LARGE_MESSAGE =
  'The attached image is too large to prepare for the Vision model.'

export const VISION_IMAGE_INVALID_MESSAGE = 'The attached image is invalid.'

export const VISION_IMAGE_BUDGET_MESSAGE =
  'The current images exceed the Vision evidence request budget.'

export const VISION_EVIDENCE_BUDGET_MESSAGE =
  'The current Vision evidence exceeds the request budget.'

export const VISION_EVIDENCE_INVALID_MESSAGE = 'The Vision model returned invalid image evidence.'

export const NO_ACTIVE_PROVIDER_MESSAGE =
  'No active model provider is configured. Configure one in settings.'

export const CLAUDE_EXECUTABLE_MISSING_MESSAGE =
  'Claude executable is not configured. Complete onboarding in settings.'

export const CODEX_BRIDGE_UNSUPPORTED_MESSAGE =
  'The active model is not supported over the Codex Chat Completions bridge. Pick another model in Settings → Model.'

export const CONFIGURED_MODEL_UNAVAILABLE_PREFIX =
  'The configured model is no longer available from provider'

export const buildConfiguredModelUnavailableMessage = (
  model: string,
  providerName: string
): string =>
  `${CONFIGURED_MODEL_UNAVAILABLE_PREFIX} "${providerName}": "${model}". Pick another model in Settings → Model.`

export const ACTIVE_MODEL_INCOMPATIBLE_PREFIX = "The active model isn't compatible with"

export const buildActiveModelIncompatibleMessage = (frameworkDisplayName: string): string =>
  `${ACTIVE_MODEL_INCOMPATIBLE_PREFIX} ${frameworkDisplayName}. Open Settings → Model to pick a compatible model or switch the agent framework.`

export const PROVIDER_RESOURCE_NOT_FOUND_PREFIX =
  'The model provider could not find the requested resource'

export const PROVIDER_CONNECTION_FAILED_PREFIX = 'Could not connect to the model provider'

export const unwrapIpcErrorDetail = (message: string): string =>
  message
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error(?::\s*|$)/i, '')
    .trim()
