import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ClientConnection, McpServer, SessionModeState } from '@agentclientprotocol/sdk'

import type { PermissionProfileApplication } from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { AgentFrameworkId, ChatApiEndpoint } from '../../shared/settings'
import type {
  CustomReasoningEffortTransport,
  ModelReasoningEffort,
  ResolvedReasoningEffort
} from '../../shared/reasoning-effort'
import type { OfficialVendorId } from '../../shared/provider-registry'
import type { AcpModelStepTokenUsage } from '../../shared/acp'
import type { ResolvedProvider } from '../settings/provider-env'
import type {
  ResponsesBridgeConnection,
  ResponsesBridgeModelTarget,
  ResponsesBridgeNamespacedTool,
  ResponsesBridgeSkillCandidate,
  ResponsesBridgeSkillInput
} from '../settings/responses-bridge'

// The agent frameworks the app can drive over ACP (id union defined in shared settings so the renderer
// and persisted settings share it). Adding one means implementing AgentFramework.
export type { AgentFrameworkId }

// A config file the framework needs on disk before spawn (e.g. a generated opencode.json). The
// runtime writes these and points the framework at them via env/args.
export type AgentConfigFile = {
  path: string
  content: string
  mode?: number
  // The path is derived from the content. Publish it atomically and reuse an existing byte-identical
  // file so concurrent framework starts can safely share it.
  contentAddressed?: boolean
}

// Authentication is sent over ACP after initialize. Keeping it out of the child environment avoids
// Codex copying the key into shell snapshots or its default auth.json file.
export type AgentAuthentication = {
  methodId: string
  _meta?: Record<string, unknown>
}

// Codex ACP 1.6.2 `providers/list` exposes one configurable slot, `openai`.
// `providers/set` on that id installs the custom gateway internally
// (`modelProvider: "custom-gateway"`). Sending `custom-gateway` as the ACP
// providerId is invalid_params on 1.6.2 (`only "openai" is configurable`).
export const CODEX_ACP_CONFIGURABLE_PROVIDER_ID = 'openai' as const

// claude-agent-acp exposes its active Anthropic-compatible provider as `main`.
// Configuring that slot makes the loopback route programmatic settings, which
// takes precedence over a user's persisted Claude settings.json environment.
export const CLAUDE_ACP_CONFIGURABLE_PROVIDER_ID = 'main' as const

export type AgentProviderConfiguration =
  | {
      providerId: typeof CODEX_ACP_CONFIGURABLE_PROVIDER_ID
      apiType: 'openai'
      baseUrl: string
      headers: Record<string, string>
    }
  | {
      providerId: typeof CLAUDE_ACP_CONFIGURABLE_PROVIDER_ID
      apiType: 'anthropic'
      baseUrl: string
      headers: Record<string, string>
    }

// How the app's provider maps onto a framework's native model configuration. Claude reads env
// (ANTHROPIC_*); opencode reads a generated config file referenced by OPENCODE_CONFIG. Fields are
// merged over the spawn base, so an empty result just spawns with inherited defaults.
export type AgentModelConfig = {
  env?: Record<string, string>
  configFiles?: AgentConfigFile[]
  args?: string[]
  authentication?: AgentAuthentication
  providerConfiguration?: AgentProviderConfiguration
  // Framework-specific model id used for local metadata/configuration. A bridge may keep this
  // separate from the provider's upstream model id.
  sessionModel?: string
  // Exact stable app guidance delivered through framework-native backend configuration rather than
  // ordinary ACP prompt content. The runtime uses this for context accounting and to avoid copying
  // the same text into every user message.
  persistentSystemPrompt?: string
}

export type AgentModelRoute =
  | 'claude-anthropic'
  | 'opencode-anthropic'
  | 'opencode-openai'
  | 'codebuddy-openai'
  | 'codex-responses'
  | 'codex-responses-compatibility'
  | 'codex-bridge'

export type AgentModelCatalogEntry = Readonly<{
  provider: ResolvedProvider
  reasoningEffort?: ModelReasoningEffort
  reasoningEfforts?: readonly ModelReasoningEffort[]
}>

export type SkillSelectorUsageObservation = Readonly<{
  usage: AcpModelStepTokenUsage
  sourceInvocationId?: string
}>

// Secret-free, side-effect-free projection of one persisted model selection onto the live runtime.
// Settings owns provider/vendor/route resolution; AcpRuntime only compares this identity with its
// current generation and applies the already-resolved session or bridge values.
export type AgentModelChangeTarget = Readonly<{
  frameworkId: AgentFrameworkId
  providerId?: string
  backendId: string
  route: AgentModelRoute
  model: string
  sessionModel: string
  sessionModelRequired: boolean
  reasoningEffort: ResolvedReasoningEffort
  supportsImageInput: boolean
  contextWindow?: number
  // Opaque, secret-free id for one provider/model already registered in the current Claude
  // generation's loopback Anthropic bridge. Absent means this target cannot cross a provider env.
  anthropicBridgeTargetId?: string
  // Opaque, secret-free id for a provider/model route pre-registered in the generation transport.
  // The lease decides whether selecting it is validation-only (OpenCode) or retargets a route.
  providerTransportTargetId?: string
  bridge?: Readonly<{
    model: string
    vendorId?: OfficialVendorId
    reasoningEffortTransport?: CustomReasoningEffortTransport
  }>
}>

// Inputs for translating a provider; paths differ per framework (Claude wants its executable + config
// dir root, opencode wants a location to write its generated config into).
export type ModelConfigContext = {
  // App storage root; frameworks derive their config dir/location beneath it.
  storageRoot: string
  // Absolute path to the detected framework executable (claude / opencode).
  executablePath: string
  // Detected version of the native CLI behind an adapter. Codex uses this to trust bundled model
  // metadata only when the model/version pair is explicitly known.
  nativeVersion?: string
  responsesBridge?: ResponsesBridgeConnection
  // Compact connector conventions for frameworks that need host.mcp guidance in their baseline
  // instructions. Detailed connector schemas live in on-demand `mcp-*` skills. Empty ⇒ omitted.
  instructions?: string
  // Stable app guidance that must live at system/developer scope for the backend generation. Claude
  // delivers the same appends through session metadata instead and may ignore this field.
  systemPromptAppends?: string[]
  // The active model's already-resolved API effort. Undefined means don't override. Frameworks encode
  // this into their valid transport vocabulary without changing the persisted user intent.
  reasoningEffort?: ModelReasoningEffort
  // Distinct model-native effort values advertised by the active model profile. Frameworks that
  // register custom model metadata use this to keep their capability catalog consistent with the
  // selected effort above.
  reasoningEfforts?: readonly ModelReasoningEffort[]
  // Same-provider models that keep the active backend route. Frameworks may pre-register these in
  // their native catalog so a later session configOption switch does not require a process respawn.
  providerModelCatalog?: readonly AgentModelCatalogEntry[]
}

// System-prompt guidance the runtime wants appended for a session (artifact routing, notebook, skill
// privacy). The framework decides HOW it is delivered — see SessionSetup.
export type SessionSetupContext = {
  systemPromptAppends: string[]
  // Short, high-priority reminders that must reach each turn when the framework carries the complete
  // appends only in session metadata. Frameworks whose appends already ride each prompt may omit them.
  turnPromptReminders?: string[]
  // Framework-native options resolved with the active backend and applied to every session created
  // on that connection. Claude uses this to inject app-owned settings/plugins into shared auth mode.
  sessionOptions?: Record<string, unknown>
  // undefined is the Main Agent and must omit the native field; [] is an explicit Specialist
  // zero-skill whitelist and must be preserved verbatim by supporting frameworks.
  skillWhitelist?: string[]
  // App-owned Skill loading is a primary-session capability, not a backend-wide default. Absent
  // means disabled (for example Reviewer and restricted inference); `all` is an unrestricted
  // primary Agent; an array is the exact Specialist allowlist enforced by the Skill loader itself.
  skillRuntimeScope?: 'all' | string[]
}

// Framework-specific session configuration returned to the runtime. `meta` becomes the ACP `_meta`
// on session/new and session/resume. `promptPrefix` is prepended to prompt content when the framework
// cannot carry appends in session meta, or when a session-level append needs a per-turn reminder.
// `persistentSystemPrompt` exposes the exact transformed text delivered through framework-specific
// metadata so context accounting never has to inspect that opaque transport shape.
export type SessionSetup = {
  meta?: Record<string, unknown>
  // Standard ACP MCP servers contributed by the framework for this Session. CodeBuddy uses this
  // seam for the app-owned Skill loader while keeping its native, project-scanning Skill tool off.
  mcpServers?: McpServer[]
  promptPrefix?: string
  persistentSystemPrompt?: string
}

export type ProxyEnvironmentMode = 'inherit' | 'replace'

// Already-resolved spawn inputs: env and args come from prepareModelConfig merged over the base
// process env; configFiles are written by the runtime before this call.
export type AgentSpawnInput = {
  executablePath: string
  env: Record<string, string>
  args: string[]
  // `replace` means the host resolved an explicit proxy or DIRECT decision and inherited proxy
  // variables must not override it. `inherit` preserves them after a host resolver failure.
  proxyEnvironmentMode?: ProxyEnvironmentMode
  debug?: boolean
}

// How a framework keeps long-running sessions inside their context window. A native command makes
// manual compaction available over ACP session/prompt. `triggerAtPercent` is present only when the host
// also owns automatic triggering; frameworks that compact automatically themselves omit it.
export type ContextCompactionStrategy =
  | {
      kind: 'native-command'
      command: string
      triggerAtPercent?: number
      // Some ACP adapters report a failed control turn only through assistant output, then return
      // end_turn. The runtime suppresses that output but uses this prefix to preserve failure state.
      failureTextPrefix?: string
    }
  | { kind: 'framework-managed' }

export type CommandShellDialect = 'posix' | 'powershell'

// One switchable agent backend. The ACP runtime stays generic and delegates only the framework-coupled
// decisions to this interface. See docs/internal/pluggable-agent-framework-feasibility.md.
export interface AgentFramework {
  readonly id: AgentFrameworkId
  readonly displayName: string

  // The shell grammar used for provider-native command tools. The permission Broker consumes this
  // fact when validating remembered command groups; the framework does not make permission decisions.
  readonly commandShellDialect?: CommandShellDialect

  // Keeps slash-command details at the framework seam so the generic runtime only asks for native
  // compaction and never branches on framework ids.
  readonly contextCompaction: ContextCompactionStrategy

  // Launch the ACP agent subprocess (stdio JSON-RPC), wrapping the per-framework binary + args.
  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams

  // Materialize a framework-owned, isolated spawn profile for one delegated Attempt. Generic
  // orchestration supplies the admitted backend and runtime home without knowing credential or
  // configuration details for the framework.
  prepareDelegatedSpawn?(
    backend: ResolvedAgentBackend,
    runtimeHome: string
  ): Promise<AgentSpawnInput>

  // Some ACP servers keep process-global current-session state. When present, the prompt workflow
  // calls this immediately before session.prompt() for the target provider session.
  beforePromptDispatch?(input: {
    connection: ClientConnection
    providerSessionId: string
    cwd: string
    mcpServers: readonly McpServer[]
    skillRuntimeAllowlist?: readonly string[]
  }): Promise<void>

  // Frameworks with process-global current-session state cannot safely accept concurrent prompt
  // dispatches on one ACP process.
  readonly serializesProviderPrompts?: boolean

  // Translate the app's provider into the framework's native model config (env / config files / args).
  prepareModelConfig(provider: ResolvedProvider, ctx: ModelConfigContext): AgentModelConfig

  // Build the session `_meta` and decide how system-prompt appends are delivered for this framework.
  buildSessionSetup(ctx: SessionSetupContext): SessionSetup

  // Map an app permission profile onto the modes the agent advertised at session build/resume.
  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication

  // Config-dir-materialized skills (Claude). Absent ⇒ the app hides the skills UI + force-load path.
  readonly supportsSkills: boolean

  // Release gate for the app-owned Delegated Work Module. A framework stays false until its own
  // certification ticket passes every shared journey and closes native delegation bypasses.
  readonly supportsDelegatedWork: boolean

  // Whether the framework accepts stdio MCP servers via ACP session mcpServers. opencode advertises
  // http/sse only, so stdio servers must not be handed to it — the app's artifact/notebook tooling
  // (currently stdio) is gated off for such frameworks until it is exposed over http/sse.
  readonly acceptsStdioMcp: boolean

  // Whether a reasoning-effort change can be applied LIVE to open sessions via the ACP thought_level
  // configOption, without a respawn. True where the adapter advertises that option (verified live:
  // Claude Code, codex-acp). False where effort only rides the baked spawn config (opencode ignores
  // the protocol option), so a change must respawn to regenerate it.
  readonly supportsLiveEffortChange: boolean

  // Translate model-native effort names only when the ACP option does not advertise the exact value.
  // CodeBuddy, for example, spells `none`/`default` as `disabled`/`enabled`.
  adaptSessionEffort?(effort: ResolvedReasoningEffort): string

  // Chat endpoints this framework can drive. A provider is only selectable when it shares one:
  // Claude Code speaks Anthropic /v1/messages; opencode speaks both.
  readonly supportedApiTypes: readonly ChatApiEndpoint[]
}

// The resolved agent backend for one connect: which framework to drive plus its already-resolved spawn
// inputs (executable + env + args). Produced by the settings layer at connect time so a framework or
// provider switch takes effect on reconnect.
export type ResolvedAgentBackend = {
  framework: AgentFramework
  // Stable app provider/account identity used for usage attribution. This remains separate from
  // backendId because a framework may normalize provider selections onto one session store.
  providerId?: string
  // Stable identity of the framework/provider storage boundary. Two providers can use the same
  // framework while keeping incompatible session stores (for example Codex shared vs isolated login).
  backendId?: string
  modelRoute?: AgentModelRoute
  providerContinuityToken?: string
  executablePath: string
  env: Record<string, string>
  args?: string[]
  proxyEnvironmentMode?: ProxyEnvironmentMode
  // Framework-native session options retained by the runtime and passed through buildSessionSetup.
  sessionOptions?: Record<string, unknown>
  // Backend-resolved guidance appended to every session. Connector conventions use this channel for
  // Claude and Codex; OpenCode keeps the same guidance in its generated instructions config.
  systemPromptAppends?: string[]
  // Exact stable text already installed in the backend's native instructions configuration.
  persistentSystemPrompt?: string
  // Model to apply per session via the ACP `model` configOption, for frameworks that select the model
  // over the protocol rather than via env (opencode). Undefined ⇒ the framework's env/config drives it
  // (Claude uses ANTHROPIC_MODEL). Applied best-effort: skipped when the agent advertises no match.
  sessionModel?: string
  // Subscription backends must run the model selected in the UI. When true, a missing/rejected live
  // model option fails session creation instead of silently using the agent's account default.
  sessionModelRequired?: boolean
  // Model-resolved reasoning effort to apply per session via ACP. The runtime prefers exact matching
  // before an optional framework vocabulary adapter; undefined leaves the agent default unchanged.
  sessionEffort?: ModelReasoningEffort
  // Exact context-window limit for the selected upstream provider model. Framework adapters may
  // report a fallback or bridge transport model instead, so the runtime treats this as authoritative.
  contextWindow?: number
  // Whether the selected upstream model accepts image input. Kept on the generation so a model-only
  // switch can fail closed when an adapter cannot remove images already retained in native history.
  supportsImageInput?: boolean
  // Upstream provider model used for local context tokenization. This is deliberately separate from
  // `sessionModel`: a framework may select its model through env rather than ACP, or use a bridge
  // transport model whose id differs from the provider model that ultimately tokenizes the request.
  contextUsageModel?: string
  authentication?: AgentAuthentication
  providerConfiguration?: AgentProviderConfiguration
  // Authenticated loopback API exposed by the same OpenCode ACP process. The runtime snapshots
  // assistant messages around a prompt so it can aggregate every model step in that user turn.
  opencodeUsageApi?: {
    baseUrl: string
    authorization: string
  }
  // A bridged backend owns one reference to its local loopback bridge. Runtime teardown releases it;
  // reviewer sessions register their Codex prompt_cache_key here so routing never depends on content.
  responsesBridgeLease?: {
    selectSkills: (
      text: string,
      catalog: ResponsesBridgeSkillCandidate[],
      signal?: AbortSignal,
      observeUsage?: (observation: SkillSelectorUsageObservation) => void
    ) => Promise<ResponsesBridgeSkillInput[]>
    registerReviewerSession: (promptCacheKey: string) => void
    unregisterReviewerSession: (promptCacheKey: string) => boolean
    registerToolLessSession?: (promptCacheKey: string) => void
    unregisterToolLessSession?: (promptCacheKey: string) => boolean
    registerHostMessageSession?: (
      promptCacheKey: string,
      namespacedTools: ResponsesBridgeNamespacedTool[],
      options?: Readonly<{ failClosedUnknownKeys?: boolean }>
    ) => void
    unregisterHostMessageSession?: (promptCacheKey: string) => boolean
    // Updates the concrete effort on this runtime's own bridged provider/model. Keeping it on the
    // lease prevents an active-model value from leaking into bridges owned by retiring generations.
    setReasoningEffort?: (effort?: ModelReasoningEffort) => void
    setModelTarget?: (target: ResponsesBridgeModelTarget) => void
    release: () => Promise<void>
  }
  // API-key Claude generations keep their process environment stable by talking to an app-owned
  // loopback Anthropic bridge. The bridge owns endpoint/token/model routing in memory; live model
  // targets carry only an opaque id into this lease.
  anthropicBridgeLease?: {
    setTarget: (targetId: string) => boolean
    release: () => Promise<void>
  }
  providerTransportLease?: {
    setTarget: (targetId: string) => boolean
    selectSkills?: (
      text: string,
      catalog: ResponsesBridgeSkillCandidate[],
      signal?: AbortSignal,
      observeUsage?: (observation: SkillSelectorUsageObservation) => void
    ) => Promise<ResponsesBridgeSkillInput[]>
    release: () => Promise<void>
  }
}
