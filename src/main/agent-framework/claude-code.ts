import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import { spawnClaudeAgentAcp } from '../acp/agent-process'
import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import { buildProviderEnv, type ResolvedProvider } from '../settings/provider-env'
import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  SessionSetup,
  SessionSetupContext
} from './types'

// Claude Code adapter. A faithful extraction of behavior currently inline in AcpRuntime /
// agent-process / provider-env — moving the runtime onto AgentFramework must not change it.
export const claudeCodeFramework: AgentFramework = {
  id: 'claude-code',
  displayName: 'Claude Code',
  supportsSkills: true,
  // Claude launches stdio MCP servers directly — the app's artifact/notebook tooling relies on this.
  acceptsStdioMcp: true,

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    // Still routes through the existing spawner; env carries the resolved provider overrides.
    return spawnClaudeAgentAcp({
      envOverrides: input.env,
      executablePath: input.executablePath
    })
  },

  prepareModelConfig(provider: ResolvedProvider, ctx: ModelConfigContext): AgentModelConfig {
    // Anthropic-shaped env (ANTHROPIC_* + CLAUDE_CONFIG_DIR/CLAUDE_CODE_EXECUTABLE).
    return {
      env: buildProviderEnv(provider, {
        storageRoot: ctx.storageRoot,
        claudeExecutablePath: ctx.executablePath
      })
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    // settingSources:['user'] pins the app-owned config dir so a workspace ~/.claude env can't override
    // the active provider endpoint. Appends ride the claude_code system-prompt preset.
    const meta: Record<string, unknown> = {
      claudeCode: { options: { settingSources: ['user'] } }
    }

    if (ctx.systemPromptAppends.length > 0) {
      meta.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: ctx.systemPromptAppends.join('\n\n')
      }
    }

    return { meta }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    return resolvePermissionProfileApplication(profile, modes)
  }
}
