import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
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

// SPIKE STUB. opencode speaks ACP over `opencode acp` (stdio JSON-RPC). Only the three shapes that
// differ from Claude are filled in: model config (opencode.json, not ANTHROPIC_* env), system-prompt
// delivery (prompt prefix, no preset), and skills (unsupported). Everything else reuses the generic
// runtime. See docs/internal/pluggable-agent-framework-feasibility.md.

// opencode is isolated the way Claude uses CLAUDE_CONFIG_DIR: it reads config from
// $XDG_CONFIG_HOME/opencode and auth/data from $XDG_DATA_HOME/opencode. Pointing both at app-owned
// dirs means the app fully owns opencode's config + auth (the app provider is the only credential)
// and the user's own ~/.config/opencode + auth.json are never read or written. Verified: with these
// set, the user's global providers/auth disappear and only the app-injected provider remains.
const opencodeConfigHome = (storageRoot: string): string => join(storageRoot, 'opencode', 'config')
const opencodeDataHome = (storageRoot: string): string => join(storageRoot, 'opencode', 'data')

// The app's providers are Anthropic `/v1/messages`-compatible (custom gateways and official vendors),
// so they map onto opencode's built-in `anthropic` provider with a `baseURL`/`apiKey` override. An
// OpenAI-format gateway would instead need a custom provider with `npm: "@ai-sdk/openai-compatible"`;
// the app does not expose such providers today, so that branch is intentionally not built yet.
const OPENCODE_PROVIDER_ID = 'anthropic'

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
  const baseProviders = asRecord(baseConfig.provider)
  const baseProvider = asRecord(baseProviders[OPENCODE_PROVIDER_ID])
  const baseOptions = asRecord(baseProvider.options)
  const baseModels = asRecord(baseProvider.models)
  // Preserve any instructions the base config already declared, then append ours (de-duplicated).
  const baseInstructions = Array.isArray(baseConfig.instructions)
    ? baseConfig.instructions.filter((entry): entry is string => typeof entry === 'string')
    : []
  const instructions = [...new Set([...baseInstructions, ...instructionPaths])]

  const merged: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    ...baseConfig,
    ...(bareModel ? { model: `${OPENCODE_PROVIDER_ID}/${bareModel}` } : {}),
    ...(instructions.length > 0 ? { instructions } : {}),
    provider: {
      ...baseProviders,
      [OPENCODE_PROVIDER_ID]: {
        ...baseProvider,
        options: {
          ...baseOptions,
          ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
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
  // opencode has agents/commands, not config-dir skills; hide the skills UI + force-load path.
  supportsSkills: false,
  // Handshake shows opencode advertises mcpCapabilities http+sse only (no stdio). Until the app exposes
  // its artifact/notebook MCP over http, they're gated off for opencode and only basic turns run.
  acceptsStdioMcp: false,
  // opencode speaks both Anthropic /v1/messages and OpenAI /v1/chat/completions.
  supportedApiTypes: ['anthropic', 'openai'],

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    // `opencode acp` starts the ACP subprocess over stdio, matching the app's existing transport.
    return spawn(input.executablePath, ['acp', ...input.args], {
      env: { ...augmentedPathEnv(process.env), ...input.env },
      stdio: 'pipe',
      windowsHide: true
    })
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
    // TODO(spike): check whether opencode's ACP exposes any system-prompt customization to use instead.
    return {
      promptPrefix:
        ctx.systemPromptAppends.length > 0 ? ctx.systemPromptAppends.join('\n\n') : undefined
    }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    // The mapper is already framework-neutral (keys off advertised modes). TODO(spike): confirm the
    // mode ids opencode advertises match Claude's default/auto/bypassPermissions, else add a remap.
    return resolvePermissionProfileApplication(profile, modes)
  }
}
