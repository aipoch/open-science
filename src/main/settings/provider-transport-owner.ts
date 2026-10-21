import { randomUUID } from 'node:crypto'
import type {
  ProviderFailureObservation,
  ProviderFailureObserver
} from './provider-failure-observation'

import { usesVendorMessagesApiKeyHeader, type ModelReasoningEffort } from '@aipoch/providers'

import {
  CLAUDE_ACP_CONFIGURABLE_PROVIDER_ID,
  type AgentModelCatalogEntry,
  type AgentProviderConfiguration,
  type ResolvedAgentBackend
} from '../agent-framework'
import { resolveResponsesBaseUrl } from '../agent-framework/codex'
import { opencodeTransportProviderId } from '../agent-framework/opencode'
import { netFetchStandard } from '../network-fetch'
import { MessagesBridge, type MessagesBridgeTarget } from './messages-bridge'
import type { BackendRoutePlan } from './backend-route-planner'
import {
  normalizeMessagesRootUrl,
  resolveChatCompletionsUrl,
  resolveChatCompletionsBaseUrl,
  type ResponsesNamespacedTool
} from '@aipoch/providers/protocol'
import {
  ChatCompletionsCompatibilityBridge,
  type ChatCompletionsCompatibilityTarget
} from './chat-completions-compatibility'
import { adaptCodeBuddyChatCompletionsRequest } from './codebuddy-chat-request-adapter'
import {
  createCodeBuddySkillSelectorTransport,
  type ProviderResponsesToChatCompletionsBridgePort
} from './codebuddy-skill-selector-transport'
import {
  NativeResponsesCompatibilityProxy,
  type NativeResponsesCompatibilityTarget
} from './native-responses-compatibility'
import {
  ProtocolForwardingBridge,
  type ProtocolForwardingBridgeTarget
} from './protocol-forwarding-bridge'
import type { ProviderRuntimeTarget } from './provider-accounts'

import {
  ResponsesToChatCompletionsBridge,
  type ResponsesToChatCompletionsBridgeOptions
} from './responses-to-chat-completions-bridge'
import type {
  ResponsesConnection,
  ResponsesToChatCompletionsBridgeTarget
} from './responses-transport-contract'
import { loopbackProxyBypassEnvironment } from './system-proxy'
import { claudeCodeLoopbackEnv, createXaiOAuthProviderBridge } from './xai-oauth-provider-bridge'
import { sanitizeXaiResponsesRequest } from '@aipoch/providers/protocol'
type MessagesBridgePort = Pick<MessagesBridge, 'start' | 'close' | 'setTarget' | 'clearErrorReplay'>
type ProtocolForwardingBridgePort = Pick<
  ProtocolForwardingBridge,
  'start' | 'close' | 'setTarget' | 'clearErrorReplay'
>
type ChatCompletionsCompatibilityBridgePort = Pick<
  ChatCompletionsCompatibilityBridge,
  'start' | 'close'
>
type CreateXaiOAuthProviderBridge = typeof createXaiOAuthProviderBridge

const codeBuddyCompatibilityEndpoint = (
  provider: ProviderRuntimeTarget['provider'],
  wire: ChatCompletionsCompatibilityTarget['wire']
): string => {
  if (wire === 'responses') {
    const baseUrl = resolveResponsesBaseUrl(provider)
    if (!baseUrl) throw new Error('The CodeBuddy Responses provider target is incomplete.')
    return `${baseUrl}/responses`
  }
  const baseUrl = normalizeMessagesRootUrl(provider.baseUrl ?? '')
  if (!baseUrl) throw new Error('The CodeBuddy Messages provider target is incomplete.')
  return `${baseUrl}/v1/messages`
}

type ResponsesToChatCompletionsBridgeEntry = {
  bridge: ProviderResponsesToChatCompletionsBridgePort
  connection: Promise<ResponsesConnection>
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
  reviewerScope: { namespacedTools: ResponsesNamespacedTool[] }
}

type NativeResponsesCompatibilityEntry = {
  proxy: NativeResponsesProxyPort
  connection: Promise<ResponsesConnection>
}

type LeasedResponsesConnection = ResponsesConnection & {
  lease: NonNullable<ResolvedAgentBackend['responsesTransportLease']>
  providerTransportLease?: NonNullable<ResolvedAgentBackend['providerTransportLease']>
}

type ProviderTransportRequest = Readonly<{
  activeTarget: ProviderRuntimeTarget
  plan: BackendRoutePlan
}>

type ProviderTransportGeneration = Readonly<{
  provider?: ProviderRuntimeTarget['provider']
  providerModelCatalog?: readonly AgentModelCatalogEntry[]
  responsesConnection?: LeasedResponsesConnection
  environment?: Record<string, string>
  providerConfiguration?: AgentProviderConfiguration
  messagesBridgeLease?: NonNullable<ResolvedAgentBackend['messagesBridgeLease']>
  providerTransportLease?: NonNullable<ResolvedAgentBackend['providerTransportLease']>
  release: () => Promise<void>
}>

type ProviderTransportOwnerOptions = {
  onProviderFailure?: (
    target: ProviderRuntimeTarget,
    failure: ProviderFailureObservation
  ) => Promise<void>
  getXaiOAuthAccessToken?: (forceRefresh?: boolean) => Promise<string>
  createResponsesToChatCompletionsBridge?: (
    target: ResponsesToChatCompletionsBridgeTarget,
    options?: ResponsesToChatCompletionsBridgeOptions
  ) => ProviderResponsesToChatCompletionsBridgePort
  createNativeResponsesProxy?: (target: NativeResponsesProxyTarget) => NativeResponsesProxyPort
  createMessagesBridge?: (
    targets: readonly MessagesBridgeTarget[],
    initialTargetId: string
  ) => MessagesBridgePort
  createProtocolForwardingBridge?: (
    targets: readonly ProtocolForwardingBridgeTarget[],
    initialTargetId: string
  ) => ProtocolForwardingBridgePort
  createChatCompletionsCompatibilityBridge?: (
    target: ChatCompletionsCompatibilityTarget
  ) => ChatCompletionsCompatibilityBridgePort
  createXaiOAuthProviderBridge?: CreateXaiOAuthProviderBridge
  nextGenerationId?: () => string
}

class ProviderTransportOwner {
  private readonly onProviderFailure: ProviderTransportOwnerOptions['onProviderFailure']
  private readonly createResponsesToChatCompletionsBridge: (
    target: ResponsesToChatCompletionsBridgeTarget,
    options?: ResponsesToChatCompletionsBridgeOptions
  ) => ProviderResponsesToChatCompletionsBridgePort
  private readonly createNativeResponsesProxy: (
    target: NativeResponsesProxyTarget
  ) => NativeResponsesProxyPort
  private readonly createMessagesBridge: (
    targets: readonly MessagesBridgeTarget[],
    initialTargetId: string
  ) => MessagesBridgePort
  private readonly createProtocolForwardingBridge: (
    targets: readonly ProtocolForwardingBridgeTarget[],
    initialTargetId: string
  ) => ProtocolForwardingBridgePort
  private readonly createChatCompletionsCompatibilityBridge: (
    target: ChatCompletionsCompatibilityTarget
  ) => ChatCompletionsCompatibilityBridgePort
  private readonly createXaiOAuthProviderBridge: CreateXaiOAuthProviderBridge
  private readonly nextGenerationId: () => string
  private readonly getXaiOAuthAccessToken?: (forceRefresh?: boolean) => Promise<string>
  private readonly responsesToChatCompletionsBridges = new Map<
    string,
    ResponsesToChatCompletionsBridgeEntry
  >()
  private readonly nativeResponsesCompatibilityProxies = new Map<
    string,
    NativeResponsesCompatibilityEntry
  >()

  constructor(options: ProviderTransportOwnerOptions = {}) {
    this.onProviderFailure = options.onProviderFailure
    this.createResponsesToChatCompletionsBridge =
      options.createResponsesToChatCompletionsBridge ??
      ((target, bridgeOptions) =>
        new ResponsesToChatCompletionsBridge(target, netFetchStandard, bridgeOptions))
    this.createNativeResponsesProxy =
      options.createNativeResponsesProxy ??
      ((target) => new NativeResponsesCompatibilityProxy(target, netFetchStandard))
    this.createMessagesBridge =
      options.createMessagesBridge ??
      ((targets, initialTargetId) => new MessagesBridge(targets, initialTargetId, netFetchStandard))
    this.createProtocolForwardingBridge =
      options.createProtocolForwardingBridge ??
      ((targets, initialTargetId) =>
        new ProtocolForwardingBridge(targets, initialTargetId, netFetchStandard))
    this.createChatCompletionsCompatibilityBridge =
      options.createChatCompletionsCompatibilityBridge ??
      ((target) => new ChatCompletionsCompatibilityBridge(target, netFetchStandard))
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
      const responsesConnection = await this.startNativeResponsesCompatibility(input)
      return Object.freeze({
        responsesConnection,
        environment: loopbackProxyBypassEnvironment(process.env),
        ...(responsesConnection.providerTransportLease
          ? { providerTransportLease: responsesConnection.providerTransportLease }
          : {}),
        release: responsesConnection.lease.release
      })
    }
    if (input.plan.transport.kind !== 'codex-chat')
      return Object.freeze({ release: async () => undefined })
    const responsesConnection = await this.startResponsesToChatCompletionsBridge(input)
    return Object.freeze({
      responsesConnection,
      environment: loopbackProxyBypassEnvironment(process.env),
      ...(responsesConnection.providerTransportLease
        ? { providerTransportLease: responsesConnection.providerTransportLease }
        : {}),
      release: responsesConnection.lease.release
    })
  }

  private healthObservation(target: ProviderRuntimeTarget): {
    onProviderFailure?: ProviderFailureObserver
  } {
    const observe = this.onProviderFailure
    if (
      !observe ||
      target.configRevision === undefined ||
      !['custom', 'official'].includes(target.providerType)
    )
      return {}
    return { onProviderFailure: (failure) => observe(target, failure) }
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
    const bridge: ChatCompletionsCompatibilityBridgePort =
      transport.kind === 'codebuddy-provider-compatibility'
        ? this.createChatCompletionsCompatibilityBridge({
            ...this.healthObservation(input.activeTarget),
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
              'chat-completions',
              this.getXaiOAuthAccessToken,
              { adaptChatCompletionsRequest: adaptCodeBuddyChatCompletionsRequest }
            )
          : (() => {
              const endpoint = resolveChatCompletionsUrl(provider)
              if (!endpoint) throw new Error('The CodeBuddy provider target is incomplete.')
              return this.createProtocolForwardingBridge(
                [
                  {
                    ...this.healthObservation(input.activeTarget),
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
            createSelector: this.createResponsesToChatCompletionsBridge
          })
    try {
      const connection = await bridge.start()
      const routedProvider = Object.freeze({
        ...provider,
        baseUrl: connection.baseUrl,
        chatCompletionsBaseUrl: `${connection.baseUrl}/v1`,
        model,
        key: connection.token,
        apiEndpoints: ['chat-completions'] as const
      })
      selector ??= createCodeBuddySkillSelectorTransport({
        activeTarget: {
          ...input.activeTarget,
          provider: routedProvider,
          apiEndpoints: ['chat-completions']
        },
        ...(input.plan.sessionEffort ? { reasoningEffort: input.plan.sessionEffort } : {}),
        createSelector: this.createResponsesToChatCompletionsBridge
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
    const targets = transport.targets.map((planned): ProtocolForwardingBridgeTarget => {
      const candidate = planned.target
      const model = candidate.effectiveModel ?? candidate.provider.model
      const baseUrl = resolveResponsesBaseUrl(candidate.provider)
      if (!model || !baseUrl) throw new Error('The native Responses provider target is incomplete.')
      return Object.freeze({
        ...this.healthObservation(candidate),
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
    const bridge = this.createProtocolForwardingBridge(targets, initialTargetId)
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
          chatCompletionsBaseUrl: `${connection.baseUrl}/v1`,
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
    const bridges: Array<MessagesBridgePort | ProtocolForwardingBridgePort> = []
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
                'chat-completions',
                this.getXaiOAuthAccessToken
              )
            : transport.kind === 'opencode-openai'
              ? this.createProtocolForwardingBridge(
                  [
                    {
                      ...this.healthObservation(candidate),
                      id: targetId,
                      wire: 'chat-completions',
                      endpoint: resolveChatCompletionsUrl(candidate.provider)!,
                      ...(candidate.provider.key ? { key: candidate.provider.key } : {}),
                      model
                    }
                  ],
                  targetId
                )
              : this.createMessagesBridge(
                  [
                    {
                      ...this.healthObservation(candidate),
                      id: targetId,
                      baseUrl: normalizeMessagesRootUrl(candidate.provider.baseUrl ?? ''),
                      ...(candidate.provider.key ? { key: candidate.provider.key } : {}),
                      model,
                      ...(candidate.provider.vendorId &&
                      usesVendorMessagesApiKeyHeader(candidate.provider.vendorId)
                        ? { useApiKeyHeader: true }
                        : {})
                    }
                  ],
                  targetId
                )
        bridges.push(bridge)
        const connection = await bridge.start()
        const apiEndpoints = [
          transport.kind === 'opencode-openai'
            ? ('chat-completions' as const)
            : ('messages' as const)
        ]
        const localProvider = Object.freeze({
          ...candidate.provider,
          agentProviderId: opencodeTransportProviderId(candidate.providerId, model),
          baseUrl: connection.baseUrl,
          ...(transport.kind === 'opencode-openai'
            ? { chatCompletionsBaseUrl: `${connection.baseUrl}/v1` }
            : { chatCompletionsBaseUrl: undefined }),
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
            'messages',
            this.getXaiOAuthAccessToken
          )
        : this.createMessagesBridge(
            transport.targets.map(({ runtimeTarget, ...target }) => ({
              ...target,
              ...(runtimeTarget ? this.healthObservation(runtimeTarget) : {})
            })),
            transport.initialTargetId
          )
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
        messagesBridgeLease: {
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
  ): Promise<LeasedResponsesConnection> {
    const transport = input.plan.transport
    if (transport.kind !== 'codex-responses-compatibility') {
      throw new Error('Native Responses compatibility transport is unavailable.')
    }
    const createTarget = (candidate: ProviderRuntimeTarget): NativeResponsesProxyTarget => {
      const targetBaseUrl = resolveResponsesBaseUrl(candidate.provider)
      if (!targetBaseUrl) throw new Error('The native Responses provider has no base URL.')
      return {
        ...this.healthObservation(candidate),
        baseUrl: targetBaseUrl,
        vendorId: candidate.provider.vendorId,
        key: candidate.provider.key,
        ...(candidate.provider.type === 'xai-subscription'
          ? {
              resolveKey: this.getXaiOAuthAccessToken,
              sanitizeRequest: sanitizeXaiResponsesRequest
            }
          : {}),
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

    let connection: ResponsesConnection
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

  private async startResponsesToChatCompletionsBridge(
    input: ProviderTransportRequest
  ): Promise<LeasedResponsesConnection> {
    const transport = input.plan.transport
    if (transport.kind !== 'codex-chat') throw new Error('Codex Chat transport is unavailable.')
    const createTarget = (
      candidate: ProviderRuntimeTarget,
      effort: ModelReasoningEffort | undefined
    ): ResponsesToChatCompletionsBridgeTarget => {
      const targetBaseUrl = resolveChatCompletionsBaseUrl(candidate.provider)
      if (!targetBaseUrl) throw new Error('The Chat Completions provider has no base URL.')
      return {
        ...this.healthObservation(candidate),
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
    const targets = new Map<string, ResponsesToChatCompletionsBridgeTarget>()
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
    const bridge = this.createResponsesToChatCompletionsBridge(target)
    const entry = { bridge, connection: bridge.start() }
    this.responsesToChatCompletionsBridges.set(generationId, entry)

    let connection: ResponsesConnection
    try {
      connection = await entry.connection
    } catch (error) {
      if (this.responsesToChatCompletionsBridges.get(generationId) === entry) {
        this.responsesToChatCompletionsBridges.delete(generationId)
      }
      await entry.bridge.close().catch(() => undefined)
      throw error
    }

    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      if (this.responsesToChatCompletionsBridges.get(generationId) !== entry) return
      this.responsesToChatCompletionsBridges.delete(generationId)
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
        registerMcpSession: (key, tools, namespaces) =>
          entry.bridge.registerMcpSession?.(key, tools, namespaces),
        unregisterMcpSession: (key) => entry.bridge.unregisterMcpSession?.(key) ?? false,
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
