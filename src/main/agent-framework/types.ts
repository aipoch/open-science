import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import type { PermissionProfileApplication } from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { AgentFrameworkId } from '../../shared/settings'
import type { ResolvedProvider } from '../settings/provider-env'

// The agent frameworks the app can drive over ACP (id union defined in shared settings so the renderer
// and persisted settings share it). Adding one means implementing AgentFramework.
export type { AgentFrameworkId }

// A config file the framework needs on disk before spawn (e.g. a generated opencode.json). The
// runtime writes these and points the framework at them via env/args.
export type AgentConfigFile = {
  path: string
  content: string
}

// How the app's provider maps onto a framework's native model configuration. Claude reads env
// (ANTHROPIC_*); opencode reads a generated config file referenced by OPENCODE_CONFIG. Fields are
// merged over the spawn base, so an empty result just spawns with inherited defaults.
export type AgentModelConfig = {
  env?: Record<string, string>
  configFiles?: AgentConfigFile[]
  args?: string[]
}

// Inputs for translating a provider; paths differ per framework (Claude wants its executable + config
// dir root, opencode wants a location to write its generated config into).
export type ModelConfigContext = {
  // App storage root; frameworks derive their config dir/location beneath it.
  storageRoot: string
  // Absolute path to the detected framework executable (claude / opencode).
  executablePath: string
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
}

// The resolved agent backend for one connect: which framework to drive plus its already-resolved spawn
// inputs (executable + env + args). Produced by the settings layer at connect time so a framework or
// provider switch takes effect on reconnect.
export type ResolvedAgentBackend = {
  framework: AgentFramework
  executablePath: string
  env: Record<string, string>
  args?: string[]
  // Model to apply per session via the ACP `model` configOption, for frameworks that select the model
  // over the protocol rather than via env (opencode). Undefined ⇒ the framework's env/config drives it
  // (Claude uses ANTHROPIC_MODEL). Applied best-effort: skipped when the agent advertises no match.
  sessionModel?: string
}
