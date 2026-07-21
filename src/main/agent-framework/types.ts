import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import type { PermissionProfileApplication } from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { AgentFrameworkId, ChatApiEndpoint, ReasoningEffort } from '../../shared/settings'
import type { ResolvedProvider } from '../settings/provider-env'
import type { ResponsesBridgeConnection } from '../settings/responses-bridge'

// The agent frameworks the app can drive over ACP (id union defined in shared settings so the renderer
// and persisted settings share it). Adding one means implementing AgentFramework.
export type { AgentFrameworkId }

// A config file the framework needs on disk before spawn (e.g. a generated opencode.json). The
// runtime writes these and points the framework at them via env/args.
export type AgentConfigFile = {
  path: string
  content: string
  mode?: number
}

// Authentication is sent over ACP after initialize. Keeping it out of the child environment avoids
// Codex copying the key into shell snapshots or its default auth.json file.
export type AgentAuthentication = {
  methodId: string
  _meta?: Record<string, unknown>
}

export type AgentProviderConfiguration = {
  providerId: 'custom-gateway'
  apiType: 'openai'
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
}

// Inputs for translating a provider; paths differ per framework (Claude wants its executable + config
// dir root, opencode wants a location to write its generated config into).
export type ModelConfigContext = {
  // App storage root; frameworks derive their config dir/location beneath it.
  storageRoot: string
  // Absolute path to the detected framework executable (claude / opencode).
  executablePath: string
  responsesBridge?: ResponsesBridgeConnection
  // Combined instructions markdown (connector conventions + tools) for frameworks that lack on-demand
  // skill loading; the adapter writes it and wires it into the agent's instruction mechanism so the
  // agent learns host.mcp instead of reimplementing connector calls with raw HTTP. Empty ⇒ omitted.
  instructions?: string
  // The user's reasoning-effort preference ('default'/undefined ⇒ don't override; the framework
  // injects nothing and the agent keeps its own default). Each framework maps the level onto its
  // native config channel — Codex's model_reasoning_effort, opencode's model options.
  reasoningEffort?: ReasoningEffort
}

// System-prompt guidance the runtime wants appended for a session (artifact routing, notebook, skill
// privacy). The framework decides HOW it is delivered — see SessionSetup.
export type SessionSetupContext = {
  systemPromptAppends: string[]
}

// Framework-specific session configuration returned to the runtime. `meta` becomes the ACP `_meta`
// on session/new and session/resume. `promptPrefix` is prepended to prompt content when the framework
// cannot carry appends in session meta (opencode has no system-prompt preset).
export type SessionSetup = {
  meta?: Record<string, unknown>
  promptPrefix?: string
}

// Already-resolved spawn inputs: env and args come from prepareModelConfig merged over the base
// process env; configFiles are written by the runtime before this call.
export type AgentSpawnInput = {
  executablePath: string
  env: Record<string, string>
  args: string[]
  debug?: boolean
}

// One switchable agent backend. The ACP runtime stays generic and delegates only the framework-coupled
// decisions to this interface. See docs/internal/pluggable-agent-framework-feasibility.md.
export interface AgentFramework {
  readonly id: AgentFrameworkId
  readonly displayName: string

  // Launch the ACP agent subprocess (stdio JSON-RPC), wrapping the per-framework binary + args.
  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams

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

  // Whether the framework accepts stdio MCP servers via ACP session mcpServers. opencode advertises
  // http/sse only, so stdio servers must not be handed to it — the app's artifact/notebook tooling
  // (currently stdio) is gated off for such frameworks until it is exposed over http/sse.
  readonly acceptsStdioMcp: boolean

  // Chat endpoints this framework can drive. A provider is only selectable when it shares one:
  // Claude Code speaks Anthropic /v1/messages; opencode speaks both.
  readonly supportedApiTypes: readonly ChatApiEndpoint[]
}

// The resolved agent backend for one connect: which framework to drive plus its already-resolved spawn
// inputs (executable + env + args). Produced by the settings layer at connect time so a framework or
// provider switch takes effect on reconnect.
export type ResolvedAgentBackend = {
  framework: AgentFramework
  // Stable identity of the framework/provider storage boundary. Two providers can use the same
  // framework while keeping incompatible session stores (for example Codex shared vs isolated login).
  backendId?: string
  executablePath: string
  env: Record<string, string>
  args?: string[]
  // Model to apply per session via the ACP `model` configOption, for frameworks that select the model
  // over the protocol rather than via env (opencode). Undefined ⇒ the framework's env/config drives it
  // (Claude uses ANTHROPIC_MODEL). Applied best-effort: skipped when the agent advertises no match.
  sessionModel?: string
  // Subscription backends must run the model selected in the UI. When true, a missing/rejected live
  // model option fails session creation instead of silently using the agent's account default.
  sessionModelRequired?: boolean
  // Reasoning-effort level to apply per session via the ACP `thought_level` configOption, resolved
  // to the closest level the agent advertises. Undefined ⇒ the agent keeps its own default.
  sessionEffort?: ReasoningEffort
  authentication?: AgentAuthentication
  providerConfiguration?: AgentProviderConfiguration
}
