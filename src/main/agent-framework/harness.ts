import {
  resolveChatReasoningTransport,
  resolveMessagesReasoningTransport,
  resolveResponsesReasoningTransport
} from '@aipoch/providers/protocol'
import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { resolvePermissionProfileApplication } from '../acp/permission-profile-controller'
import { isProductionDelegatedWorkFramework } from '../delegation/production-readiness'
import {
  createSkillRuntimeAcpServerConfig,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION,
  type SkillRuntimeMcpServerConfig
} from '../skills/runtime-mcp-server'
import {
  HARNESS_ACP_ARG,
  HARNESS_AUTH_METHOD,
  HARNESS_INSTRUCTIONS,
  HARNESS_TOOL_LESS,
  harnessConfigSchema
} from '../harness-acp/config'
import type { AgentFramework } from './types'

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
  supportsLiveEffortChange: false,
  supportedApiTypes: ['chat-completions', 'responses', 'messages'],
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
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {})
      }
    })
  },
  prepareModelConfig(provider, context) {
    const connection = context.responsesConnection
    if (!connection || !provider.model || !isAbsolute(context.storageRoot))
      throw new Error('Built-in Agent requires a host-owned model connection')
    const contextWindow = provider.contextWindow ?? 32_768
    const protocol = provider.apiEndpoints?.[0] ?? 'chat-completions'
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
      maxOutputTokens: Math.min(provider.maxOutputTokens ?? 4096, Math.floor(contextWindow / 4)),
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
