import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { preferredEndpoint } from '../../shared/settings'
import { normalizeOpenAiBaseUrl } from '../settings/base-url'
import { augmentedPathEnv } from '../settings/shell-path'
import type { ResolvedProvider } from '../settings/provider-env'
import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  SessionSetup,
  SessionSetupContext
} from './types'

// opencode speaks ACP over `opencode acp` (stdio JSON-RPC). Only the shapes that differ from Claude
// are implemented here: model config (a generated opencode.json, not ANTHROPIC_* env), system-prompt
// delivery (a prompt prefix, since opencode has no preset), and skills (materialized into opencode's
// config dir, which its native skill tool discovers). Everything else reuses the generic runtime.
// See docs/internal/pluggable-agent-framework-feasibility.md.

// opencode is isolated the way Claude uses CLAUDE_CONFIG_DIR: it reads config from
// $XDG_CONFIG_HOME/opencode and auth/data from $XDG_DATA_HOME/opencode. Pointing both at app-owned
// dirs means the app fully owns opencode's config + auth (the app provider is the only credential)
// and the user's own ~/.config/opencode + auth.json are never read or written. Verified: with these
// set, the user's global providers/auth disappear and only the app-injected provider remains.
const opencodeConfigHome = (storageRoot: string): string => join(storageRoot, 'opencode', 'config')
const opencodeDataHome = (storageRoot: string): string => join(storageRoot, 'opencode', 'data')

// The root of opencode's app-owned XDG subtree (both config and data live under here): opencode.json,
// materialized skills, connector instructions, and auth.json. The agent's Read tool must never surface
// it, so the runtime adds this to its protected-read roots.
export const opencodeStorageDir = (storageRoot: string): string => join(storageRoot, 'opencode')

// The opencode config directory ($XDG_CONFIG_HOME/opencode) where opencode.json and skills/ live.
// opencode discovers skills at <configDir>/skills/<name>/SKILL.md — the same layout Claude uses under
// its config dir — so the app materializes the enabled skill set here for opencode too.
export const opencodeConfigDir = (storageRoot: string): string =>
  join(opencodeConfigHome(storageRoot), 'opencode')

// The opencode provider block used for each endpoint. Anthropic /v1/messages maps to opencode's
// built-in `anthropic` provider; OpenAI /v1/chat/completions maps to a custom provider backed by the
// `@ai-sdk/openai-compatible` package. opencode drives both, so the endpoint is chosen from the
// provider's apiType (preferring OpenAI when it offers both).
const OPENCODE_ENDPOINT_PROVIDER: Record<'anthropic' | 'openai', { id: string; npm?: string }> = {
  anthropic: { id: 'anthropic' },
  openai: { id: 'openai-compatible', npm: '@ai-sdk/openai-compatible' }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// Builds opencode's config by MERGING the app's active provider/model onto the user's existing config
// so their own providers, mcp servers, and auth are preserved. The model is both selected (top-level
// `model`) and registered under the provider's `models` map — without the registration opencode does
// not recognize a non-catalog model id (e.g. a custom gateway's `deepseek-v4-pro`) and silently falls
// back to its own default. Verified against opencode 1.17.13.
const buildOpencodeConfig = (
  provider: ResolvedProvider,
  baseConfig: Record<string, unknown> = {},
  instructionPaths: string[] = []
): string => {
  const bareModel = provider.model
  // opencode drives both endpoints; pick the one for this provider (openai wins when it offers both).
  const endpoint =
    preferredEndpoint(provider.apiType ?? 'anthropic', ['anthropic', 'openai']) ?? 'anthropic'
  const { id: providerId, npm } = OPENCODE_ENDPOINT_PROVIDER[endpoint]
  // Dual-endpoint vendors (e.g. DeepSeek) serve OpenAI at a different base than Anthropic, so pick the
  // OpenAI base for the openai endpoint; a single-base provider falls back to baseUrl for both. The
  // @ai-sdk/openai-compatible client appends `/chat/completions` to baseURL, so normalize it to end at
  // `/v1` (matching the validator) — a bare root like https://api.deepseek.com would 404 otherwise.
  const rawBase =
    endpoint === 'openai' ? (provider.openaiBaseUrl ?? provider.baseUrl) : provider.baseUrl
  const baseURL =
    endpoint === 'openai' && rawBase ? `${normalizeOpenAiBaseUrl(rawBase)}/v1` : rawBase

  const baseProviders = asRecord(baseConfig.provider)
  const baseProvider = asRecord(baseProviders[providerId])
  const baseOptions = asRecord(baseProvider.options)
  const baseModels = asRecord(baseProvider.models)
  const basePermission = asRecord(baseConfig.permission)
  // Preserve any instructions the base config already declared, then append ours (de-duplicated).
  const baseInstructions = Array.isArray(baseConfig.instructions)
    ? baseConfig.instructions.filter((entry): entry is string => typeof entry === 'string')
    : []
  const instructions = [...new Set([...baseInstructions, ...instructionPaths])]

  const merged: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    ...baseConfig,
    ...(bareModel ? { model: `${providerId}/${bareModel}` } : {}),
    ...(instructions.length > 0 ? { instructions } : {}),
    // Force opencode to ASK the ACP client before every side-effecting tool instead of running
    // silently under its permissive default. opencode keys permissions by TOOL NAME with a "*"
    // catch-all, so the wildcard is essential: without it MCP tools (artifact/notebook/connectors),
    // websearch, task, skill, etc. are unmatched and run without a prompt. Safe read-only tools stay
    // "allow" so Ask mode doesn't prompt on every file read (parity with Claude). Everything else —
    // edit, bash, webfetch, websearch, task, skill, and all MCP tools — hits "*" → ask → the ACP
    // client, where the app enforces the selected profile in its broker (ask prompts, auto approves
    // workspace edits, full approves all). Our rules win over any base config so it can't be disabled.
    permission: {
      ...basePermission,
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow'
    },
    provider: {
      ...baseProviders,
      [providerId]: {
        ...baseProvider,
        // A custom (openai-compatible) provider needs its npm package declared; anthropic is built-in.
        ...(npm ? { npm } : {}),
        options: {
          ...baseOptions,
          ...(baseURL ? { baseURL } : {}),
          ...(provider.key ? { apiKey: provider.key } : {})
        },
        // Register the model so opencode treats a non-catalog id as a real, selectable model.
        ...(bareModel ? { models: { ...baseModels, [bareModel]: {} } } : {})
      }
    }
  }

  return JSON.stringify(merged, null, 2)
}

export { buildOpencodeConfig }

export const opencodeFramework: AgentFramework = {
  id: 'opencode',
  displayName: 'OpenCode',
  // opencode discovers skills natively at <configDir>/skills/<name>/SKILL.md (same layout as Claude),
  // loaded on-demand via its skill tool; the app materializes the enabled set into the isolated config.
  supportsSkills: true,
  // opencode accepts stdio MCP servers over ACP (verified live vs 1.17.13: it launches a stdio server
  // and sends it the MCP initialize handshake). Its mcpCapabilities advertise only http/sse because
  // ACP has no stdio flag — stdio is the baseline transport. So opencode uses the SAME stdio artifact/
  // notebook config as Claude; the http MCP host stays in the runtime but no framework needs it.
  acceptsStdioMcp: true,
  // opencode speaks both Anthropic /v1/messages and OpenAI /v1/chat/completions.
  supportedApiTypes: ['anthropic', 'openai'],

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    // `opencode acp` starts the ACP subprocess over stdio, matching the app's existing transport. On
    // Windows an npm-installed opencode is a `opencode.cmd`/`.bat` shim that Node cannot launch without
    // a shell (spawn EINVAL, same as Claude's cli.js shim), so those go through the shell with the
    // path quoted; a native `.exe`/Unix binary spawns directly.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(input.executablePath)

    return spawn(
      needsShell ? `"${input.executablePath}"` : input.executablePath,
      ['acp', ...input.args],
      {
        env: { ...augmentedPathEnv(process.env), ...input.env },
        stdio: 'pipe',
        windowsHide: true,
        shell: needsShell
      }
    )
  },

  prepareModelConfig(provider: ResolvedProvider, ctx: ModelConfigContext): AgentModelConfig {
    // Isolate opencode via app-owned XDG dirs (mirror of CLAUDE_CONFIG_DIR): opencode reads its config
    // from $XDG_CONFIG_HOME/opencode and auth/data from $XDG_DATA_HOME/opencode. We own the whole
    // config here, so the app provider/model is written clean (no merge with the user's global config).
    const configHome = opencodeConfigHome(ctx.storageRoot)
    const dataHome = opencodeDataHome(ctx.storageRoot)
    const opencodeDir = join(configHome, 'opencode')
    const configPath = join(opencodeDir, 'opencode.json')
    const configFiles = [{ path: configPath, content: '' }]

    // Connector conventions + tools, wired via opencode's `instructions` config so the agent uses
    // host.mcp instead of raw HTTP. Absolute path keeps it independent of the session cwd.
    const instructionPaths: string[] = []
    if (ctx.instructions) {
      const instructionsPath = join(opencodeDir, 'instructions', 'connectors.md')
      instructionPaths.push(instructionsPath)
      configFiles.push({ path: instructionsPath, content: ctx.instructions })
    }

    configFiles[0].content = buildOpencodeConfig(provider, {}, instructionPaths)

    return {
      env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
      configFiles
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    // No claude_code preset here; deliver appends as a prompt prefix instead of session meta.
    return {
      promptPrefix:
        ctx.systemPromptAppends.length > 0 ? ctx.systemPromptAppends.join('\n\n') : undefined
    }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    // opencode advertises `build`/`plan` modes, not Claude's `default`/`bypassPermissions`, so no mode
    // is set here — the app owns permission decisions instead. prepareModelConfig configures opencode
    // to delegate every edit/bash/webfetch prompt to the client (see buildOpencodeConfig), so the broker
    // enforces ask/auto/full app-side. That's why Full access is offered even without a native bypass.
    return resolvePermissionProfileApplication(profile, modes, { brokerEnforcesFullAccess: true })
  }
}
