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
import { isProductionDelegatedWorkFramework } from '../delegation/production-readiness'
import { renderAppMcpToolReferences } from './app-mcp-names'
import {
  LOAD_SKILL_TOOL_CALLABLE_NAME,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION,
  SKILL_RUNTIME_MCP_SERVER_NAME,
  createSkillRuntimeMcpServerConfig
} from '../skills/runtime-mcp-server'

// Select Claude Code's complete built-in tool set explicitly instead of relying on
// claude-agent-acp's current fallback. This keeps WebFetch/WebSearch available if the adapter's
// default changes, while reviewer sessions can still replace this with `tools: []` at their boundary.
const CLAUDE_CODE_BUILTIN_TOOLS = { type: 'preset', preset: 'claude_code' } as const

// Claude's Agent tool (formerly Task), Workflows, and team messaging can create or control work
// outside the app-owned Frame/Attempt graph. Keep the complete ordinary Claude Code preset, but
// remove native delegation entry points. Native execution is filtered separately below.
const CLAUDE_CODE_NATIVE_DELEGATION_TOOLS = Object.freeze([
  'Agent',
  'Task',
  'Workflow',
  'SendMessage',
  'TeamCreate',
  'TeamDelete'
] as const)

// Shell execution is app-owned so every framework follows the Notebook runtime's managed working
// directory, environment-mutation guard, permission identity, and durable Run recording contract.
const CLAUDE_CODE_NATIVE_EXECUTION_TOOLS = Object.freeze(['Bash'] as const)
const CLAUDE_CODE_DISABLED_AUTO_MEMORY_ENV = Object.freeze({
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
})

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const stringArrayValue = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

// Claude Code adapter. A faithful extraction of behavior currently inline in AcpRuntime /
// agent-process / provider-env — moving the runtime onto AgentFramework must not change it.
export const claudeCodeFramework: AgentFramework = {
  id: 'claude-code',
  displayName: 'Claude Code',
  contextCompaction: {
    kind: 'native-command',
    command: '/compact',
    triggerAtPercent: 90,
    failureTextPrefix: 'Compacting failed'
  },
  supportsSkills: true,
  supportsDelegatedWork: isProductionDelegatedWorkFramework('claude-code'),
  // Claude launches stdio MCP servers directly — the app's artifact/notebook tooling relies on this.
  acceptsStdioMcp: true,
  // The adapter advertises an `effort` select (category thought_level) and applies changes to live
  // sessions via applyFlagSettings — no respawn needed.
  supportsLiveEffortChange: true,
  // Claude Code speaks only Anthropic /v1/messages.
  supportedApiTypes: ['anthropic'],

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
    // settingSources:['user'] excludes workspace settings that could override the active provider.
    // Shared mode adds app-owned settings/plugins at the SDK flag layer via sessionOptions.
    const sessionOptions = { ...(ctx.sessionOptions ?? {}) }
    const skillRuntime = recordValue(sessionOptions[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION])
    delete sessionOptions[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]
    const skillRuntimeEnabled =
      ctx.skillRuntimeScope !== undefined &&
      (ctx.skillRuntimeScope === 'all' || ctx.skillRuntimeScope.length > 0) &&
      typeof skillRuntime.root === 'string' &&
      typeof skillRuntime.command === 'string' &&
      typeof skillRuntime.entryPath === 'string'
    const mcpServers = skillRuntimeEnabled
      ? {
          ...recordValue(sessionOptions.mcpServers),
          [SKILL_RUNTIME_MCP_SERVER_NAME]: createSkillRuntimeMcpServerConfig({
            command: skillRuntime.command as string,
            entryPath: skillRuntime.entryPath as string,
            root: skillRuntime.root as string,
            ...(ctx.skillRuntimeScope !== 'all' ? { allowedNames: ctx.skillRuntimeScope } : {})
          })
        }
      : sessionOptions.mcpServers
    const toolAliases = skillRuntimeEnabled
      ? {
          ...recordValue(sessionOptions.toolAliases),
          Skill: LOAD_SKILL_TOOL_CALLABLE_NAME
        }
      : sessionOptions.toolAliases
    const sessionHooks = recordValue(sessionOptions.hooks)
    const hooks = skillRuntimeEnabled
      ? {
          ...sessionHooks,
          PreToolUse: [
            ...(Array.isArray(sessionHooks.PreToolUse) ? sessionHooks.PreToolUse : []),
            {
              matcher: LOAD_SKILL_TOOL_CALLABLE_NAME,
              hooks: [
                async () => ({
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: 'allow' as const
                  }
                })
              ]
            }
          ]
        }
      : sessionOptions.hooks
    const disallowedTools = Object.freeze([
      ...new Set([
        ...stringArrayValue(sessionOptions.disallowedTools),
        ...CLAUDE_CODE_NATIVE_DELEGATION_TOOLS,
        ...CLAUDE_CODE_NATIVE_EXECUTION_TOOLS
      ])
    ])
    const managedSettings = Object.freeze({
      ...recordValue(sessionOptions.managedSettings),
      disableAgentView: true,
      disableWorkflows: true,
      workflowKeywordTriggerEnabled: false
    })
    const configuredSettings = sessionOptions.settings
    // The ACP adapter resolves string paths against the later session cwd, after this synchronous
    // boundary has lost the chance to enforce settings.env. Require callers to resolve files first
    // so app-owned policy cannot be reopened by a higher-priority settings file.
    if (typeof configuredSettings === 'string') {
      throw new Error(
        'Claude Code session settings must be resolved before building ACP session metadata.'
      )
    }
    const settingsValues = recordValue(configuredSettings)
    // Claude applies settings.env after the subprocess env, so enforce the same session-only flag
    // in the programmatic settings tier while preserving app-owned settings and their environment.
    const settings = Object.freeze({
      ...settingsValues,
      env: Object.freeze({
        ...recordValue(settingsValues.env),
        ...CLAUDE_CODE_DISABLED_AUTO_MEMORY_ENV
      })
    })
    const env = Object.freeze({
      ...recordValue(sessionOptions.env),
      ...CLAUDE_CODE_DISABLED_AUTO_MEMORY_ENV,
      CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
      CLAUDE_CODE_DISABLE_WORKFLOWS: '1'
    })
    const meta: Record<string, unknown> = {
      claudeCode: {
        // ACP's usage total omits the latest model-step split and Claude SDK's agentic turn count.
        // Request only the two raw frame types needed to retain those facts.
        emitRawSDKMessages: [{ type: 'assistant' }, { type: 'result' }],
        options: {
          tools: CLAUDE_CODE_BUILTIN_TOOLS,
          settingSources: ['user'],
          ...sessionOptions,
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(toolAliases !== undefined ? { toolAliases } : {}),
          ...(hooks !== undefined ? { hooks } : {}),
          disallowedTools,
          managedSettings,
          settings,
          env,
          ...(ctx.skillWhitelist !== undefined ? { skills: ctx.skillWhitelist } : {})
        }
      }
    }

    const persistentSystemPrompt = ctx.systemPromptAppends
      .map((append) => renderAppMcpToolReferences('claude-code', append))
      .filter(Boolean)
      .join('\n\n')
    if (persistentSystemPrompt) {
      meta.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: persistentSystemPrompt
      }
    }

    const promptPrefix = ctx.turnPromptReminders
      ?.map((append) => renderAppMcpToolReferences('claude-code', append))
      .filter(Boolean)
      .join('\n\n')

    return {
      meta,
      ...(persistentSystemPrompt ? { persistentSystemPrompt } : {}),
      ...(promptPrefix ? { promptPrefix } : {})
    }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    return resolvePermissionProfileApplication(profile, modes)
  }
}

export { CLAUDE_CODE_NATIVE_DELEGATION_TOOLS }
