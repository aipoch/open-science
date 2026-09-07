import { z } from 'zod'
import {
  CODEX_ISOLATED_PROVIDER_ID,
  canUseClaudeProviderTransport,
  DEFAULT_REASONING_EFFORT,
  isCodexSubscriptionProvider,
  shareProviderTransportFamily,
  usesAppProviderTransport,
  type ReasoningEffort
} from '../../shared/settings'
import {
  resolveReasoningEffortValue,
  type ModelReasoningEffort,
  type ResolvedReasoningEffort
} from '../../shared/reasoning-effort'
import { usesVendorAnthropicApiKeyHeader } from '../../shared/provider-registry'
import {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
} from '../../shared/skill-import'
import { ARTIFACT_MCP_SERVER_NAME, writeArtifactFileToolSchema } from '../artifacts/mcp-server'
import {
  getAgentFramework,
  type AgentFrameworkId,
  type AgentModelCatalogEntry,
  type AgentModelChangeTarget,
  type AgentModelRoute
} from '../agent-framework'
import { CODEX_BRIDGE_MODEL, normalizeResponsesBaseUrl } from '../agent-framework/codex'
import { opencodeTransportProviderId } from '../agent-framework/opencode'
import { NOTEBOOK_MCP_SERVER_NAME, NOTEBOOK_RPC_TOOLS } from '../notebook/mcp-server'
import { REVIEWER_BRIDGE_NAMESPACED_TOOLS } from '../reviewer/bridge-tools'
import { requestSkillImportToolSchema } from '../skills/mcp-server'
import type { AnthropicProviderBridgeTarget } from './anthropic-provider-bridge'
import {
  normalizeAnthropicBaseUrl,
  openAiChatCompletionsUrl,
  openAiCompletionsBase
} from './base-url'
import type { ClaudeRuntimeModelConfig } from './claude-config-provision'
import type { ProviderAccountsModule, ProviderRuntimeTarget } from './provider-accounts'
import type { ResponsesBridgeNamespacedTool } from './responses-bridge'
import type { StoredSettings } from './types'
type BackendRouteProviderPort = Pick<
  ProviderAccountsModule,
  'resolveRuntimeTarget' | 'resolveRuntimeModelCatalog'
>
type BackendRoutePlanInput = Readonly<{
  settings: StoredSettings
  frameworkId: AgentFrameworkId
  target: ProviderRuntimeTarget
  effortIntent: ReasoningEffort
  resolvedEffort?: ResolvedReasoningEffort
  conversationSkillImportEnabled: boolean
  forceNativeResponsesCompatibility?: boolean
}>
type BackendModelChangePlanInput = Omit<
  BackendRoutePlanInput,
  'conversationSkillImportEnabled' | 'forceNativeResponsesCompatibility'
>
type PlannedProviderTarget = Readonly<{
  id: string
  target: ProviderRuntimeTarget
  reasoningEffort?: ModelReasoningEffort
  reasoningEfforts?: readonly ModelReasoningEffort[]
}>
type BackendTransportPlan =
  | Readonly<{ kind: 'direct' }>
  | Readonly<{
      kind: 'codebuddy-provider-compatibility'
      wire: 'anthropic' | 'responses'
    }>
  | Readonly<{
      kind: 'claude-anthropic'
      targets: readonly AnthropicProviderBridgeTarget[]
      initialTargetId: string
    }>
  | Readonly<{
      kind:
        | 'opencode-anthropic'
        | 'opencode-openai'
        | 'codex-chat'
        | 'codex-responses-compatibility'
        | 'codex-native-responses'
      targets: readonly PlannedProviderTarget[]
      initialTargetId?: string
    }>
type BackendRoutePlan = Readonly<{
  modelRoute: AgentModelRoute
  backendProviderId: string
  sessionEffort?: ModelReasoningEffort
  supportedReasoningEfforts?: readonly ModelReasoningEffort[]
  providerModelCatalog: readonly AgentModelCatalogEntry[]
  transport: BackendTransportPlan
  claudeModelConfig?: ClaudeRuntimeModelConfig
  codexBridgeTools?: readonly ResponsesBridgeNamespacedTool[]
  reviewerBridgeTools?: readonly ResponsesBridgeNamespacedTool[]
}>
const modelRouteFor = (
  frameworkId: AgentFrameworkId,
  target: ProviderRuntimeTarget
): AgentModelRoute => {
  if (frameworkId === 'claude-code') return 'claude-anthropic'
  if (frameworkId === 'opencode') {
    return target.apiEndpoints.includes('openai') ? 'opencode-openai' : 'opencode-anthropic'
  }
  if (frameworkId === 'codebuddy') return 'codebuddy-openai'
  if (target.needsChatResponsesBridge) return 'codex-bridge'
  if (target.needsNativeResponsesCompatibility) return 'codex-responses-compatibility'
  return 'codex-responses'
}
const modelEffort = (
  intent: ReasoningEffort,
  target: ProviderRuntimeTarget
): ResolvedReasoningEffort =>
  intent === DEFAULT_REASONING_EFFORT
    ? DEFAULT_REASONING_EFFORT
    : resolveReasoningEffortValue(intent, target.reasoningEffortProfile)
const claudeTargetId = (providerId: string, model: string): string =>
  JSON.stringify([providerId, model])
const transportTargetId = (
  frameworkId: AgentFrameworkId,
  providerId: string,
  model: string
): string => JSON.stringify([frameworkId, providerId, model])
const namespaceFor = (serverName: string): string =>
  `mcp__${serverName.replace(/[^a-zA-Z0-9_]/g, '_')}`
const NOTEBOOK_TOOLS: ResponsesBridgeNamespacedTool[] = NOTEBOOK_RPC_TOOLS.map((tool) => ({
  namespace: namespaceFor(NOTEBOOK_MCP_SERVER_NAME),
  name: tool.name,
  description:
    tool.name === 'notebook_execute'
      ? `${tool.description} For Open Science data connectors, the Python code MUST call host.mcp(server, method, arguments). Never use requests, urllib, httpx, curl, or a raw upstream API for connector data; those bypass app permissions, credentials, and rate limits. Codex MCP resource-list tools are not connector discovery.`
      : tool.description,
  parameters: z.toJSONSchema(z.object(tool.inputSchema), {
    target: 'draft-7'
  }) as ResponsesBridgeNamespacedTool['parameters']
}))
const ARTIFACT_TOOLS: ResponsesBridgeNamespacedTool[] = [
  {
    namespace: namespaceFor(ARTIFACT_MCP_SERVER_NAME),
    name: 'write_artifact_file',
    description:
      'Attach a generated image, chart, report, data export, or archive to the current Open Science response. The file must already exist before using a localPath source.',
    parameters: z.toJSONSchema(z.object(writeArtifactFileToolSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]
const SKILL_IMPORT_TOOLS: ResponsesBridgeNamespacedTool[] = [
  {
    namespace: namespaceFor(SKILL_IMPORT_MCP_SERVER_NAME),
    name: REQUEST_SKILL_IMPORT_TOOL_NAME,
    description: REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
    parameters: z.toJSONSchema(z.object(requestSkillImportToolSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]
class BackendRoutePlanner {
  private readonly providers: BackendRouteProviderPort
  constructor({ providers }: { providers: BackendRouteProviderPort }) {
    this.providers = providers
  }
  planBackend(input: BackendRoutePlanInput): BackendRoutePlan {
    const configuredRoute = modelRouteFor(input.frameworkId, input.target)
    const forcedCompatibility =
      input.forceNativeResponsesCompatibility === true &&
      input.frameworkId === 'codex' &&
      configuredRoute === 'codex-responses'
    if (forcedCompatibility && isCodexSubscriptionProvider(input.target.provider.type)) {
      throw new Error(
        'Artifact code reconstruction is unavailable with Codex subscription authentication.'
      )
    }
    const modelRoute = forcedCompatibility ? 'codex-responses-compatibility' : configuredRoute
    const resolvedEffort = input.resolvedEffort ?? modelEffort(input.effortIntent, input.target)
    const sessionEffort = resolvedEffort === 'default' ? undefined : resolvedEffort
    const supportedReasoningEfforts = input.target.reasoningEffortProfile.supported
      ? [...new Set(input.target.reasoningEffortProfile.slots)]
      : undefined
    const routeCandidates = this.routeCandidates(
      input.settings,
      input.target,
      input.frameworkId,
      modelRoute
    )
    const retargetable = new Set(routeCandidates.map(({ providerId }) => providerId)).size >= 2
    const activeProvider = input.settings.providers.find(({ id }) => id === input.target.providerId)
    const catalogSource =
      input.frameworkId === 'codex' && retargetable
        ? routeCandidates
        : input.frameworkId === 'claude-code'
          ? []
          : activeProvider
            ? this.providers.resolveRuntimeModelCatalog(
                activeProvider,
                getAgentFramework(input.frameworkId)
              )
            : []
    const providerModelCatalog = this.modelCatalog(
      catalogSource,
      input.frameworkId,
      modelRoute,
      input.effortIntent
    )
    const backendProviderId =
      input.frameworkId === 'codex' && isCodexSubscriptionProvider(input.target.provider.type)
        ? CODEX_ISOLATED_PROVIDER_ID
        : input.target.providerId
    const transport = this.transportPlan(
      input.target,
      input.frameworkId,
      modelRoute,
      routeCandidates,
      retargetable,
      input.effortIntent
    )
    const claudeModelConfig =
      input.frameworkId === 'claude-code' && input.target.provider.type === 'custom'
        ? this.claudeModelConfig(routeCandidates)
        : undefined
    return Object.freeze({
      modelRoute,
      backendProviderId,
      ...(sessionEffort ? { sessionEffort } : {}),
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      providerModelCatalog: Object.freeze(providerModelCatalog),
      transport,
      ...(claudeModelConfig ? { claudeModelConfig } : {}),
      ...(modelRoute === 'codex-bridge'
        ? {
            codexBridgeTools: Object.freeze([
              ...NOTEBOOK_TOOLS,
              ...ARTIFACT_TOOLS,
              ...(input.conversationSkillImportEnabled ? SKILL_IMPORT_TOOLS : [])
            ]),
            reviewerBridgeTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS
          }
        : modelRoute === 'codex-responses-compatibility'
          ? { reviewerBridgeTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS }
          : {})
    })
  }
  projectModelChange(input: BackendModelChangePlanInput): AgentModelChangeTarget | undefined {
    const model = input.target.effectiveModel ?? input.target.provider.model
    if (!model) return undefined
    const route = modelRouteFor(input.frameworkId, input.target)
    const candidates = this.routeCandidates(input.settings, input.target, input.frameworkId, route)
    const retargetable = new Set(candidates.map(({ providerId }) => providerId)).size >= 2
    const customTarget = usesAppProviderTransport(input.target.provider.type)
    const hasClaudeTransport =
      input.frameworkId === 'claude-code' && customTarget && candidates.includes(input.target)
    const hasProviderTransport =
      input.frameworkId === 'opencode' ||
      (input.frameworkId === 'codex' &&
        (retargetable || (route === 'codex-responses' && customTarget)))
    const providerTransportTargetId = hasProviderTransport
      ? transportTargetId(input.frameworkId, input.target.providerId, model)
      : undefined
    const backendProviderId =
      input.frameworkId === 'codex' && isCodexSubscriptionProvider(input.target.provider.type)
        ? CODEX_ISOLATED_PROVIDER_ID
        : input.target.providerId
    return Object.freeze({
      frameworkId: input.frameworkId,
      providerId: input.target.providerId,
      backendId: `${input.frameworkId}:${backendProviderId}`,
      route,
      model,
      sessionModel:
        route === 'codex-bridge'
          ? CODEX_BRIDGE_MODEL
          : input.frameworkId === 'opencode'
            ? `${opencodeTransportProviderId(input.target.providerId, model)}/${model}`
            : model,
      sessionModelRequired:
        input.frameworkId === 'codex' && isCodexSubscriptionProvider(input.target.provider.type),
      supportsImageInput: input.target.provider.supportsImageInput === true,
      reasoningEffort: modelEffort(input.effortIntent, input.target),
      ...(hasClaudeTransport
        ? { anthropicBridgeTargetId: claudeTargetId(input.target.providerId, model) }
        : {}),
      ...(providerTransportTargetId ? { providerTransportTargetId } : {}),
      ...(input.target.provider.contextWindow
        ? { contextWindow: input.target.provider.contextWindow }
        : {}),
      ...(route === 'codex-bridge' || route === 'codex-responses-compatibility'
        ? {
            bridge: Object.freeze({
              model,
              ...(input.target.provider.vendorId
                ? { vendorId: input.target.provider.vendorId }
                : {}),
              ...(input.target.provider.reasoningEffortTransport
                ? { reasoningEffortTransport: input.target.provider.reasoningEffortTransport }
                : {})
            })
          }
        : {})
    })
  }
  private transportPlan(
    active: ProviderRuntimeTarget,
    frameworkId: AgentFrameworkId,
    route: AgentModelRoute,
    candidates: readonly ProviderRuntimeTarget[],
    retargetable: boolean,
    effortIntent: ReasoningEffort
  ): BackendTransportPlan {
    if (frameworkId === 'claude-code') {
      if (!usesAppProviderTransport(active.provider.type)) {
        return Object.freeze({ kind: 'direct' })
      }
      const targets = candidates.flatMap((candidate): AnthropicProviderBridgeTarget[] => {
        const model = candidate.effectiveModel ?? candidate.provider.model
        const baseUrl = normalizeAnthropicBaseUrl(candidate.provider.baseUrl ?? '')
        return !model || !baseUrl
          ? []
          : [
              Object.freeze({
                id: claudeTargetId(candidate.providerId, model),
                baseUrl,
                ...(candidate.provider.key ? { key: candidate.provider.key } : {}),
                model,
                ...(candidate.provider.vendorId === 'apodex'
                  ? { backgroundModel: 'apodex-1.1-mini' }
                  : {}),
                ...(candidate.provider.vendorId &&
                usesVendorAnthropicApiKeyHeader(candidate.provider.vendorId)
                  ? { useApiKeyHeader: true }
                  : {})
              })
            ]
      })
      const model = active.effectiveModel ?? active.provider.model
      if (!model) return Object.freeze({ kind: 'direct' })
      const initialTargetId = claudeTargetId(active.providerId, model)
      return targets.some(({ id }) => id === initialTargetId)
        ? Object.freeze({
            kind: 'claude-anthropic',
            targets: Object.freeze(targets),
            initialTargetId
          })
        : Object.freeze({ kind: 'direct' })
    }
    if (frameworkId === 'opencode') {
      return Object.freeze({
        kind: route as 'opencode-anthropic' | 'opencode-openai',
        targets: this.plannedTargets(candidates, frameworkId, effortIntent)
      })
    }
    if (frameworkId === 'codebuddy') {
      if (active.apiEndpoints.includes('openai')) return Object.freeze({ kind: 'direct' })
      return Object.freeze({
        kind: 'codebuddy-provider-compatibility',
        wire: active.apiEndpoints.includes('responses') ? 'responses' : 'anthropic'
      })
    }
    if (route === 'codex-bridge' || route === 'codex-responses-compatibility') {
      return Object.freeze({
        kind: route === 'codex-bridge' ? 'codex-chat' : 'codex-responses-compatibility',
        targets: retargetable
          ? this.plannedTargets(candidates, frameworkId, effortIntent)
          : Object.freeze([])
      })
    }
    const model = active.effectiveModel ?? active.provider.model
    return active.provider.type === 'custom' && model
      ? Object.freeze({
          kind: 'codex-native-responses',
          targets: this.plannedTargets(candidates, frameworkId, effortIntent),
          initialTargetId: transportTargetId(frameworkId, active.providerId, model)
        })
      : Object.freeze({ kind: 'direct' })
  }
  private plannedTargets(
    candidates: readonly ProviderRuntimeTarget[],
    frameworkId: AgentFrameworkId,
    effortIntent: ReasoningEffort
  ): readonly PlannedProviderTarget[] {
    return Object.freeze(
      candidates.flatMap((target): PlannedProviderTarget[] => {
        const model = target.effectiveModel ?? target.provider.model
        const effort = modelEffort(effortIntent, target)
        return model
          ? [
              Object.freeze({
                id: transportTargetId(frameworkId, target.providerId, model),
                target,
                ...(effort === 'default' ? {} : { reasoningEffort: effort }),
                ...(target.reasoningEffortProfile.supported
                  ? { reasoningEfforts: [...new Set(target.reasoningEffortProfile.slots)] }
                  : {})
              })
            ]
          : []
      })
    )
  }

  private routeCandidates(
    settings: StoredSettings,
    active: ProviderRuntimeTarget,
    frameworkId: AgentFrameworkId,
    route: AgentModelRoute
  ): ProviderRuntimeTarget[] {
    const seen = new Set<string>()
    return this.enumerateCandidates(settings, active, frameworkId).filter((candidate) => {
      const model = candidate.effectiveModel ?? candidate.provider.model
      if (!shareProviderTransportFamily(active.provider.type, candidate.provider.type)) return false
      const endpoint =
        frameworkId === 'claude-code'
          ? normalizeAnthropicBaseUrl(candidate.provider.baseUrl ?? '')
          : frameworkId === 'opencode'
            ? route === 'opencode-openai'
              ? openAiChatCompletionsUrl(candidate.provider)
              : normalizeAnthropicBaseUrl(candidate.provider.baseUrl ?? '')
            : frameworkId === 'codebuddy'
              ? openAiChatCompletionsUrl(candidate.provider)
              : route === 'codex-bridge'
                ? openAiCompletionsBase(candidate.provider)
                : normalizeResponsesBaseUrl(
                    candidate.provider.openaiBaseUrl ?? candidate.provider.baseUrl
                  )
      const id = model
        ? frameworkId === 'claude-code'
          ? claudeTargetId(candidate.providerId, model)
          : transportTargetId(frameworkId, candidate.providerId, model)
        : undefined
      if (
        !candidate.frameworkCompatible ||
        (frameworkId === 'claude-code' && !canUseClaudeProviderTransport(candidate.provider)) ||
        (frameworkId === 'codex' && !candidate.modelBridgeSupported) ||
        modelRouteFor(frameworkId, candidate) !== route ||
        !model ||
        !endpoint ||
        !id ||
        seen.has(id)
      )
        return false
      seen.add(id)
      return true
    })
  }

  private enumerateCandidates(
    settings: StoredSettings,
    active: ProviderRuntimeTarget,
    frameworkId: AgentFrameworkId
  ): ProviderRuntimeTarget[] {
    const framework = getAgentFramework(frameworkId)
    const candidates = [active]
    for (const provider of settings.providers) {
      let configured: ProviderRuntimeTarget
      try {
        configured =
          provider.id === active.providerId
            ? active
            : this.providers.resolveRuntimeTarget(
                provider,
                { kind: 'configured', requestedModel: provider.model },
                framework
              )
      } catch {
        // Stale sibling providers stay reconnect-only and cannot block the active generation.
        continue
      }
      candidates.push(configured)
      try {
        candidates.push(...this.providers.resolveRuntimeModelCatalog(provider, framework))
      } catch {
        // A stale model catalog cannot discard the provider's configured target.
      }
    }
    return candidates
  }

  private modelCatalog(
    candidates: readonly ProviderRuntimeTarget[],
    frameworkId: AgentFrameworkId,
    route: AgentModelRoute,
    effortIntent: ReasoningEffort
  ): AgentModelCatalogEntry[] {
    return candidates
      .filter(
        (candidate) =>
          candidate.frameworkCompatible &&
          (frameworkId !== 'codex' || candidate.modelBridgeSupported) &&
          modelRouteFor(frameworkId, candidate) === route
      )
      .map((candidate) => {
        const effort = modelEffort(effortIntent, candidate)
        return Object.freeze({
          provider: candidate.provider,
          ...(effort === 'default' ? {} : { reasoningEffort: effort }),
          ...(candidate.reasoningEffortProfile.supported
            ? { reasoningEfforts: [...new Set(candidate.reasoningEffortProfile.slots)] }
            : {})
        })
      })
  }

  private claudeModelConfig(
    candidates: readonly ProviderRuntimeTarget[]
  ): ClaudeRuntimeModelConfig | undefined {
    const models = [
      ...new Set(
        candidates.map((candidate) => candidate.effectiveModel ?? candidate.provider.model)
      )
    ].filter((model): model is string => Boolean(model))
    return models.length === 0
      ? undefined
      : Object.freeze({
          availableModels: Object.freeze(models),
          modelOverrides: Object.freeze(Object.fromEntries(models.map((model) => [model, model])))
        })
  }
}

export { BackendRoutePlanner }
export type { BackendRoutePlan, BackendRouteProviderPort, BackendTransportPlan }
