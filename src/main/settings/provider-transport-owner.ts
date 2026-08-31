import { randomUUID } from 'node:crypto'

import type { ModelReasoningEffort } from '../../shared/reasoning-effort'
import { usesVendorAnthropicApiKeyHeader } from '../../shared/provider-registry'
import { netFetchStandard } from '../skills/net-fetch'
import {
  CLAUDE_ACP_CONFIGURABLE_PROVIDER_ID,
  type AgentModelCatalogEntry,
  type AgentProviderConfiguration,
  type ResolvedAgentBackend
} from '../agent-framework'
import { normalizeResponsesBaseUrl } from '../agent-framework/codex'
import { opencodeTransportProviderId } from '../agent-framework/opencode'
import {
  normalizeAnthropicBaseUrl,
  openAiChatCompletionsUrl,
  openAiCompletionsBase
} from './base-url'
import {
  AnthropicProviderBridge,
  type AnthropicProviderBridgeTarget
} from './anthropic-provider-bridge'
import { OpenAiProviderBridge, type OpenAiProviderBridgeTarget } from './openai-provider-bridge'
import {
  ChatProviderCompatibilityBridge,
  type ChatProviderCompatibilityTarget
} from './chat-provider-compatibility'
import type { ProviderRuntimeTarget } from './provider-accounts'
import type { BackendRoutePlan } from './backend-route-planner'
import {
  ResponsesBridge,
  type ResponsesBridgeOptions,
  type ResponsesBridgeConnection,
  type ResponsesBridgeNamespacedTool,
  type ResponsesBridgeTarget
} from './responses-bridge'
import {
  NativeResponsesCompatibilityProxy,
  type NativeResponsesCompatibilityTarget
} from './native-responses-compatibility'
import { loopbackProxyBypassEnvironment } from './system-proxy'
import { xaiNativeResponsesTargetFields } from './xai-protocol'
import { claudeCodeLoopbackEnv, createXaiOAuthProviderBridge } from './xai-oauth-provider-bridge'
import {
  createCodeBuddySkillSelectorTransport,
  type ProviderResponsesBridgePort
} from './codebuddy-skill-selector-transport'
import { adaptCodeBuddyChatCompletionsRequest } from './codebuddy-chat-request-adapter'
type AnthropicProviderBridgePort = Pick<
  AnthropicProviderBridge,
  'start' | 'close' | 'setTarget' | 'clearErrorReplay'
>
type OpenAiProviderBridgePort = Pick<
  OpenAiProviderBridge,
  'start' | 'close' | 'setTarget' | 'clearErrorReplay'
>
type ChatProviderCompatibilityBridgePort = Pick<ChatProviderCompatibilityBridge, 'start' | 'close'>
type CreateXaiOAuthProviderBridge = typeof createXaiOAuthProviderBridge

const codeBuddyCompatibilityEndpoint = (
  provider: ProviderRuntimeTarget['provider'],
  wire: ChatProviderCompatibilityTarget['wire']
): string => {
  if (wire === 'responses') {
    const baseUrl = normalizeResponsesBaseUrl(provider.openaiBaseUrl ?? provider.baseUrl)
    if (!baseUrl) throw new Error('The CodeBuddy Responses provider target is incomplete.')
    return `${baseUrl}/responses`
  }
  const baseUrl = normalizeAnthropicBaseUrl(provider.baseUrl ?? '')
  if (!baseUrl) throw new Error('The CodeBuddy Messages provider target is incomplete.')
  return `${baseUrl}/v1/messages`
}

type ResponsesBridgeEntry = {
  bridge: ProviderResponsesBridgePort
  connection: Promise<ResponsesBridgeConnection>
}

type NativeResponsesProxyPort = Pick<
  NativeResponsesCompatibilityProxy,
  | 'start'
  | 'close'
  | 'selectSkills'
  | 'registerReviewerSession'
  | 'unregisterReviewerSession'
  | 'registerToolLessSession'
  | 'unregisterToolLessSession'
  | 'registerHostMessageSession'
  | 'unregisterHostMessageSession'
  | 'setModelTarget'
  | 'setTarget'
>

type NativeResponsesProxyTarget = NativeResponsesCompatibilityTarget & {
  reviewerScope: { namespacedTools: ResponsesBridgeNamespacedTool[] }
}

type NativeResponsesCompatibilityEntry = {
  proxy: NativeResponsesProxyPort
  connection: Promise<ResponsesBridgeConnection>
}

type LeasedResponsesBridgeConnection = ResponsesBridgeConnection & {
  lease: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>
  providerTransportLease?: NonNullable<ResolvedAgentBackend['providerTransportLease']>
}

type ProviderTransportRequest = Readonly<{
  activeTarget: ProviderRuntimeTarget
  plan: BackendRoutePlan
}>

type ProviderTransportGeneration = Readonly<{
  provider?: ProviderRuntimeTarget['provider']
  providerModelCatalog?: readonly AgentModelCatalogEntry[]
  responsesBridge?: LeasedResponsesBridgeConnection
  environment?: Record<string, string>
  providerConfiguration?: AgentProviderConfiguration
  anthropicBridgeLease?: NonNullable<ResolvedAgentBackend['anthropicBridgeLease']>
  providerTransportLease?: NonNullable<ResolvedAgentBackend['providerTransportLease']>
  release: () => Promise<void>
}>

type ProviderTransportOwnerOptions = {
  getXaiOAuthAccessToken?: (forceRefresh?: boolean) => Promise<string>
  createResponsesBridge?: (
    target: ResponsesBridgeTarget,
    options?: ResponsesBridgeOptions
  ) => ProviderResponsesBridgePort
  createNativeResponsesProxy?: (target: NativeResponsesProxyTarget) => NativeResponsesProxyPort
  createAnthropicProviderBridge?: (
    targets: readonly AnthropicProviderBridgeTarget[],
    initialTargetId: string
  ) => AnthropicProviderBridgePort
  createOpenAiProviderBridge?: (
    targets: readonly OpenAiProviderBridgeTarget[],
    initialTargetId: string
  ) => OpenAiProviderBridgePort
  createChatProviderCompatibilityBridge?: (
    target: ChatProviderCompatibilityTarget
  ) => ChatProviderCompatibilityBridgePort
  createXaiOAuthProviderBridge?: CreateXaiOAuthProviderBridge
  nextGenerationId?: () => string
}

class ProviderTransportOwner {
  private readonly createResponsesBridge: (
    target: ResponsesBridgeTarget,
    options?: ResponsesBridgeOptions
  ) => ProviderResponsesBridgePort
  private readonly createNativeResponsesProxy: (
    target: NativeResponsesProxyTarget
  ) => NativeResponsesProxyPort
  private readonly createAnthropicProviderBridge: (
    targets: readonly AnthropicProviderBridgeTarget[],
    initialTargetId: string
  ) => AnthropicProviderBridgePort
  private readonly createOpenAiProviderBridge: (
    targets: readonly OpenAiProviderBridgeTarget[],
    initialTargetId: string
  ) => OpenAiProviderBridgePort
  private readonly createChatProviderCompatibilityBridge: (
    target: ChatProviderCompatibilityTarget
  ) => ChatProviderCompatibilityBridgePort
  private readonly createXaiOAuthProviderBridge: CreateXaiOAuthProviderBridge
  private readonly nextGenerationId: () => string
  private readonly getXaiOAuthAccessToken?: (forceRefresh?: boolean) => Promise<string>
  private readonly responsesBridges = new Map<string, ResponsesBridgeEntry>()
  private readonly nativeResponsesCompatibilityProxies = new Map<
    string,
    NativeResponsesCompatibilityEntry
  >()

  constructor(options: ProviderTransportOwnerOptions = {}) {
    this.createResponsesBridge =
      options.createResponsesBridge ??
      ((target, bridgeOptions) => new ResponsesBridge(target, netFetchStandard, bridgeOptions))
    this.createNativeResponsesProxy =
      options.createNativeResponsesProxy ??
      ((target) => new NativeResponsesCompatibilityProxy(target, netFetchStandard))
    this.createAnthropicProviderBridge =
      options.createAnthropicProviderBridge ??
      ((targets, initialTargetId) =>
        new AnthropicProviderBridge(targets, initialTargetId, netFetchStandard))
    this.createOpenAiProviderBridge =
      options.createOpenAiProviderBridge ??
      ((targets, initialTargetId) =>
        new OpenAiProviderBridge(targets, initialTargetId, netFetchStandard))
    this.createChatProviderCompatibilityBridge =
      options.createChatProviderCompatibilityBridge ??
      ((target) => new ChatProviderCompatibilityBridge(target, netFetchStandard))
    this.createXaiOAuthProviderBridge =
      options.createXaiOAuthProviderBridge ?? createXaiOAuthProviderBridge
    this.nextGenerationId = options.nextGenerationId ?? randomUUID
    this.getXaiOAuthAccessToken = options.getXaiOAuthAccessToken
  }

  async acquire(input: ProviderTransportRequest): Promise<ProviderTransportGeneration> {
    if (input.plan.modelRoute === 'codebuddy-openai') {
      return this.startCodeBuddyTransport(input)
    }
    if (input.plan.transport.kind === 'claude-anthropic') {
      return this.startClaudeTransport(input)
    }
    if (
      input.plan.transport.kind === 'opencode-openai' ||
      input.plan.transport.kind === 'opencode-anthropic'
    ) {
      return this.startOpenCodeTransport(input)
    }
    if (input.plan.transport.kind === 'codex-native-responses') {
      return this.startNativeCodexTransport(input)
    }
    if (input.plan.transport.kind === 'codex-responses-compatibility') {
      const responsesBridge = await this.startNativeResponsesCompatibility(input)
      return Object.freeze({
        responsesBridge,
        environment: loopbackProxyBypassEnvironment(process.env),
        ...(responsesBridge.providerTransportLease
          ? { providerTransportLease: responsesBridge.providerTransportLease }
          : {}),
        release: responsesBridge.lease.release
      })
    }
    if (input.plan.transport.kind !== 'codex-chat')
      return Object.freeze({ release: async () => undefined })
    const responsesBridge = await this.startResponsesBridge(input)
    return Object.freeze({
      responsesBridge,
      environment: loopbackProxyBypassEnvironment(process.env),
      ...(responsesBridge.providerTransportLease
        ? { providerTransportLease: responsesBridge.providerTransportLease }
        : {}),
      release: responsesBridge.lease.release
    })
  }

  private async startCodeBuddyTransport(
    input: ProviderTransportRequest
  ): Promise<ProviderTransportGeneration> {
    const provider = input.activeTarget.provider
    const model = input.activeTarget.effectiveModel ?? provider.model
    if (!model) throw new Error('The CodeBuddy provider target is incomplete.')
    const targetId = JSON.stringify(['codebuddy', input.activeTarget.providerId, model])
    const transport = input.plan.transport
    const usesXaiOAuth = provider.type === 'xai-subscription'
    const bridge: ChatProviderCompatibilityBridgePort =
      transport.kind === 'codebuddy-provider-compatibility'
        ? this.createChatProviderCompatibilityBridge({
            wire: transport.wire,
            endpoint: codeBuddyCompatibilityEndpoint(provider, transport.wire),
            ...(provider.key ? { key: provider.key } : {}),
            model,
            adaptRequest: adaptCodeBuddyChatCompletionsRequest
          })
        : usesXaiOAuth
          ? this.createXaiOAuthProviderBridge(
              [{ id: targetId, model }],
              targetId,
              'openai',
              this.getXaiOAuthAccessToken,
              { adaptOpenAiRequest: adaptCodeBuddyChatCompletionsRequest }
            )
          : (() => {
              const endpoint = openAiChatCompletionsUrl(provider)
              if (!endpoint) throw new Error('The CodeBuddy provider target is incomplete.')
              return this.createOpenAiProviderBridge(
                [
                  {
                    id: targetId,
                    wire: 'chat-completions',
                    endpoint,
                    ...(provider.key ? { key: provider.key } : {}),
                    model,
                    adaptRequest: adaptCodeBuddyChatCompletionsRequest
                  }
                ],
                targetId
              )
            })()
    let selector: ReturnType<typeof createCodeBuddySkillSelectorTransport> | undefined =
      transport.kind === 'codebuddy-provider-compatibility' || usesXaiOAuth
        ? undefined
        : createCodeBuddySkillSelectorTransport({
            activeTarget: input.activeTarget,
            ...(input.plan.sessionEffort ? { reasoningEffort: input.plan.sessionEffort } : {}),
            createSelector: this.createResponsesBridge
          })
    try {
      const connection = await bridge.start()
      const routedProvider = Object.freeze({
        ...provider,
        baseUrl: connection.baseUrl,
        openaiBaseUrl: `${connection.baseUrl}/v1`,
        model,
        key: connection.token,
        apiEndpoints: ['openai'] as const
      })
      selector ??= createCodeBuddySkillSelectorTransport({
        activeTarget: { ...input.activeTarget, provider: routedProvider, apiEndpoints: ['openai'] },
        ...(input.plan.sessionEffort ? { reasoningEffort: input.plan.sessionEffort } : {}),
        createSelector: this.createResponsesBridge
      })
      let released = false
      const release = async (): Promise<void> => {
        if (released) return
        released = true
        await Promise.all([bridge.close(), selector?.release()])
      }
      const selectSkills = selector.providerTransportLease?.selectSkills
      return Object.freeze({
        provider: routedProvider,
        environment: loopbackProxyBypassEnvironment(process.env),
        providerTransportLease: {
          setTarget: () => false,
          ...(selectSkills ? { selectSkills } : {}),
          release
        },
        release
      })
    } catch (error) {
      await Promise.all([
        bridge.close().catch(() => undefined),
        selector?.release().catch(() => undefined)
      ])
      throw error
    }
  }

  private async startNativeCodexTransport(
    input: ProviderTransportRequest
  ): Promise<ProviderTransportGeneration> {
    const transport = input.plan.transport
    if (transport.kind !== 'codex-native-responses') {
      throw new Error('Native Codex provider transport is unavailable.')
    }
    const targets = transport.targets.map((planned): OpenAiProviderBridgeTarget => {
      const candidate = planned.target
      const model = candidate.effectiveModel ?? candidate.provider.model
      const baseUrl = normalizeResponsesBaseUrl(
        candidate.provider.openaiBaseUrl ?? candidate.provider.baseUrl
      )
      if (!model || !baseUrl) throw new Error('The native Responses provider target is incomplete.')
      return Object.freeze({
        id: planned.id,
        wire: 'responses',
        endpoint: `${baseUrl}/responses`,
        ...(candidate.provider.key ? { key: candidate.provider.key } : {}),
        model
      })
    })
    const activeModel = input.activeTarget.effectiveModel ?? input.activeTarget.provider.model
    if (!activeModel) throw new Error('The active native Responses model is unavailable.')
    const initialTargetId = transport.initialTargetId
    if (!initialTargetId) throw new Error('The active native Responses model is unavailable.')
    const bridge = this.createOpenAiProviderBridge(targets, initialTargetId)
    try {
      const connection = await bridge.start()
      let released = false
      const release = async (): Promise<void> => {
        if (released) return
        released = true
        await bridge.close()
      }
      return Object.freeze({
        provider: Object.freeze({
          ...input.activeTarget.provider,
          baseUrl: connection.baseUrl,
          openaiBaseUrl: `${connection.baseUrl}/v1`,
          model: activeModel,
          key: connection.token,
          apiEndpoints: ['responses'] as const
        }),
        environment: loopbackProxyBypassEnvironment(process.env),
        providerTransportLease: {
          setTarget: (targetId: string) => bridge.setTarget(targetId),
          release
        },
        release
      })
    } catch (error) {
      await bridge.close().catch(() => undefined)
      throw error
    }
  }

  private async startOpenCodeTransport(
    input: ProviderTransportRequest
  ): Promise<ProviderTransportGeneration> {
    const transport = input.plan.transport
    if (transport.kind !== 'opencode-openai' && transport.kind !== 'opencode-anthropic') {
      throw new Error('OpenCode provider transport is unavailable.')
    }
    const bridges: Array<AnthropicProviderBridgePort | OpenAiProviderBridgePort> = []
    const targetIds = new Set<string>()
    const catalog: AgentModelCatalogEntry[] = []
    let activeProvider: ProviderRuntimeTarget['provider'] | undefined
    let activeTargetId: string | undefined
    try {
      for (const planned of transport.targets) {
        const candidate = planned.target
        const model = candidate.effectiveModel ?? candidate.provider.model
        if (!model) continue
        const targetId = planned.id
        const bridge =
          candidate.provider.type === 'xai-subscription'
            ? this.createXaiOAuthProviderBridge(
                [{ id: targetId, model }],
                targetId,
                'openai',
                this.getXaiOAuthAccessToken
              )
            : transport.kind === 'opencode-openai'
              ? this.createOpenAiProviderBridge(
                  [
                    {
                      id: targetId,
                      wire: 'chat-completions',
                      endpoint: openAiChatCompletionsUrl(candidate.provider)!,
                      ...(candidate.provider.key ? { key: candidate.provider.key } : {}),
                      model
                    }
                  ],
                  targetId
                )
              : this.createAnthropicProviderBridge(
                  [
                    {
                      id: targetId,
                      baseUrl: normalizeAnthropicBaseUrl(candidate.provider.baseUrl ?? ''),
                      ...(candidate.provider.key ? { key: candidate.provider.key } : {}),
                      model,
                      ...(candidate.provider.vendorId &&
                      usesVendorAnthropicApiKeyHeader(candidate.provider.vendorId)
                        ? { useApiKeyHeader: true }
                        : {})
                    }
                  ],
                  targetId
                )
        bridges.push(bridge)
        const connection = await bridge.start()
        const apiEndpoints = [
          transport.kind === 'opencode-openai' ? ('openai' as const) : ('anthropic' as const)
        ]
        const localProvider = Object.freeze({
          ...candidate.provider,
          agentProviderId: opencodeTransportProviderId(candidate.providerId, model),
          baseUrl: connection.baseUrl,
          ...(transport.kind === 'opencode-openai'
            ? { openaiBaseUrl: `${connection.baseUrl}/v1` }
            : { openaiBaseUrl: undefined }),
          model,
          key: connection.token,
          apiEndpoints
        })
        catalog.push(
          Object.freeze({
            provider: localProvider,
            ...(planned.reasoningEffort ? { reasoningEffort: planned.reasoningEffort } : {}),
            ...(planned.reasoningEfforts ? { reasoningEfforts: planned.reasoningEfforts } : {})
          })
        )
        targetIds.add(targetId)
        if (
          candidate.providerId === input.activeTarget.providerId &&
          model === (input.activeTarget.effectiveModel ?? input.activeTarget.provider.model)
        ) {
          activeProvider = localProvider
          activeTargetId = targetId
        }
      }
      if (!activeProvider)
        throw new Error('The active OpenCode transport target was not registered.')
      let released = false
      const release = async (): Promise<void> => {
        if (released) return
        released = true
        await Promise.all(bridges.map((bridge) => bridge.close()))
      }
      return Object.freeze({
        provider: activeProvider,
        providerModelCatalog: Object.freeze(catalog),
        environment: loopbackProxyBypassEnvironment(process.env),
        providerTransportLease: {
          setTarget: (targetId: string) => {
            if (!targetIds.has(targetId)) return false
            if (activeTargetId !== targetId) {
              activeTargetId = targetId
              for (const bridge of bridges) bridge.clearErrorReplay()
            }
            return true
          },
          release
        },
        release
      })
    } catch (error) {
      await Promise.all(bridges.map((bridge) => bridge.close().catch(() => undefined)))
      throw error
    }
  }

  private async startClaudeTransport(
    input: ProviderTransportRequest
  ): Promise<ProviderTransportGeneration> {
    const transport = input.plan.transport
    if (transport.kind !== 'claude-anthropic') {
      throw new Error('Claude Anthropic transport is unavailable.')
    }
    const bridge =
      input.activeTarget.provider.type === 'xai-subscription'
        ? this.createXaiOAuthProviderBridge(
            transport.targets.map(({ id, model }) => ({ id, model })),
            transport.initialTargetId,
            'anthropic',
            this.getXaiOAuthAccessToken
          )
        : this.createAnthropicProviderBridge(transport.targets, transport.initialTargetId)
    try {
      const connection = await bridge.start()
      let released = false
      const release = async (): Promise<void> => {
        if (released) return
        released = true
        await bridge.close()
      }
      return Object.freeze({
        environment: {
          ...claudeCodeLoopbackEnv(
            connection,
            input.activeTarget.provider.type === 'xai-subscription'
          ),
          ...loopbackProxyBypassEnvironment(process.env)
        },
        providerConfiguration: {
          providerId: CLAUDE_ACP_CONFIGURABLE_PROVIDER_ID,
          apiType: 'anthropic',
          baseUrl: connection.baseUrl,
          headers: { 'x-api-key': connection.token }
        },
        anthropicBridgeLease: {
          setTarget: (targetId: string) => bridge.setTarget(targetId),
          release
        },
        release
      })
    } catch (error) {
      await bridge.close().catch(() => undefined)
      throw error
    }
  }

  private async startNativeResponsesCompatibility(
    input: ProviderTransportRequest
  ): Promise<LeasedResponsesBridgeConnection> {
    const transport = input.plan.transport
    if (transport.kind !== 'codex-responses-compatibility') {
      throw new Error('Native Responses compatibility transport is unavailable.')
    }
    const createTarget = (candidate: ProviderRuntimeTarget): NativeResponsesProxyTarget => {
      const targetBaseUrl = normalizeResponsesBaseUrl(
        candidate.provider.openaiBaseUrl ?? candidate.provider.baseUrl
      )
      if (!targetBaseUrl) throw new Error('The native Responses provider has no base URL.')
      return {
        baseUrl: targetBaseUrl,
        key: candidate.provider.key,
        ...xaiNativeResponsesTargetFields(candidate.provider.type, this.getXaiOAuthAccessToken),
        model: candidate.effectiveModel ?? candidate.provider.model,
        reviewerScope: { namespacedTools: [...(input.plan.reviewerBridgeTools ?? [])] }
      }
    }
    const targets = new Map<string, NativeResponsesProxyTarget>()
    for (const planned of transport.targets) {
      const candidate = planned.target
      if (!(candidate.effectiveModel ?? candidate.provider.model)) continue
      targets.set(planned.id, createTarget(candidate))
    }
    const activeModel = input.activeTarget.effectiveModel ?? input.activeTarget.provider.model
    const initialTargetId = activeModel
      ? transport.targets.find(
          ({ target }) =>
            target.providerId === input.activeTarget.providerId &&
            (target.effectiveModel ?? target.provider.model) === activeModel
        )?.id
      : undefined
    const generationId = this.nextGenerationId()
    const proxy = this.createNativeResponsesProxy(
      (initialTargetId ? targets.get(initialTargetId) : undefined) ??
        createTarget(input.activeTarget)
    )
    const entry = { proxy, connection: proxy.start() }
    this.nativeResponsesCompatibilityProxies.set(generationId, entry)

    let connection: ResponsesBridgeConnection
    try {
      connection = await entry.connection
    } catch (error) {
      if (this.nativeResponsesCompatibilityProxies.get(generationId) === entry) {
        this.nativeResponsesCompatibilityProxies.delete(generationId)
      }
      await entry.proxy.close().catch(() => undefined)
      throw error
    }

    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      if (this.nativeResponsesCompatibilityProxies.get(generationId) !== entry) return
      this.nativeResponsesCompatibilityProxies.delete(generationId)
      await entry.proxy.close()
    }
    return Object.freeze({
      ...connection,
      lease: {
        selectSkills: (text, catalog, signal, observeUsage) =>
          entry.proxy.selectSkills(text, catalog, signal, observeUsage),
        registerReviewerSession: (key) => entry.proxy.registerReviewerSession(key),
        unregisterReviewerSession: (key) => entry.proxy.unregisterReviewerSession(key),
        registerToolLessSession: (key) => entry.proxy.registerToolLessSession(key),
        unregisterToolLessSession: (key) => entry.proxy.unregisterToolLessSession(key),
        registerHostMessageSession: (key, tools, options) =>
          entry.proxy.registerHostMessageSession(key, tools, options),
        unregisterHostMessageSession: (key) => entry.proxy.unregisterHostMessageSession(key),
        setModelTarget: (target) => entry.proxy.setModelTarget(target),
        release
      },
      ...(targets.size > 0
        ? {
            providerTransportLease: {
              setTarget: (targetId: string) => {
                const providerTarget = targets.get(targetId)
                if (!providerTarget) return false
                entry.proxy.setTarget(providerTarget)
                return true
              },
              release
            }
          }
        : {})
    })
  }

  private async startResponsesBridge(
    input: ProviderTransportRequest
  ): Promise<LeasedResponsesBridgeConnection> {
    const transport = input.plan.transport
    if (transport.kind !== 'codex-chat') throw new Error('Codex Chat transport is unavailable.')
    const createTarget = (
      candidate: ProviderRuntimeTarget,
      effort: ModelReasoningEffort | undefined
    ): ResponsesBridgeTarget => {
      const targetBaseUrl = openAiCompletionsBase(candidate.provider)
      if (!targetBaseUrl) throw new Error('The Chat Completions provider has no base URL.')
      return {
        baseUrl: targetBaseUrl,
        key: candidate.provider.key,
        vendorId: candidate.provider.vendorId,
        reasoningEffortTransport: candidate.provider.reasoningEffortTransport,
        model: candidate.effectiveModel ?? candidate.provider.model,
        reasoningEffort: effort,
        namespacedTools: [...(input.plan.codexBridgeTools ?? [])],
        reviewerScope: { namespacedTools: [...(input.plan.reviewerBridgeTools ?? [])] }
      }
    }
    const targets = new Map<string, ResponsesBridgeTarget>()
    for (const planned of transport.targets) {
      const candidate = planned.target
      const model = candidate.effectiveModel ?? candidate.provider.model
      if (!model) continue
      targets.set(planned.id, createTarget(candidate, planned.reasoningEffort))
    }
    const activeModel = input.activeTarget.effectiveModel ?? input.activeTarget.provider.model
    const initialTargetId = activeModel
      ? transport.targets.find(
          ({ target }) =>
            target.providerId === input.activeTarget.providerId &&
            (target.effectiveModel ?? target.provider.model) === activeModel
        )?.id
      : undefined
    const target =
      (initialTargetId ? targets.get(initialTargetId) : undefined) ??
      createTarget(input.activeTarget, input.plan.sessionEffort)
    const generationId = this.nextGenerationId()
    const bridge = this.createResponsesBridge(target)
    const entry = { bridge, connection: bridge.start() }
    this.responsesBridges.set(generationId, entry)

    let connection: ResponsesBridgeConnection
    try {
      connection = await entry.connection
    } catch (error) {
      if (this.responsesBridges.get(generationId) === entry) {
        this.responsesBridges.delete(generationId)
      }
      await entry.bridge.close().catch(() => undefined)
      throw error
    }

    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      if (this.responsesBridges.get(generationId) !== entry) return
      this.responsesBridges.delete(generationId)
      await entry.bridge.close()
    }
    return Object.freeze({
      ...connection,
      lease: {
        selectSkills: (text, catalog, signal, observeUsage) =>
          entry.bridge.selectSkills(text, catalog, signal, observeUsage),
        registerReviewerSession: (key) => entry.bridge.registerReviewerSession(key),
        unregisterReviewerSession: (key) => entry.bridge.unregisterReviewerSession(key),
        registerToolLessSession: (key) => entry.bridge.registerToolLessSession(key),
        unregisterToolLessSession: (key) => entry.bridge.unregisterToolLessSession(key),
        registerHostMessageSession: (key, tools, options) =>
          entry.bridge.registerHostMessageSession(key, tools, options),
        unregisterHostMessageSession: (key) => entry.bridge.unregisterHostMessageSession(key),
        setReasoningEffort: (effort) => entry.bridge.setReasoningEffort(effort),
        setModelTarget: (target) => entry.bridge.setModelTarget(target),
        release
      },
      ...(targets.size > 0
        ? {
            providerTransportLease: {
              setTarget: (targetId: string) => {
                const providerTarget = targets.get(targetId)
                if (!providerTarget) return false
                entry.bridge.setTarget(providerTarget)
                return true
              },
              release
            }
          }
        : {})
    })
  }
}

export { ProviderTransportOwner }
export type { ProviderTransportOwnerOptions }
