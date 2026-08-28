import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import type { PermissionProfileId } from '../../shared/permission-profiles'
import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import { openAiChatCompletionsUrl, openAiCompletionsBase } from '../settings/base-url'
import type { ResolvedProvider } from '../settings/provider-env'
import { augmentedPathEnv } from '../settings/shell-path'
import {
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION,
  narrowSkillRuntimeAcpServers
} from '../skills/runtime-mcp-server'
import { isProductionDelegatedWorkFramework } from '../delegation/production-readiness'
import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  SessionSetup,
  SessionSetupContext
} from './types'

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: 'pipe' }
) => ChildProcessWithoutNullStreams

type CodeBuddyFrameworkDeps = {
  platform?: NodeJS.Platform
  sourceEnv?: NodeJS.ProcessEnv
  spawnProcess?: SpawnProcess
}

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

// Keep the native capability surface deliberately narrow. Agent, Skill, Workflow, TaskOutput,
// TaskStop, WebFetch, and WebSearch stay absent so native capabilities cannot bypass Open Science's
// lifecycle, Skill routing, Connector ownership, and permission owners.
const CODEBUDDY_LOCAL_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep']
const CODEBUDDY_CLEANUP_PERIOD_DAYS = 7
const CODEBUDDY_NETWORK_DENY_RULES = [
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(aria2c:*)',
  'Bash(http:*)',
  'Bash(https:*)',
  'Bash(ftp:*)',
  'Bash(lftp:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(sftp:*)',
  'Bash(telnet:*)',
  'Bash(nc:*)',
  'Bash(ncat:*)',
  'Bash(netcat:*)',
  'Bash(socat:*)',
  'Bash(rsync:*)',
  'Bash(git clone:*)',
  'Bash(git fetch:*)',
  'Bash(git pull:*)',
  'Bash(git push:*)',
  'Bash(git ls-remote:*)',
  'Bash(git submodule:*)'
] as const

export const codeBuddyStorageDir = (storageRoot: string): string => join(storageRoot, 'codebuddy')

export const isolateCodeBuddyEnvironment = async (
  env: Readonly<Record<string, string>>,
  configDir: string
): Promise<Record<string, string>> => {
  const sourceConfigDir = env.CODEBUDDY_CONFIG_DIR
  if (sourceConfigDir && sourceConfigDir !== configDir) {
    await cp(sourceConfigDir, configDir, { recursive: true })
  } else {
    await mkdir(configDir, { recursive: true })
  }
  return { ...env, CODEBUDDY_CONFIG_DIR: configDir }
}

export const createCodeBuddyFramework = ({
  platform = process.platform,
  sourceEnv = process.env,
  spawnProcess = spawn as SpawnProcess
}: CodeBuddyFrameworkDeps = {}): AgentFramework => ({
  id: 'codebuddy',
  displayName: 'CodeBuddy',
  contextCompaction: { kind: 'native-command', command: '/compact', triggerAtPercent: 90 },
  supportsSkills: false,
  supportsDelegatedWork: isProductionDelegatedWorkFramework('codebuddy'),
  acceptsStdioMcp: true,
  supportsLiveEffortChange: true,
  adaptSessionEffort: (effort) =>
    effort === 'none' ? 'disabled' : effort === 'default' ? 'enabled' : effort,
  supportedApiTypes: ['openai'],
  serializesProviderPrompts: true,

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(input.executablePath)
    return spawnProcess(
      needsShell ? `"${input.executablePath}"` : input.executablePath,
      ['--acp', ...input.args],
      {
        env: { ...augmentedPathEnv(sourceEnv), ...input.env },
        stdio: 'pipe',
        windowsHide: true,
        shell: needsShell
      }
    )
  },

  async beforePromptDispatch({
    connection,
    providerSessionId,
    cwd,
    mcpServers,
    skillRuntimeAllowlist
  }): Promise<void> {
    await connection.agent.request(acp.methods.agent.session.resume, {
      sessionId: providerSessionId,
      cwd,
      mcpServers: narrowSkillRuntimeAcpServers(mcpServers, skillRuntimeAllowlist)
    })
  },

  prepareModelConfig(provider: ResolvedProvider, ctx: ModelConfigContext): AgentModelConfig {
    const baseUrl = openAiCompletionsBase(provider)
    const chatCompletionsUrl = openAiChatCompletionsUrl(provider)
    if (!baseUrl || !chatCompletionsUrl || !provider.key || !provider.model) {
      throw new Error('CodeBuddy requires an OpenAI-compatible base URL, API key, and model.')
    }

    const configDir = codeBuddyStorageDir(ctx.storageRoot)
    const persistentSystemPrompt = ctx.systemPromptAppends?.filter(Boolean).join('\n\n')
    const systemPromptPath = join(configDir, 'system-prompt.md')
    const maxInputTokens = provider.maxInputTokens ?? provider.contextWindow
    const modelConfig = {
      id: provider.model,
      name: provider.model,
      vendor: provider.vendorId ?? 'OpenAI-compatible',
      apiKey: '${CODEBUDDY_API_KEY}',
      ...(maxInputTokens ? { maxInputTokens } : {}),
      ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
      url: '${OPEN_SCIENCE_CODEBUDDY_CHAT_COMPLETIONS_URL}',
      supportsToolCall: true,
      supportsImages: provider.supportsImageInput === true,
      supportsReasoning: Boolean(ctx.reasoningEfforts?.length)
    }
    return {
      env: {
        CODEBUDDY_CONFIG_DIR: configDir,
        CODEBUDDY_API_KEY: provider.key,
        CODEBUDDY_BASE_URL: baseUrl,
        CODEBUDDY_MODEL: provider.model,
        OPEN_SCIENCE_CODEBUDDY_CHAT_COMPLETIONS_URL: chatCompletionsUrl,
        CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1',
        CODEBUDDY_DISABLE_HOT_RELOAD: '1',
        CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
        CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: '1',
        CODEBUDDY_DISABLE_FORK_SUBAGENT: '1',
        CODEBUDDY_DISABLE_BACKGROUND_TASKS: '1',
        CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CODEBUDDY_DEFER_TOOL_LOADING: '0',
        CODEBUDDY_SKIP_GIT_BASH_CHECK: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        NO_BROWSER: '1'
      },
      configFiles: [
        {
          path: join(configDir, 'models.json'),
          mode: 0o600,
          content: `${JSON.stringify(
            { models: [modelConfig], availableModels: [provider.model] },
            null,
            2
          )}\n`
        },
        {
          path: join(configDir, 'settings.json'),
          mode: 0o600,
          content: `${JSON.stringify(
            {
              cleanupPeriodDays: CODEBUDDY_CLEANUP_PERIOD_DAYS,
              autoCompactEnabled: false,
              permissions: { deny: ['WebFetch', 'WebSearch'] },
              sandbox: {
                enabled: platform !== 'win32',
                autoAllowBashIfSandboxed: false,
                excludedCommands: [],
                allowUnsandboxedCommands: false,
                network: { allowUnixSockets: [], allowLocalBinding: false }
              }
            },
            null,
            2
          )}\n`
        },
        ...(persistentSystemPrompt
          ? [{ path: systemPromptPath, mode: 0o600, content: persistentSystemPrompt }]
          : [])
      ],
      args: [
        '--strict-mcp-config',
        '--setting-sources',
        'user',
        '--tools',
        // Shell execution stays on the app-owned Notebook tool so Python/R requests follow its
        // kernel-routing contract instead of CodeBuddy's prefix-bypassable native Bash rules.
        CODEBUDDY_LOCAL_TOOLS.join(','),
        '--disallowedTools',
        ...CODEBUDDY_NETWORK_DENY_RULES,
        ...(persistentSystemPrompt ? ['--system-prompt-file', systemPromptPath] : [])
      ],
      sessionModel: provider.model,
      ...(persistentSystemPrompt ? { persistentSystemPrompt } : {})
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    const sessionOptions = { ...(ctx.sessionOptions ?? {}) }
    const skillRuntime = recordValue(sessionOptions[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION])
    const externalRetrievalGuidance =
      'Open Science owns external-data routing for CodeBuddy. Do not use WebFetch, WebSearch, or direct HTTP (including curl or wget from Bash or PowerShell) as a fallback for missing or failed Skill/Connector routing. If no routed Skill or Connector is available, report that external retrieval is unavailable.'
    const skillProjectionAvailable =
      ctx.skillRuntimeScope !== undefined &&
      (ctx.skillRuntimeScope === 'all' || ctx.skillRuntimeScope.length > 0) &&
      typeof skillRuntime.root === 'string'
    const skillLoaderGuidance = skillProjectionAvailable
      ? 'Open Science pre-routes and loads required Skill documents into the current turn before CodeBuddy runs. Follow only that current route; do not call `mcp__skills__load_skill`, use Notebook `host.skills`, guess Connector names or methods, or replace a routed Connector with WebFetch, WebSearch, or direct HTTP.'
      : undefined
    const promptPrefix = [
      ...ctx.systemPromptAppends,
      externalRetrievalGuidance,
      skillLoaderGuidance,
      ...(ctx.turnPromptReminders ?? [])
    ]
      .filter(Boolean)
      .join('\n\n')
    return { ...(promptPrefix ? { promptPrefix } : {}) }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    return resolvePermissionProfileApplication(profile, modes, {
      brokerEnforcesFullAccess: true,
      fullAccessModeId: 'fullAccess'
    })
  }
})

export const codeBuddyFramework = createCodeBuddyFramework()
