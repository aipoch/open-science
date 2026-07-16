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

// Env var opencode reads to locate its config file.
const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG'

// Maps the app's Anthropic-compatible custom gateway onto an opencode `anthropic` provider block.
// TODO(spike): verify the real opencode.json schema + `provider/model` id scheme on a live build;
// handle official/local providers and opencode-only providers (defer to `opencode auth login`).
const buildOpencodeConfig = (provider: ResolvedProvider): string => {
  const model = provider.model ? `anthropic/${provider.model}` : undefined

  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      ...(model ? { model } : {}),
      provider: {
        anthropic: {
          options: {
            ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
            ...(provider.key ? { apiKey: provider.key } : {})
          }
        }
      }
    },
    null,
    2
  )
}

export const opencodeFramework: AgentFramework = {
  id: 'opencode',
  displayName: 'opencode',
  // opencode has agents/commands, not config-dir skills; hide the skills UI + force-load path.
  supportsSkills: false,
  // Handshake shows opencode advertises mcpCapabilities http+sse only (no stdio). Until the app exposes
  // its artifact/notebook MCP over http, they're gated off for opencode and only basic turns run.
  acceptsStdioMcp: false,

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    // `opencode acp` starts the ACP subprocess over stdio, matching the app's existing transport.
    return spawn(input.executablePath, ['acp', ...input.args], {
      env: { ...augmentedPathEnv(process.env), ...input.env },
      stdio: 'pipe',
      windowsHide: true
    })
  },

  prepareModelConfig(provider: ResolvedProvider, ctx: ModelConfigContext): AgentModelConfig {
    // opencode reads a config file, not ANTHROPIC_* env; point OPENCODE_CONFIG at a generated one.
    const configPath = join(ctx.storageRoot, 'opencode', 'opencode.json')

    return {
      env: { [OPENCODE_CONFIG_ENV]: configPath },
      configFiles: [{ path: configPath, content: buildOpencodeConfig(provider) }]
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
