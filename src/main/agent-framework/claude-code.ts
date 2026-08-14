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
import { rebaseSkillRuntimeEnvironment, skillRuntimeEnvironment } from './skill-runtime-binding'

// Select Claude Code's complete built-in tool set explicitly instead of relying on
// claude-agent-acp's current fallback. This keeps WebFetch/WebSearch available if the adapter's
// default changes, while reviewer sessions can still replace this with `tools: []` at their boundary.
const CLAUDE_CODE_BUILTIN_TOOLS = { type: 'preset', preset: 'claude_code' } as const

// Claude's Agent tool (formerly Task), Workflows, and team messaging can create or control work
// outside the app-owned Frame/Attempt graph. Keep the complete ordinary Claude Code preset,
// including TaskOutput/TaskStop for background shell jobs, but remove native delegation entry points.
const CLAUDE_CODE_NATIVE_DELEGATION_TOOLS = Object.freeze([
  'Agent',
  'Task',
  'Workflow',
  'SendMessage',
  'TeamCreate',
  'TeamDelete'
] as const)

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const stringArrayValue = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

const arrayValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

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
      env: {
        ...skillRuntimeEnvironment(ctx.skillRuntime),
        ...buildProviderEnv(provider, {
          storageRoot: ctx.storageRoot,
          claudeExecutablePath: ctx.executablePath
        })
      },
      ...(ctx.skillRuntime ? { skillRuntime: ctx.skillRuntime } : {})
    }
  },

  rebaseSkillRuntime: rebaseSkillRuntimeEnvironment,

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    // settingSources:['user'] excludes workspace settings that could override the active provider.
    // Shared mode adds app-owned settings/plugins at the SDK flag layer via sessionOptions.
    const sessionOptions = ctx.sessionOptions ?? {}
    const skillRuntime = ctx.skillRuntime
    const disallowedTools = Object.freeze([
      ...new Set([
        ...stringArrayValue(sessionOptions.disallowedTools),
        ...CLAUDE_CODE_NATIVE_DELEGATION_TOOLS
      ])
    ])
    const managedSettings = Object.freeze({
      ...recordValue(sessionOptions.managedSettings),
      disableAgentView: true,
      disableWorkflows: true,
      workflowKeywordTriggerEnabled: false,
      // Claude's managed-settings schema keeps plugin customizations available while closing the
      // stable CLAUDE_CONFIG_DIR and project Skill directories. The runtime projection is supplied
      // as the only local plugin below, so rollback-owned Skills cannot join native discovery.
      strictPluginOnlyCustomization: Object.freeze(['skills'] as const)
    })
    const env = Object.freeze({
      ...recordValue(sessionOptions.env),
      // Runtime/cache ownership is an application invariant, not a caller preference. Keep these
      // values authoritative even when a legacy session option happens to use the same variable.
      ...skillRuntimeEnvironment(skillRuntime),
      CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
      CLAUDE_CODE_DISABLE_WORKFLOWS: '1'
    })
    const plugins = skillRuntime
      ? Object.freeze([
          ...arrayValue(sessionOptions.plugins),
          ...(arrayValue(sessionOptions.plugins).some(
            (plugin) =>
              recordValue(plugin).type === 'local' &&
              recordValue(plugin).path === skillRuntime.projectionRoot
          )
            ? []
            : [
                {
                  type: 'local',
                  // The runtime plugin contains no MCP manifest. Omitting skipMcpDiscovery keeps
                  // this compatible with Claude Code releases that support --plugin-dir but not
                  // the newer SDK-generated --plugin-dir-no-mcp flag.
                  path: skillRuntime.projectionRoot
                }
              ])
        ])
      : sessionOptions.plugins
    const additionalDirectories = skillRuntime
      ? Object.freeze([
          ...new Set([
            ...stringArrayValue(sessionOptions.additionalDirectories),
            skillRuntime.projectionRoot
          ])
        ])
      : sessionOptions.additionalDirectories
    const sandbox = skillRuntime
      ? (() => {
          const baseSandbox = recordValue(sessionOptions.sandbox)
          const baseFilesystem = recordValue(baseSandbox.filesystem)
          return Object.freeze({
            ...baseSandbox,
            filesystem: Object.freeze({
              ...baseFilesystem,
              allowRead: Object.freeze([
                ...new Set([
                  ...stringArrayValue(baseFilesystem.allowRead),
                  skillRuntime.projectionRoot
                ])
              ]),
              denyWrite: Object.freeze([
                ...new Set([
                  ...stringArrayValue(baseFilesystem.denyWrite),
                  skillRuntime.projectionRoot
                ])
              ])
            })
          })
        })()
      : sessionOptions.sandbox
    const meta: Record<string, unknown> = {
      claudeCode: {
        // ACP's usage total omits the latest model-step split and Claude SDK's agentic turn count.
        // Request only the two raw frame types needed to retain those facts.
        emitRawSDKMessages: [{ type: 'assistant' }, { type: 'result' }],
        options: {
          tools: CLAUDE_CODE_BUILTIN_TOOLS,
          settingSources: ['user'],
          ...sessionOptions,
          disallowedTools,
          managedSettings,
          env,
          ...(plugins !== undefined ? { plugins } : {}),
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(sandbox !== undefined ? { sandbox } : {}),
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
