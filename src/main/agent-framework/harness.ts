import {
  resolveChatReasoningTransport,
  resolveMessagesReasoningTransport,
  resolveResponsesReasoningTransport
} from '@aipoch/providers/protocol'
import { resolveProviderOutputLimit } from '../settings/provider-env'
import { preferredEndpoint } from '../../shared/settings-runtime'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runtimeMetadataIfConfigured } from '../runtime-metadata'
import { resolveBootstrapConfigRoot } from '../storage/config-root'
import { resolvePermissionProfileApplication } from '../acp/permission-profile-controller'
import { nodeRuntimeEnvironment } from '../node-process-host'
import { isProductionDelegatedWorkFramework } from '../delegation/production-readiness'
import {
  createSkillRuntimeAcpServerConfig,
  type SkillRuntimeMcpServerConfig
} from '../skills/runtime-mcp-config'
import { OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION } from '../skills/runtime-mcp-constants'
import {
  HARNESS_ACP_ARG,
  HARNESS_AUTH_METHOD,
  HARNESS_INSTRUCTIONS,
  HARNESS_OTLP_ENV_FILE,
  HARNESS_OTLP_SWITCHES,
  HARNESS_OTLP_TRACES_ENDPOINT,
  HARNESS_OTLP_TRACES_HEADERS_FILE,
  HARNESS_TOOL_LESS,
  harnessConfigSchema
} from '../harness-acp/config'
import type { AgentFramework } from './types'

function traceEnvFile(executablePath: string): string | undefined {
  try {
    const runtime = runtimeMetadataIfConfigured()
    return runtime?.packaged
      ? join(resolveBootstrapConfigRoot(runtime.homePath, true), '.env')
      : resolve(dirname(executablePath), '../..', '.env')
  } catch {
    return undefined
  }
}

export const harnessFramework: AgentFramework<'open-science-agent'> = {
  id: 'open-science-agent',
  displayName: 'Open-Science Agent',
  commandShellDialect: 'posix',
  contextCompaction: { kind: 'framework-managed' },
  supportsSkills: true,
  supportsDelegatedWork: isProductionDelegatedWorkFramework('open-science-agent'),
  prepareDelegatedSpawn: async (backend, runtimeHome) => ({
    executablePath: backend.executablePath,
    args: [HARNESS_ACP_ARG, join(runtimeHome, 'open-science-agent', 'sessions')],
    env: {}
  }),
  acceptsStdioMcp: false,
  acceptsReviewerMcpSocket: true,
  supportsLiveEffortChange: false,
  supportedApiTypes: ['responses', 'messages', 'chat-completions'],
  spawn(input) {
    if (
      !isAbsolute(input.executablePath) ||
      input.args.length !== 2 ||
      input.args[0] !== HARNESS_ACP_ARG ||
      !isAbsolute(input.args[1])
    )
      throw new Error('Invalid built-in Agent launch configuration')
    return (input.spawnProcess ?? spawn)(process.execPath, [input.executablePath, ...input.args], {
      stdio: 'pipe',
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ...nodeRuntimeEnvironment(),
        [HARNESS_OTLP_ENV_FILE]: traceEnvFile(input.executablePath),
        [HARNESS_OTLP_TRACES_ENDPOINT]: process.env[HARNESS_OTLP_TRACES_ENDPOINT],
        [HARNESS_OTLP_TRACES_HEADERS_FILE]: process.env[HARNESS_OTLP_TRACES_HEADERS_FILE],
        ...Object.fromEntries(HARNESS_OTLP_SWITCHES.map((name) => [name, process.env[name]])),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      }
    })
  },
  prepareModelConfig(provider, context) {
    const connection = context.responsesConnection
    if (!connection || !provider.model || !isAbsolute(context.storageRoot))
      throw new Error('Built-in Agent requires a host-owned model connection')
    const contextWindow = provider.contextWindow ?? 32_768
    const protocol =
      preferredEndpoint(
        provider.apiEndpoints ?? ['responses'],
        harnessFramework.supportedApiTypes
      ) ?? 'responses'
    const reasoning = context.reasoningEffort
      ? resolveChatReasoningTransport(
          provider.vendorId,
          provider.model,
          context.reasoningEffort,
          provider.reasoningEffortTransport
        )
      : undefined
    const messagesReasoning =
      context.reasoningEffort && protocol === 'messages'
        ? resolveMessagesReasoningTransport(
            provider.vendorId,
            provider.model,
            context.reasoningEffort,
            provider.reasoningEffortTransport
          )
        : undefined
    const config = harnessConfigSchema.parse({
      protocol,
      endpoint: `${connection.baseUrl}/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`,
      token: connection.token,
      model: provider.model,
      modelIdentity: provider.agentProviderId,
      ...(provider.vendorId === 'minimax'
        ? {
            inputCapabilities: {
              images: provider.supportsImageInput === true,
              files: false,
              audio: false,
              video: /^MiniMax-M3(?:$|[.-])/.test(provider.model)
            }
          }
        : { inputCapabilities: { images: provider.supportsImageInput === true } }),
      ...(['opencode', 'opencode-go'].includes(provider.vendorId ?? '')
        ? { sessionHeader: 'x-opencode-session' }
        : {}),
      contextWindow,
      maxOutputTokens:
        protocol === 'messages' ? resolveProviderOutputLimit(provider) : provider.maxOutputTokens,
      parameters:
        protocol === 'responses'
          ? {
              store: false,
              ...(context.reasoningEffort
                ? resolveResponsesReasoningTransport(
                    provider.vendorId,
                    provider.model,
                    context.reasoningEffort
                  )
                : {})
            }
          : protocol === 'messages'
            ? {
                ...(messagesReasoning?.thinking ? { thinking: messagesReasoning.thinking } : {}),
                ...(messagesReasoning?.outputConfig
                  ? { output_config: messagesReasoning.outputConfig }
                  : {})
              }
            : {
                ...(/(?:^|\/)minimax-/i.test(provider.model) ? { reasoning_split: true } : {}),
                ...(reasoning?.reasoningEffort
                  ? { reasoning_effort: reasoning.reasoningEffort }
                  : {}),
                ...(reasoning?.thinking ? { thinking: reasoning.thinking } : {}),
                ...(reasoning?.reasoning ? { reasoning: reasoning.reasoning } : {})
              }
    })
    return {
      env: {},
      args: [HARNESS_ACP_ARG, join(context.storageRoot, 'open-science-agent', 'sessions')],
      authentication: { methodId: HARNESS_AUTH_METHOD, _meta: { 'open-science-agent': config } },
      sessionModel: provider.model
    }
  },
  buildSessionSetup(context) {
    const instructions = context.systemPromptAppends.filter(Boolean).join('\n\n')
    const runtime = context.sessionOptions?.[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION] as
      SkillRuntimeMcpServerConfig | undefined
    const scope = context.skillRuntimeScope
    return {
      ...(runtime && scope !== undefined && (scope === 'all' || scope.length > 0)
        ? {
            mcpServers: [
              createSkillRuntimeAcpServerConfig({
                ...runtime,
                ...(scope !== 'all' ? { allowedNames: scope } : {})
              })
            ]
          }
        : {}),
      meta: {
        [HARNESS_INSTRUCTIONS]: instructions,
        ...(context.toolLess ? { [HARNESS_TOOL_LESS]: true } : {})
      },
      persistentSystemPrompt: instructions,
      ...(context.turnPromptReminders?.length
        ? { promptPrefix: context.turnPromptReminders.join('\n\n') }
        : {})
    }
  },
  mapPermissionProfile: (profile, modes) =>
    resolvePermissionProfileApplication(profile, modes, {
      brokerEnforcesFullAccess: true
    })
}
