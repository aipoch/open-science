import { ApplicationCommandError } from './application-command-contract'
import { LAB_PROVIDER_ID } from './lab'
import { providerAllowsAnonymousAccess, isOfficialOpenAiResponsesBase } from './provider-url-policy'
export { DEFAULT_AGENT_FRAMEWORK_ID } from './agent-framework-id'
export { LAB_PROVIDER_ID }
import type { AgentFrameworkId, AgentModelRoute } from './agent-framework-id'
import type { ModelProtocol, OfficialVendorId } from '@aipoch/providers'
import type { ReasoningEffort } from './model-preference-contract'
import type {
  ProviderType,
  CodexSubscriptionAuthMode,
  ClaudeSubscriptionProviderId,
  ProviderValidationTarget,
  ProviderValidationFailure,
  SubagentModelConfiguration,
  ReviewerModelConfiguration,
  SessionDetailsModelConfiguration,
  AppIconVariant,
  AppIconVariantInfo,
  SettingsSnapshot,
  ClaudeInstallSourceInfo,
  NodeInstallHint
} from './settings-types'

// Runtime values shared by the Main and renderer Settings contract.

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

const APP_ICON_VARIANTS: readonly AppIconVariant[] = ['light', 'dark']

// Settings file schema version; bumped when the on-disk shape changes. v2 adds official-vendor
// providers (vendorId/region) and a per-selection activeModel alongside activeProviderId.
export const SETTINGS_FILE_VERSION = 2

// Stored Codex subscriptions share one runtime type, while renderer surfaces still need the setup
// choice. Legacy codex-shared views have no discriminator, so their type remains the fallback.
export const resolveCodexSubscriptionType = (provider: {
  type: ProviderType
  codexAuthMode?: CodexSubscriptionAuthMode
}): 'codex-shared' | 'codex-isolated' =>
  provider.codexAuthMode === 'imported' ||
  (provider.codexAuthMode === undefined && provider.type === 'codex-shared')
    ? 'codex-shared'
    : 'codex-isolated'

export const CODEX_SHARED_PROVIDER_ID = 'builtin-codex-shared'

export const CODEX_ISOLATED_PROVIDER_ID = 'builtin-codex-isolated'

export const CODEX_SUBSCRIPTION_PROVIDER_ID = 'builtin-codex-subscription'

export const CLAUDE_SHARED_PROVIDER_ID = 'builtin-claude-shared'

export const CLAUDE_ISOLATED_PROVIDER_ID = 'builtin-claude-isolated'

export const XAI_SUBSCRIPTION_PROVIDER_ID = 'builtin-xai-subscription'

export const xaiSubscriptionProviderIdentity = (): { id: string; name: string } => ({
  id: XAI_SUBSCRIPTION_PROVIDER_ID,
  name: 'xAI (Grok) OAuth'
})

export const isXaiSubscriptionProvider = (type: ProviderType): type is 'xai-subscription' =>
  type === 'xai-subscription'

// The optional Lab enterprise provider. One fixed record exists only while the user is signed in;
// its models and base URL are derived from GET /api/me/bootstrap and never edited by hand.
export const labProviderIdentity = (): { id: string; name: string } => ({
  id: LAB_PROVIDER_ID,
  name: 'Lab'
})

export const isLabProvider = (type: ProviderType): type is 'lab' => type === 'lab'

export const usesAppProviderTransport = (type: ProviderType): boolean =>
  type === 'custom' || type === 'xai-subscription' || type === 'lab'

export const isCodexSubscriptionProvider = (
  type: ProviderType
): type is 'codex-shared' | 'codex-isolated' => type === 'codex-shared' || type === 'codex-isolated'

export const codexSubscriptionProviderIdentity = (): { id: string; name: string } => ({
  id: CODEX_SUBSCRIPTION_PROVIDER_ID,
  name: 'Codex subscription'
})

export const isCodexSubscriptionProviderId = (id: string): boolean =>
  id === CODEX_SUBSCRIPTION_PROVIDER_ID ||
  id === CODEX_SHARED_PROVIDER_ID ||
  id === CODEX_ISOLATED_PROVIDER_ID

export const canonicalSessionProviderId = (providerId: string): string =>
  isCodexSubscriptionProviderId(providerId) ? CODEX_SUBSCRIPTION_PROVIDER_ID : providerId

export const isClaudeSubscriptionProvider = (
  type: ProviderType
): type is 'claude-shared' | 'claude-isolated' =>
  type === 'claude-shared' || type === 'claude-isolated'

// The claude-isolated record's fixed identity. Every isolated lookup (repository upsert,
// service login/edit/validation) keys on CLAUDE_ISOLATED_PROVIDER_ID.
export const claudeIsolatedProviderIdentity = (): { id: string; name: string } => ({
  id: CLAUDE_ISOLATED_PROVIDER_ID,
  name: 'Claude subscription'
})

// The claude-shared record's fixed identity. Every shared lookup keys on CLAUDE_SHARED_PROVIDER_ID.
export const claudeSharedProviderIdentity = (): { id: string; name: string } => ({
  id: CLAUDE_SHARED_PROVIDER_ID,
  name: 'Claude subscription'
})

export const isClaudeSubscriptionProviderId = (id: string): id is ClaudeSubscriptionProviderId =>
  id === CLAUDE_SHARED_PROVIDER_ID || id === CLAUDE_ISOLATED_PROVIDER_ID

// Chooses the single Claude subscription record projected by collapsed UI surfaces. An active Claude
// record wins; otherwise the last explicitly configured mode wins, with list order only as a legacy
// fallback for settings written before the preference existed.
export const selectClaudeSubscriptionProvider = <T extends { id: string; type: ProviderType }>(
  providers: readonly T[],
  activeProviderId?: string,
  preferredProviderId?: ClaudeSubscriptionProviderId
): T | undefined => {
  const claudeProviders = providers.filter((provider) =>
    isClaudeSubscriptionProvider(provider.type)
  )

  return (
    claudeProviders.find((provider) => provider.id === activeProviderId) ??
    claudeProviders.find((provider) => provider.id === preferredProviderId) ??
    claudeProviders[0]
  )
}

// The chat API a model endpoint speaks: `messages` = /v1/messages, `chat-completions` =
// /v1/chat/completions, and `responses` = /v1/responses. Keep the two OpenAI-shaped protocols
// distinct: Codex requires Responses and reaches a Chat Completions provider only through its bridge.
// A provider advertises the explicit set of endpoints it serves; a framework supports a set too.

// Route path each chat endpoint speaks. Raw API paths are literal and identical in every locale
// (they must match a gateway's own documentation); only the surrounding copy is localized per
// surface. Main and renderer share this one map so no surface keeps a private copy.
export const ENDPOINT_PATHS: Record<ModelProtocol, string> = {
  messages: '/v1/messages',
  'chat-completions': '/v1/chat/completions',
  responses: '/v1/responses'
}

// Codex subscription records always use Responses, including older records without endpoint metadata.
// An official catalog may explicitly have no usable route. Legacy configurations default to Messages.
export const providerEndpoints = (
  provider: {
    apiEndpoints?: readonly ModelProtocol[]
    type?: ProviderType
    modelProtocols?: Readonly<Record<string, readonly ModelProtocol[]>>
  },
  model?: string
): ModelProtocol[] => {
  if (provider.type && isCodexSubscriptionProvider(provider.type)) return ['responses']
  const declared = provider.type === 'lab' && model ? provider.modelProtocols?.[model] : undefined
  if (declared?.length) return [...declared]
  if (provider.apiEndpoints && (provider.apiEndpoints.length > 0 || provider.type === 'official'))
    return [...provider.apiEndpoints]
  return provider.type === 'lab' ? ['chat-completions', 'responses'] : ['messages']
}

// App-managed providers keep separate transport families: an xAI OAuth bridge and a Lab bridge
// cannot be reused across a model switch, while every API-key provider keeps sharing one family.
const providerTransportFamily = (type: ProviderType): 'xai' | 'lab' | 'app' =>
  isXaiSubscriptionProvider(type) ? 'xai' : isLabProvider(type) ? 'lab' : 'app'

export const shareProviderTransportFamily = (left: ProviderType, right: ProviderType): boolean =>
  providerTransportFamily(left) === providerTransportFamily(right)

export const canUseClaudeProviderTransport = (provider: {
  type: ProviderType
  apiEndpoints?: readonly ModelProtocol[]
  key?: string
  baseUrl?: string
  vendorId?: OfficialVendorId
  model?: string
  modelAllowsAnonymousAccess?: boolean
}): boolean =>
  usesAppProviderTransport(provider.type) &&
  providerEndpoints(provider).includes('messages') &&
  (provider.type !== 'custom' || Boolean(provider.key) || providerAllowsAnonymousAccess(provider))

// A provider's endpoints are compatible with a framework only when they share at least one endpoint.
// Codex's Responses-compatible bridge is a separate local gateway: it does not change the provider's
// endpoints, but it makes Chat Completions providers usable through an explicit translation path.
export const isProviderCompatibleWith = (
  endpoints: readonly ModelProtocol[],
  frameworkEndpoints: readonly ModelProtocol[]
): boolean => endpoints.some((endpoint) => frameworkEndpoints.includes(endpoint))

// Codex can drive a Chat Completions-only provider through the app's local Responses bridge.
// CodeBuddy has the inverse boundary: it always consumes Chat Completions, so providers that expose
// only Responses or Messages require the app's Chat compatibility transport.
export const requiresChatCompletionsBridge = (
  provider: { apiEndpoints?: readonly ModelProtocol[] },
  framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
): boolean => {
  const endpoints = providerEndpoints(provider)

  if (framework.id === 'codex') {
    return (
      framework.supportedApiTypes.includes('responses') &&
      endpoints.includes('chat-completions') &&
      !endpoints.includes('responses')
    )
  }
  return (
    framework.id === 'codebuddy' &&
    framework.supportedApiTypes.includes('chat-completions') &&
    !endpoints.includes('chat-completions') &&
    (endpoints.includes('responses') || endpoints.includes('messages'))
  )
}

// Whether a provider can actually drive a given framework. Two axes: endpoint compatibility (above),
// AND provider-type — a `claude-isolated` provider carries an app-owned Anthropic OAuth token
// that no other framework can consume, so it is only usable by Claude Code regardless of endpoint.
// Codex subscription providers use either the native Codex runtime or the built-in Agent's
// host-owned subscription bridge. Enforced both in the renderer gates and main-side (preflight + spawn).
export const isProviderUsableByFramework = (
  provider: {
    apiEndpoints?: readonly ModelProtocol[]
    type: ProviderType
    codexHarnessAvailable?: boolean
  },
  framework: { id: AgentFrameworkId; supportedApiTypes: readonly ModelProtocol[] }
): boolean => {
  if (provider.type === 'codebuddy-subscription') return framework.id === 'codebuddy'
  if (
    framework.id === 'open-science-agent' &&
    !['custom', 'official', 'xai-subscription', 'lab'].includes(provider.type) &&
    !isCodexSubscriptionProvider(provider.type)
  )
    return false
  // Lab speaks the two gateway protocols natively. It deliberately has no compatibility-bridge
  // path: a model that does not natively speak the framework's protocol is reported as incompatible
  // instead of being routed through a conversion bridge that cannot resolve a host-owned credential.
  if (isLabProvider(provider.type))
    return isProviderCompatibleWith(providerEndpoints(provider), framework.supportedApiTypes)
  if (isCodexSubscriptionProvider(provider.type))
    return (
      framework.id === 'codex' ||
      (framework.id === 'open-science-agent' && provider.codexHarnessAvailable !== false)
    )
  // Both Claude subscription modes rely on the ~/.claude or app-owned credential that only
  // claude-code knows how to read; OpenCode receives neither an endpoint nor a token.
  if (isClaudeSubscriptionProvider(provider.type) && framework.id !== 'claude-code') return false

  const endpoints = providerEndpoints(provider)

  if (requiresChatCompletionsBridge(provider, framework)) {
    return true
  }

  return isProviderCompatibleWith(endpoints, framework.supportedApiTypes)
}

export const DEFAULT_ENDPOINT_ORDER = ['responses', 'chat-completions', 'messages'] as const

// Frameworks list their native protocols in preference order. Bridges use the default order.
export const preferredEndpoint = <const Endpoint extends ModelProtocol>(
  endpoints: readonly ModelProtocol[],
  preference: readonly Endpoint[]
): Endpoint | undefined => preference.find((endpoint) => endpoints.includes(endpoint))

// Applies a targeted failure only to the model/protocol it probed; provider-level failures still
// apply everywhere. Shared by main and renderer so every selection surface uses the same rule.
export const providerValidationTargetMatches = (
  left: ProviderValidationTarget,
  right: ProviderValidationTarget
): boolean =>
  left.model === right.model &&
  left.endpoint === right.endpoint &&
  left.frameworkId === right.frameworkId &&
  left.route === right.route

// Evidence applicability is directional: legacy HTTP evidence remains framework-independent.
export const providerValidationTargetApplies = (
  evidence: ProviderValidationTarget,
  target: ProviderValidationTarget
): boolean =>
  evidence.model === target.model &&
  evidence.endpoint === target.endpoint &&
  (evidence.frameworkId === undefined ||
    (evidence.frameworkId === target.frameworkId && evidence.route === target.route))

export const providerValidationFailed = (
  provider: {
    lastValidatedAt?: number
    lastValidatedTarget?: ProviderValidationTarget
    lastValidationFailure?: ProviderValidationFailure
  },
  target?: ProviderValidationTarget
): boolean =>
  provider.lastValidationFailure !== undefined &&
  // A legacy 'incompatible' verdict is a derivable (provider, framework) relationship, not endpoint
  // health; validation no longer records it, and stored copies must not hide the provider either.
  provider.lastValidationFailure.category !== 'incompatible' &&
  (provider.lastValidationFailure.target === undefined ||
    (target !== undefined &&
      [
        provider.lastValidationFailure.target,
        ...(provider.lastValidationFailure.category === 'model-not-found'
          ? (provider.lastValidationFailure.targets ?? [])
          : [])
      ].some((failed) => providerValidationTargetApplies(failed, target)))) &&
  (provider.lastValidatedAt === undefined ||
    (target !== undefined &&
      provider.lastValidatedTarget !== undefined &&
      !providerValidationTargetApplies(provider.lastValidatedTarget, target)) ||
    provider.lastValidationFailure.at >= provider.lastValidatedAt)

export const providerValidationSucceeded = (
  provider: {
    lastValidatedAt?: number
    lastValidatedTarget?: ProviderValidationTarget
    lastValidationFailure?: ProviderValidationFailure
  },
  target: ProviderValidationTarget
): boolean =>
  provider.lastValidatedAt !== undefined &&
  (provider.lastValidatedTarget === undefined ||
    providerValidationTargetApplies(provider.lastValidatedTarget, target)) &&
  !providerValidationFailed(provider, target)

// How much reasoning effort the user asks the agent to spend. 'default' means "don't override": the
// agent keeps its own default and nothing is sent. The concrete levels form a relative scale
// (low < medium < high < xhigh < max): the active model's static profile maps the level onto its
// concrete supported rungs (e.g. 'max' becomes the model's top level).

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'default'

export const DEFAULT_SUBAGENT_MODEL_CONFIGURATION: SubagentModelConfiguration = Object.freeze({
  mode: 'inherit'
})

export const DEFAULT_REVIEWER_MODEL_CONFIGURATION: ReviewerModelConfiguration = Object.freeze({
  mode: 'inherit'
})

export const DEFAULT_SESSION_DETAILS_MODEL_CONFIGURATION: SessionDetailsModelConfiguration =
  Object.freeze({ mode: 'inherit', reasoningEffort: 'low' })

// Desktop notifications for finished/failed agent tasks are opt-out: they only fire while the app
// is unfocused, so the default surprises no one staring at the window.
export const DEFAULT_NOTIFICATIONS_ENABLED = true

// Native notification detail is opt-in because banners may appear on lock screens or shared displays.
export const DEFAULT_SHOW_NOTIFICATION_CONTENT = false

// Conversation-driven Skill package import is opt-out. When disabled, the runtime omits both the
// app-owned import MCP server and its prompt/attachment guidance from subsequent conversations.
export const DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED = true

// Runtime guard for untrusted values (IPC payloads, settings.json): only the known levels pass.
export const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)

export const DEFAULT_APP_ICON_VARIANT: AppIconVariant = 'light'

// Runtime guard for untrusted values (IPC payloads, settings.json): only the known variants pass.
export const isAppIconVariant = (value: unknown): value is AppIconVariant =>
  typeof value === 'string' && (APP_ICON_VARIANTS as readonly string[]).includes(value)

// The ordered icon variants shown in Settings. The default (light) leads.
export const APP_ICON_VARIANT_INFOS: readonly AppIconVariantInfo[] = [
  { id: 'light', label: 'Light', description: 'The light Open-Science logo.' },
  { id: 'dark', label: 'Dark', description: 'The dark Open-Science logo.' }
]

// The ordered install sources for a given host platform. The app-managed download is the default and
// recommended path (self-contained binary, no user Node/npm). npm and the official installer follow as
// manual fallbacks: the npm command is identical everywhere, while the official installer differs —
// Windows uses install.ps1, other platforms install.sh. Pass the host platform (e.g.
// `window.api.platform`) so the copyable command matches what runs.
export const getClaudeInstallSources = (platform: string = 'linux'): ClaudeInstallSourceInfo[] => {
  const isWindows = platform === 'win32'

  return [
    {
      id: 'managed',
      labelKey: 'App-managed download (recommended)',
      displayCommand: '',
      requiresNpm: false,
      descriptionKey: 'Downloads a self-contained Claude — no Node.js or npm required.'
    },
    {
      id: 'npm',
      labelKey: 'npm (global install)',
      displayCommand: 'npm i -g @anthropic-ai/claude-code',
      requiresNpm: true
    },
    {
      id: 'official-script',
      labelKey: isWindows ? 'Official install.ps1' : 'Official install.sh',
      displayCommand: isWindows
        ? 'irm https://claude.ai/install.ps1 | iex'
        : 'curl -fsSL https://claude.ai/install.sh | bash',
      requiresNpm: false
    }
  ]
}

// Returns how to install Node.js on the given host platform. Windows uses winget (built into Windows
// 10/11); macOS suggests Homebrew; Linux is too distro-specific for a single command, so only the
// download page is offered. The installer bundles npm in every case.
export const getNodeInstallHint = (platform: string = 'linux'): NodeInstallHint => {
  if (platform === 'win32') {
    return { command: 'winget install OpenJS.NodeJS.LTS', url: 'https://nodejs.org/en/download' }
  }

  if (platform === 'darwin') {
    return { command: 'brew install node', url: 'https://nodejs.org/en/download' }
  }

  return { url: 'https://nodejs.org/en/download' }
}

export const getCodeBuddyInstallSources = (): ClaudeInstallSourceInfo[] => [
  {
    id: 'managed',
    labelKey: 'App-managed download (recommended)',
    displayCommand: '',
    requiresNpm: false,
    descriptionKey:
      'Downloads CodeBuddy into the app-managed runtime and runs it with the app runtime — no global Node.js or npm required.'
  }
]

export const getCodexInstallSources = (): ClaudeInstallSourceInfo[] => [
  {
    id: 'managed',
    labelKey: 'App-managed download (recommended)',
    displayCommand: '',
    requiresNpm: false,
    descriptionKey: 'Downloads a self-contained Codex ACP runtime — no Node.js or npm required.'
  },
  {
    id: 'npm',
    labelKey: 'npm (global install)',
    displayCommand: 'npm i -g @agentclientprotocol/codex-acp',
    requiresNpm: true
  }
]

// The ordered OpenCode install sources for a host platform, mirroring getClaudeInstallSources. The
// app-managed native-binary download leads (works on every OS, including native Windows). npm follows
// (`npm i -g opencode-ai`). The shell installer (`curl … | bash`) is offered only off Windows —
// OpenCode ships no official Windows PowerShell installer, so Windows users take managed or npm.
export const getOpencodeInstallSources = (
  platform: string = 'linux'
): ClaudeInstallSourceInfo[] => {
  const isWindows = platform === 'win32'

  const sources: ClaudeInstallSourceInfo[] = [
    {
      id: 'managed',
      labelKey: 'App-managed download (recommended)',
      displayCommand: '',
      requiresNpm: false,
      descriptionKey: 'Downloads a self-contained OpenCode — no Node.js or npm required.'
    },
    {
      id: 'npm',
      labelKey: 'npm (global install)',
      displayCommand: 'npm i -g opencode-ai',
      requiresNpm: true
    }
  ]

  if (!isWindows) {
    sources.push({
      id: 'official-script',
      labelKey: 'Official install script',
      displayCommand: 'curl -fsSL https://opencode.ai/install | bash',
      requiresNpm: false
    })
  }

  return sources
}

export const CONNECTOR_TEMPLATE_MAX_BYTES = 256 * 1024

// Validate the required projection containers before any consumer can render them. Optional
// preferences retain their established defaults; this does not rewrite the stored document.
export const parseSettingsSnapshot = (snapshot: unknown): SettingsSnapshot => {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  if (
    !record(snapshot) ||
    !Array.isArray(snapshot.providers) ||
    !Array.isArray(snapshot.agentFrameworks) ||
    !record(snapshot.claude) ||
    !record(snapshot.opencode) ||
    typeof snapshot.agentFrameworkId !== 'string' ||
    snapshot.providers.some(
      (provider) =>
        !record(provider) ||
        typeof provider.id !== 'string' ||
        typeof provider.name !== 'string' ||
        !Array.isArray(provider.models) ||
        provider.models.some((model) => typeof model !== 'string')
    ) ||
    snapshot.agentFrameworks.some(
      (framework) =>
        !record(framework) ||
        typeof framework.id !== 'string' ||
        typeof framework.displayName !== 'string'
    ) ||
    (snapshot.revision !== undefined &&
      (typeof snapshot.revision !== 'number' ||
        !Number.isSafeInteger(snapshot.revision) ||
        snapshot.revision < 0))
  )
    throw new ApplicationCommandError('invalid-command-result', 'Invalid settings snapshot.')
  return snapshot as SettingsSnapshot
}

// Same route vocabulary as backend planning; callers supply the selected model's endpoints.
export const providerValidationRoute = (
  provider: {
    type: ProviderType
    apiEndpoints?: readonly ModelProtocol[]
    vendorId?: OfficialVendorId
    baseUrl?: string
    chatCompletionsBaseUrl?: string
    needsChatResponsesToChatCompletionsBridge?: boolean
    needsNativeResponsesCompatibility?: boolean
  },
  frameworkId: AgentFrameworkId
): Pick<ProviderValidationTarget, 'frameworkId' | 'route'> => {
  const endpoints = providerEndpoints(provider)
  let route: AgentModelRoute
  switch (frameworkId) {
    case 'claude-code':
      route = 'claude-anthropic'
      break
    case 'opencode':
      route = endpoints.includes('chat-completions') ? 'opencode-openai' : 'opencode-anthropic'
      break
    case 'codebuddy':
      route =
        provider.type === 'codebuddy-subscription' ? 'codebuddy-subscription' : 'codebuddy-openai'
      break
    case 'pi':
      route = 'pi'
      break
    case 'open-science-agent':
      route = 'open-science-agent'
      break
    case 'codex':
      route =
        (provider.needsChatResponsesToChatCompletionsBridge ?? !endpoints.includes('responses'))
          ? 'codex-bridge'
          : (provider.needsNativeResponsesCompatibility ??
              (!isCodexSubscriptionProvider(provider.type) &&
                provider.vendorId !== 'openai' &&
                !isOfficialOpenAiResponsesBase(
                  provider.chatCompletionsBaseUrl ?? provider.baseUrl
                )))
            ? 'codex-responses-compatibility'
            : 'codex-responses'
      break
  }
  return { frameworkId, route }
}
