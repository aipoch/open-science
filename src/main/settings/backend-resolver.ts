import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { ReasoningEffort } from '../../shared/settings'
import {
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_REASONING_EFFORT,
  isCodexSubscriptionProvider
} from '../../shared/settings'
import {
  buildActiveModelIncompatibleMessage,
  CODEX_BRIDGE_UNSUPPORTED_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE
} from '../../shared/run-error-classification'
import type { ModelReasoningEffort, ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import {
  getAgentFramework,
  type AgentModelCatalogEntry,
  type AgentModelChangeTarget,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import { opencodeConfigDir, opencodeTransportProviderId } from '../agent-framework/opencode'
import {
  codexStorageDir,
  codexSubscriptionStorageDir,
  normalizeResponsesBaseUrl
} from '../agent-framework/codex'
import { renderConnectorInstructions } from '../connectors/skill-doc'
import {
  normalizeAnthropicBaseUrl,
  openAiChatCompletionsUrl,
  openAiCompletionsBase
} from './base-url'
import { buildProviderEnv } from './provider-env'
import {
  AnthropicProviderBridge,
  type AnthropicProviderBridgeTarget
} from './anthropic-provider-bridge'
import { OpenAiProviderBridge, type OpenAiProviderBridgeTarget } from './openai-provider-bridge'
import {
  ResponsesBridge,
  type ResponsesBridgeConnection,
  type ResponsesBridgeNamespacedTool,
  type ResponsesBridgeTarget
} from './responses-bridge'
import {
  NativeResponsesCompatibilityProxy,
  type NativeResponsesCompatibilityTarget
} from './native-responses-compatibility'
import type { AgentRuntimeManager } from './agent-runtime-manager'
import type { ConnectorSettingsModule } from './connector-settings'
import {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  type ProviderAccountsModule,
  type ProviderRuntimeTarget,
  type RuntimeProviderModelSelection
} from './provider-accounts'
import { ensureCodexAuthHome } from './codex-auth'
import { loopbackProxyBypassEnvironment } from './system-proxy'
import type { StoredSettings } from './types'
import type { ClaudeRuntimeModelConfig } from './claude-config-provision'
import {
  BackendSelectionOwner,
  type AgentBackendSelection,
  type BackendSelectionResolution,
  type ExplicitAgentBackendTarget
} from './backend-selection-owner'
import { BackendRoutePlanner, type BackendTransportPlan } from './backend-route-planner'

export type { AgentBackendSelection, ExplicitAgentBackendTarget } from './backend-selection-owner'

export type AgentBackendResolutionContext = {
  forcedSkillIds?: string[]
  systemPromptAppends?: string[]
  forceCodexNativeResponsesCompatibility?: boolean
}

export type AgentSpawnConfig = {
  envOverrides: Record<string, string>
  executablePath: string
  contextWindow?: number
  sessionOptions?: Record<string, unknown>
}

export type AgentBackendRuntimePort = Pick<
  AgentRuntimeManager,
  | 'resolveClaudeExecutable'
  | 'resolveOpencodeExecutable'
  | 'resolveCodexExecutable'
  | 'probeCodexNativeVersion'
  | 'provisionClaudeRuntimeConfig'
  | 'materializeAgentSkills'
  | 'materializeAgentConfigFiles'
  | 'reserveOpenCodeUsagePort'
  | 'resolveCodexProxyEnvironment'
>

export type AgentBackendProviderPort = Pick<
  ProviderAccountsModule,
  'resolveRuntimeTarget' | 'resolveRuntimeModelCatalog' | 'resolveRuntimeReasoningEffortProfile'
>

export type AgentBackendConnectorPort = Pick<
  ConnectorSettingsModule,
  'enabledConnectorIds' | 'provisionedConnectorSkillNames'
>

type BridgeBasePort = Pick<
  ResponsesBridge,
  | 'start'
  | 'close'
  | 'selectSkills'
  | 'registerReviewerSession'
  | 'unregisterReviewerSession'
  | 'registerToolLessSession'
  | 'unregisterToolLessSession'
>

type ResponsesBridgePort = BridgeBasePort &
  Pick<ResponsesBridge, 'setReasoningEffort' | 'setModelTarget' | 'setTarget'>
type NativeResponsesProxyPort = BridgeBasePort &
  Pick<NativeResponsesCompatibilityProxy, 'setModelTarget' | 'setTarget'>
type AnthropicProviderBridgePort = Pick<AnthropicProviderBridge, 'start' | 'close' | 'setTarget'>
type OpenAiProviderBridgePort = Pick<OpenAiProviderBridge, 'start' | 'close' | 'setTarget'>

type NativeResponsesProxyTarget = NativeResponsesCompatibilityTarget & {
  reviewerScope: { namespacedTools: ResponsesBridgeNamespacedTool[] }
}

type ResponsesBridgeEntry = {
  bridge: ResponsesBridgePort
  connection: Promise<ResponsesBridgeConnection>
}

type NativeResponsesCompatibilityEntry = {
  proxy: NativeResponsesProxyPort
  connection: Promise<ResponsesBridgeConnection>
}

type LeasedResponsesBridgeConnection = ResponsesBridgeConnection & {
  lease: NonNullable<ResolvedAgentBackend['responsesBridgeLease']>
  providerTransportLease?: NonNullable<ResolvedAgentBackend['providerTransportLease']>
}

type OpenCodeProviderTransport = Readonly<{
  provider: ProviderRuntimeTarget['provider']
  providerModelCatalog: readonly AgentModelCatalogEntry[]
  lease: NonNullable<ResolvedAgentBackend['providerTransportLease']>
}>

type NativeCodexProviderTransport = Readonly<{
  provider: ProviderRuntimeTarget['provider']
  lease: NonNullable<ResolvedAgentBackend['providerTransportLease']>
}>

export type AgentBackendResolverOptions = {
  readSettings: () => Promise<StoredSettings>
  providers: AgentBackendProviderPort
  runtime: AgentBackendRuntimePort
  connectors: AgentBackendConnectorPort
  storageRoot: string
  userClaudeDir: string
  readFrameworkOverride?: () => string | undefined
  createResponsesBridge?: (target: ResponsesBridgeTarget) => ResponsesBridgePort
  createNativeResponsesProxy?: (target: NativeResponsesProxyTarget) => NativeResponsesProxyPort
  createAnthropicProviderBridge?: (
    targets: readonly AnthropicProviderBridgeTarget[],
    initialTargetId: string
  ) => AnthropicProviderBridgePort
  createOpenAiProviderBridge?: (
    targets: readonly OpenAiProviderBridgeTarget[],
    initialTargetId: string
  ) => OpenAiProviderBridgePort
  ensureCodexSubscriptionHome?: () => Promise<void>
  nextGenerationId?: () => string
}

// Owns backend resolution decisions and every live bridge/proxy generation created for them. The
// constructor is intentionally side-effect free; runtime resources start only inside resolve calls.
export class AgentBackendResolver {
  private readonly readSettings: () => Promise<StoredSettings>
  private readonly providers: AgentBackendProviderPort
  private readonly runtime: AgentBackendRuntimePort
  private readonly connectors: AgentBackendConnectorPort
  private readonly storageRoot: string
  private readonly userClaudeDir: string
  private readonly selection: BackendSelectionOwner
  private readonly planner: BackendRoutePlanner
  private readonly createResponsesBridge: (target: ResponsesBridgeTarget) => ResponsesBridgePort
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
  private readonly ensureCodexSubscriptionHome: () => Promise<void>
  private readonly nextGenerationId: () => string
  private readonly responsesBridges = new Map<string, ResponsesBridgeEntry>()
  private readonly nativeResponsesCompatibilityProxies = new Map<
    string,
    NativeResponsesCompatibilityEntry
  >()

  constructor(options: AgentBackendResolverOptions) {
    this.readSettings = options.readSettings
    this.providers = options.providers
    this.runtime = options.runtime
    this.connectors = options.connectors
    this.storageRoot = options.storageRoot
    this.userClaudeDir = options.userClaudeDir
    this.selection = new BackendSelectionOwner({
      readSettings: this.readSettings,
      readFrameworkOverride:
        options.readFrameworkOverride ?? (() => process.env.OPEN_SCIENCE_AGENT_FRAMEWORK),
      resolveRuntimeReasoningEffortProfile: (provider, model) =>
        this.providers.resolveRuntimeReasoningEffortProfile(provider, model)
    })
    this.planner = new BackendRoutePlanner({ providers: this.providers })
    this.createResponsesBridge =
      options.createResponsesBridge ?? ((target) => new ResponsesBridge(target))
    this.createNativeResponsesProxy =
      options.createNativeResponsesProxy ??
      ((target) => new NativeResponsesCompatibilityProxy(target))
    this.createAnthropicProviderBridge =
      options.createAnthropicProviderBridge ??
      ((targets, initialTargetId) => new AnthropicProviderBridge(targets, initialTargetId))
    this.createOpenAiProviderBridge =
      options.createOpenAiProviderBridge ??
      ((targets, initialTargetId) => new OpenAiProviderBridge(targets, initialTargetId))
    this.ensureCodexSubscriptionHome =
      options.ensureCodexSubscriptionHome ??
      (() => ensureCodexAuthHome('isolated', this.storageRoot))
    this.nextGenerationId = options.nextGenerationId ?? randomUUID
  }

  async resolveActiveSpawnConfig(
    context: AgentBackendResolutionContext = {}
  ): Promise<AgentSpawnConfig> {
    const settings = await this.readSettings()
    const executablePath = await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath)
    const target = this.resolveConfiguredProviderTarget(settings, getAgentFramework('claude-code'))
    if (target.providerType === 'claude-shared' && target.disconnectedAt !== undefined) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }
    const plan = this.planner.planBackend({
      settings,
      frameworkId: 'claude-code',
      target,
      effortIntent: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      conversationSkillImportEnabled:
        settings.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED
    })
    return this.resolveClaudeSpawnConfig(
      settings,
      target,
      new Set(context.forcedSkillIds ?? []),
      executablePath,
      plan.claudeModelConfig
    )
  }

  async resolveActiveBackend(
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.resolveBackendSelection(await this.selection.resolveActiveSelection(), context)
  }

  async resolveActiveModelChangeTarget(): Promise<AgentModelChangeTarget | undefined> {
    const selection = await this.selection.resolveActiveModelChangeSelection()
    if (!selection) return undefined
    const { settings, frameworkId, providerId, modelSelection, reasoningEffort } = selection
    const framework = getAgentFramework(frameworkId)
    const storedProvider = settings.providers.find((provider) => provider.id === providerId)
    if (!storedProvider) return undefined

    const target = this.providers.resolveRuntimeTarget(storedProvider, modelSelection, framework)
    if (!target.frameworkCompatible || (frameworkId === 'codex' && !target.modelBridgeSupported)) {
      return undefined
    }
    return this.planner.projectModelChange({
      settings,
      frameworkId,
      target,
      effortIntent: reasoningEffort
    })
  }

  async captureConfiguredSelection(): Promise<AgentBackendSelection> {
    return this.selection.captureConfiguredSelection()
  }

  async captureExplicitTarget(): Promise<ExplicitAgentBackendTarget> {
    return this.selection.captureExplicitTarget()
  }

  async resolveSelection(
    selection: AgentBackendSelection,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.resolveBackendSelection(await this.selection.resolveSelection(selection), context)
  }

  async resolveExplicitTarget(
    target: ExplicitAgentBackendTarget,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    return this.resolveBackendSelection(await this.selection.resolveExplicitTarget(target), context)
  }

  async resolveActiveReasoningEffort(intent: ReasoningEffort): Promise<ResolvedReasoningEffort> {
    return this.selection.resolveActiveReasoningEffort(intent)
  }

  private resolveBackendSelection(
    selection: BackendSelectionResolution,
    context: AgentBackendResolutionContext
  ): Promise<ResolvedAgentBackend> {
    return this.resolveBackendFromSettings(
      selection.settings,
      selection.frameworkId,
      selection.providerId,
      selection.modelSelection,
      selection.reasoningEffort,
      context
    )
  }

  private resolveConfiguredProviderTarget(
    settings: StoredSettings,
    framework: ReturnType<typeof getAgentFramework>
  ): ProviderRuntimeTarget {
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined
    if (!activeProvider) throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)
    return this.providers.resolveRuntimeTarget(
      activeProvider,
      { kind: 'configured', requestedModel: settings.activeModel },
      framework
    )
  }

  private async resolveBackendFromSettings(
    settings: StoredSettings,
    frameworkId: AgentFrameworkId,
    providerId: string | undefined,
    modelSelection: RuntimeProviderModelSelection,
    effortIntent: ReasoningEffort,
    context: AgentBackendResolutionContext
  ): Promise<ResolvedAgentBackend> {
    const framework = getAgentFramework(frameworkId)
    const storedProvider = providerId
      ? settings.providers.find((provider) => provider.id === providerId)
      : undefined
    if (!storedProvider) throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)

    const target = this.providers.resolveRuntimeTarget(storedProvider, modelSelection, framework)
    if (!target.frameworkCompatible) {
      throw new Error(buildActiveModelIncompatibleMessage(framework.displayName))
    }
    if (framework.id === 'codex' && !target.modelBridgeSupported) {
      throw new Error(CODEX_BRIDGE_UNSUPPORTED_MESSAGE)
    }
    const forceNativeResponsesCompatibility =
      context.forceCodexNativeResponsesCompatibility === true &&
      framework.id === 'codex' &&
      !target.needsChatResponsesBridge &&
      !target.needsNativeResponsesCompatibility
    if (forceNativeResponsesCompatibility && isCodexSubscriptionProvider(target.provider.type)) {
      throw new Error(
        'Artifact code reconstruction is unavailable with Codex subscription authentication.'
      )
    }
    const forcedSkillIds = new Set(context.forcedSkillIds ?? [])
    const connectorSkillNames =
      framework.id === 'claude-code'
        ? await this.connectors.provisionedConnectorSkillNames()
        : this.connectors.enabledConnectorIds(settings.connectors).map((id) => `mcp-${id}`)
    const connectorInstructions = renderConnectorInstructions(connectorSkillNames)
    const executablePath =
      framework.id === 'claude-code'
        ? await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath)
        : framework.id === 'codex'
          ? await this.runtime.resolveCodexExecutable(
              settings.codex?.resolvedPath,
              settings.codex?.nativePath
            )
          : await this.runtime.resolveOpencodeExecutable(settings.opencodePath)
    const codexNativeVersion =
      framework.id === 'codex'
        ? await this.runtime.probeCodexNativeVersion(settings.codex?.nativePath)
        : undefined
    if (
      framework.id === 'claude-code' &&
      target.providerType === 'claude-shared' &&
      target.disconnectedAt !== undefined
    ) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }
    const plan = this.planner.planBackend({
      settings,
      frameworkId,
      target,
      effortIntent,
      conversationSkillImportEnabled:
        settings.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
      forceNativeResponsesCompatibility
    })
    const modelRoute = plan.modelRoute
    const sessionEffort = plan.sessionEffort
    const supportedReasoningEfforts = plan.supportedReasoningEfforts
    if (framework.id === 'claude-code') {
      const {
        envOverrides,
        executablePath: claudeExecutablePath,
        sessionOptions,
        contextWindow
      } = await this.resolveClaudeSpawnConfig(
        settings,
        target,
        forcedSkillIds,
        executablePath,
        plan.claudeModelConfig
      )
      const bridgeCatalog = plan.transport.kind === 'claude-anthropic' ? plan.transport : undefined
      let bridge: AnthropicProviderBridgePort | undefined
      try {
        const bridgeConnection = bridgeCatalog
          ? await (bridge = this.createAnthropicProviderBridge(
              bridgeCatalog.targets,
              bridgeCatalog.initialTargetId
            )).start()
          : undefined
        const startedBridge = bridge
        const bridgeLease = startedBridge
          ? {
              setTarget: (targetId: string) => startedBridge.setTarget(targetId),
              release: () => startedBridge.close()
            }
          : undefined
        return {
          framework,
          backendId: `${framework.id}:${target.providerId}`,
          modelRoute,
          executablePath: claudeExecutablePath,
          env: {
            ...envOverrides,
            ...(bridgeConnection
              ? {
                  ANTHROPIC_BASE_URL: bridgeConnection.baseUrl,
                  ANTHROPIC_AUTH_TOKEN: bridgeConnection.token,
                  ANTHROPIC_API_KEY: bridgeConnection.token,
                  ...loopbackProxyBypassEnvironment(process.env)
                }
              : {})
          },
          sessionOptions,
          sessionEffort,
          contextWindow,
          ...(target.provider.supportsImageInput ? { supportsImageInput: true } : {}),
          contextUsageModel: target.effectiveModel,
          ...(connectorInstructions ? { systemPromptAppends: [connectorInstructions] } : {}),
          ...(bridgeLease ? { anthropicBridgeLease: bridgeLease } : {})
        }
      } catch (error) {
        await bridge?.close().catch(() => undefined)
        throw error
      }
    }

    let provider = target.provider
    let providerModelCatalog: readonly AgentModelCatalogEntry[] = plan.providerModelCatalog
    if (framework.id === 'codex' && isCodexSubscriptionProvider(provider.type)) {
      await this.ensureCodexSubscriptionHome()
    }
    const backendProviderId = plan.backendProviderId
    const skillsRoot =
      framework.id === 'codex'
        ? isCodexSubscriptionProvider(provider.type)
          ? codexSubscriptionStorageDir(this.storageRoot)
          : codexStorageDir(this.storageRoot)
        : opencodeConfigDir(this.storageRoot)
    await this.runtime.materializeAgentSkills(settings, skillsRoot, forcedSkillIds)

    const openCodeProviderTransport =
      framework.id === 'opencode'
        ? await this.ensureOpenCodeProviderTransports(target, plan.transport)
        : undefined
    if (openCodeProviderTransport) {
      provider = openCodeProviderTransport.provider
      providerModelCatalog = openCodeProviderTransport.providerModelCatalog
    }
    const nativeCodexProviderTransport =
      framework.id === 'codex' && plan.transport.kind === 'codex-native-responses'
        ? await this.ensureNativeCodexProviderTransport(target, plan.transport)
        : undefined
    if (nativeCodexProviderTransport) provider = nativeCodexProviderTransport.provider

    const responsesBridge = target.needsChatResponsesBridge
      ? await this.ensureResponsesBridge(
          target,
          sessionEffort,
          plan.transport,
          plan.codexBridgeTools ?? [],
          plan.reviewerBridgeTools ?? []
        )
      : target.needsNativeResponsesCompatibility ||
          plan.modelRoute === 'codex-responses-compatibility'
        ? await this.ensureNativeResponsesCompatibility(
            target,
            plan.transport,
            plan.reviewerBridgeTools ?? []
          )
        : undefined
    const persistentSystemPromptAppends = [
      ...(context.systemPromptAppends ?? []),
      ...(framework.id === 'codex' && connectorInstructions ? [connectorInstructions] : [])
    ]

    try {
      const modelConfig = framework.prepareModelConfig(provider, {
        storageRoot: this.storageRoot,
        executablePath,
        ...(codexNativeVersion ? { nativeVersion: codexNativeVersion } : {}),
        responsesBridge,
        reasoningEffort: sessionEffort,
        reasoningEfforts: supportedReasoningEfforts,
        providerModelCatalog,
        instructions: connectorInstructions,
        ...(persistentSystemPromptAppends.length > 0
          ? { systemPromptAppends: persistentSystemPromptAppends }
          : {})
      })
      await this.runtime.materializeAgentConfigFiles(modelConfig.configFiles)
      const opencodeUsagePort =
        framework.id === 'opencode' ? await this.runtime.reserveOpenCodeUsagePort() : undefined
      const opencodeUsagePassword = opencodeUsagePort === undefined ? undefined : randomUUID()
      const usesCodexSystemProxy =
        framework.id === 'codex' && isCodexSubscriptionProvider(provider.type)
      const proxyEnv = usesCodexSystemProxy
        ? await this.runtime.resolveCodexProxyEnvironment()
        : undefined
      // Only the Codex child talks to the app-owned bridge at loopback. Add a bypass override for
      // that local hop without copying or clearing proxy variables. This leaves the main-process
      // bridge's upstream network route untouched.
      const loopbackProxyBypass =
        responsesBridge || openCodeProviderTransport || nativeCodexProviderTransport
          ? loopbackProxyBypassEnvironment(process.env)
          : undefined
      const sessionModel = modelConfig.sessionModel ?? provider.model

      return {
        framework,
        backendId: `${framework.id}:${backendProviderId}`,
        modelRoute,
        ...(modelRoute === 'codex-bridge' && responsesBridge?.continuityToken
          ? { providerContinuityToken: responsesBridge.continuityToken }
          : {}),
        executablePath,
        env: {
          ...(modelConfig.env ?? {}),
          ...(opencodeUsagePassword ? { OPENCODE_SERVER_PASSWORD: opencodeUsagePassword } : {}),
          ...(proxyEnv ?? {}),
          ...(loopbackProxyBypass ?? {}),
          ...(framework.id === 'codex' && settings.codex?.nativePath
            ? { CODEX_PATH: settings.codex.nativePath }
            : {})
        },
        args:
          opencodeUsagePort === undefined
            ? modelConfig.args
            : [
                ...(modelConfig.args ?? []),
                '--port',
                String(opencodeUsagePort),
                '--hostname',
                '127.0.0.1'
              ],
        ...(usesCodexSystemProxy
          ? { proxyEnvironmentMode: proxyEnv === undefined ? 'inherit' : 'replace' }
          : {}),
        sessionModel,
        ...(framework.id === 'codex' && isCodexSubscriptionProvider(provider.type) && sessionModel
          ? { sessionModelRequired: true }
          : {}),
        sessionEffort,
        contextWindow: provider.contextWindow,
        ...(provider.supportsImageInput ? { supportsImageInput: true } : {}),
        contextUsageModel: provider.model,
        authentication: modelConfig.authentication,
        providerConfiguration: modelConfig.providerConfiguration,
        persistentSystemPrompt: modelConfig.persistentSystemPrompt,
        ...(opencodeUsagePort === undefined || !opencodeUsagePassword
          ? {}
          : {
              opencodeUsageApi: {
                baseUrl: `http://127.0.0.1:${opencodeUsagePort}`,
                authorization: `Basic ${Buffer.from(`opencode:${opencodeUsagePassword}`).toString('base64')}`
              }
            }),
        responsesBridgeLease: responsesBridge?.lease,
        providerTransportLease:
          openCodeProviderTransport?.lease ??
          nativeCodexProviderTransport?.lease ??
          responsesBridge?.providerTransportLease
      }
    } catch (error) {
      await responsesBridge?.lease.release()
      await openCodeProviderTransport?.lease.release()
      await nativeCodexProviderTransport?.lease.release()
      throw error
    }
  }

  private async resolveClaudeSpawnConfig(
    settings: StoredSettings,
    target: ProviderRuntimeTarget,
    forcedSkillIds: ReadonlySet<string>,
    resolvedExecutablePath?: string,
    modelConfig?: ClaudeRuntimeModelConfig
  ): Promise<AgentSpawnConfig> {
    const executablePath =
      resolvedExecutablePath ??
      (await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath))
    if (target.providerType === 'claude-shared' && target.disconnectedAt !== undefined) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }
    const provider = target.provider
    const appConfigDir = await this.runtime.provisionClaudeRuntimeConfig(
      settings,
      forcedSkillIds,
      modelConfig ?? null
    )
    const envOverrides = buildProviderEnv(provider, {
      storageRoot: this.storageRoot,
      claudeExecutablePath: executablePath,
      userClaudeConfigDir: this.userClaudeDir
    })
    const sessionOptions =
      target.providerType === 'claude-shared'
        ? {
            settings: join(appConfigDir, 'settings.json'),
            plugins: [{ type: 'local', path: appConfigDir, skipMcpDiscovery: true }]
          }
        : provider.type === 'custom'
          ? {
              settings: {
                skipWebFetchPreflight: true,
                permissions: { ask: ['WebFetch'] },
                ...(modelConfig ?? {})
              }
            }
          : undefined

    return {
      envOverrides,
      executablePath,
      sessionOptions,
      contextWindow: provider.contextWindow
    }
  }

  private async ensureOpenCodeProviderTransports(
    activeTarget: ProviderRuntimeTarget,
    transport: BackendTransportPlan
  ): Promise<OpenCodeProviderTransport | undefined> {
    if (transport.kind !== 'opencode-openai' && transport.kind !== 'opencode-anthropic') {
      return undefined
    }
    const route = transport.kind

    const bridges: Array<AnthropicProviderBridgePort | OpenAiProviderBridgePort> = []
    const targetIds = new Set<string>()
    const catalog: AgentModelCatalogEntry[] = []
    let activeProvider: ProviderRuntimeTarget['provider'] | undefined

    try {
      for (const planned of transport.targets) {
        const candidate = planned.target
        const model = candidate.effectiveModel ?? candidate.provider.model
        if (!model) continue
        const targetId = planned.id
        const bridge =
          route === 'opencode-openai'
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
                    model
                  }
                ],
                targetId
              )
        bridges.push(bridge)
        const connection = await bridge.start()
        const apiEndpoints = [
          route === 'opencode-openai' ? ('openai' as const) : ('anthropic' as const)
        ]
        const localProvider = Object.freeze({
          ...candidate.provider,
          agentProviderId: opencodeTransportProviderId(candidate.providerId, model),
          baseUrl: connection.baseUrl,
          ...(route === 'opencode-openai'
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
          candidate.providerId === activeTarget.providerId &&
          model === (activeTarget.effectiveModel ?? activeTarget.provider.model)
        ) {
          activeProvider = localProvider
        }
      }

      if (!activeProvider)
        throw new Error('The active OpenCode transport target was not registered.')
      let released = false
      return Object.freeze({
        provider: activeProvider,
        providerModelCatalog: Object.freeze(catalog),
        lease: {
          setTarget: (targetId: string) => targetIds.has(targetId),
          release: async () => {
            if (released) return
            released = true
            await Promise.all(bridges.map((bridge) => bridge.close()))
          }
        }
      })
    } catch (error) {
      await Promise.all(bridges.map((bridge) => bridge.close().catch(() => undefined)))
      throw error
    }
  }

  private async ensureNativeCodexProviderTransport(
    activeTarget: ProviderRuntimeTarget,
    transport: Extract<BackendTransportPlan, { targets: readonly unknown[] }>
  ): Promise<NativeCodexProviderTransport> {
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
    const activeModel = activeTarget.effectiveModel ?? activeTarget.provider.model
    if (!activeModel) throw new Error('The active native Responses model is unavailable.')
    const initialTargetId = transport.initialTargetId
    if (!initialTargetId) throw new Error('The active native Responses model is unavailable.')
    const bridge = this.createOpenAiProviderBridge(targets, initialTargetId)

    try {
      const connection = await bridge.start()
      let released = false
      return Object.freeze({
        provider: Object.freeze({
          ...activeTarget.provider,
          baseUrl: connection.baseUrl,
          openaiBaseUrl: `${connection.baseUrl}/v1`,
          model: activeModel,
          key: connection.token,
          apiEndpoints: ['responses'] as const
        }),
        lease: {
          setTarget: (targetId: string) => bridge.setTarget(targetId),
          release: async () => {
            if (released) return
            released = true
            await bridge.close()
          }
        }
      })
    } catch (error) {
      await bridge.close().catch(() => undefined)
      throw error
    }
  }

  private async ensureResponsesBridge(
    activeTarget: ProviderRuntimeTarget,
    reasoningEffort: ModelReasoningEffort | undefined,
    transport: BackendTransportPlan,
    namespacedTools: readonly ResponsesBridgeNamespacedTool[],
    reviewerTools: readonly ResponsesBridgeNamespacedTool[]
  ): Promise<LeasedResponsesBridgeConnection> {
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
        namespacedTools: [...namespacedTools],
        reviewerScope: { namespacedTools: [...reviewerTools] }
      }
    }
    const targets = new Map<string, ResponsesBridgeTarget>()
    const plannedTargets = transport.kind === 'codex-chat' ? transport.targets : []
    for (const planned of plannedTargets) {
      const candidate = planned.target
      const model = candidate.effectiveModel ?? candidate.provider.model
      if (!model) continue
      targets.set(planned.id, createTarget(candidate, planned.reasoningEffort))
    }
    const activeModel = activeTarget.effectiveModel ?? activeTarget.provider.model
    const initialTargetId = activeModel
      ? plannedTargets.find(
          ({ target }) =>
            target.providerId === activeTarget.providerId &&
            (target.effectiveModel ?? target.provider.model) === activeModel
        )?.id
      : undefined
    const target =
      (initialTargetId ? targets.get(initialTargetId) : undefined) ??
      createTarget(activeTarget, reasoningEffort)
    const bridgeId = this.nextGenerationId()
    const bridge = this.createResponsesBridge(target)
    const entry = { bridge, connection: bridge.start() }
    this.responsesBridges.set(bridgeId, entry)

    let connection: ResponsesBridgeConnection
    try {
      connection = await entry.connection
    } catch (error) {
      if (this.responsesBridges.get(bridgeId) === entry) this.responsesBridges.delete(bridgeId)
      await entry.bridge.close().catch(() => undefined)
      throw error
    }

    let released = false
    const leasedEntry = entry
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      if (this.responsesBridges.get(bridgeId) !== leasedEntry) return
      this.responsesBridges.delete(bridgeId)
      await leasedEntry.bridge.close()
    }
    return {
      ...connection,
      lease: {
        selectSkills: (text, catalog, signal) =>
          leasedEntry.bridge.selectSkills(text, catalog, signal),
        registerReviewerSession: (promptCacheKey) =>
          leasedEntry.bridge.registerReviewerSession(promptCacheKey),
        unregisterReviewerSession: (promptCacheKey) =>
          leasedEntry.bridge.unregisterReviewerSession(promptCacheKey),
        registerToolLessSession: (promptCacheKey) =>
          leasedEntry.bridge.registerToolLessSession(promptCacheKey),
        unregisterToolLessSession: (promptCacheKey) =>
          leasedEntry.bridge.unregisterToolLessSession(promptCacheKey),
        setReasoningEffort: (effort) => leasedEntry.bridge.setReasoningEffort(effort),
        setModelTarget: (target) => leasedEntry.bridge.setModelTarget(target),
        release
      },
      ...(targets.size > 0
        ? {
            providerTransportLease: {
              setTarget: (targetId: string) => {
                const providerTarget = targets.get(targetId)
                if (!providerTarget) return false
                leasedEntry.bridge.setTarget(providerTarget)
                return true
              },
              release
            }
          }
        : {})
    }
  }

  private async ensureNativeResponsesCompatibility(
    activeTarget: ProviderRuntimeTarget,
    transport: BackendTransportPlan,
    reviewerTools: readonly ResponsesBridgeNamespacedTool[]
  ): Promise<LeasedResponsesBridgeConnection> {
    const createTarget = (candidate: ProviderRuntimeTarget): NativeResponsesProxyTarget => {
      const targetBaseUrl = normalizeResponsesBaseUrl(
        candidate.provider.openaiBaseUrl ?? candidate.provider.baseUrl
      )
      if (!targetBaseUrl) throw new Error('The native Responses provider has no base URL.')
      return {
        baseUrl: targetBaseUrl,
        key: candidate.provider.key,
        model: candidate.effectiveModel ?? candidate.provider.model,
        reviewerScope: { namespacedTools: [...reviewerTools] }
      }
    }
    const targets = new Map<string, NativeResponsesProxyTarget>()
    const plannedTargets =
      transport.kind === 'codex-responses-compatibility' ? transport.targets : []
    for (const planned of plannedTargets) {
      const candidate = planned.target
      const model = candidate.effectiveModel ?? candidate.provider.model
      if (!model) continue
      targets.set(planned.id, createTarget(candidate))
    }
    const activeModel = activeTarget.effectiveModel ?? activeTarget.provider.model
    const initialTargetId = activeModel
      ? plannedTargets.find(
          ({ target }) =>
            target.providerId === activeTarget.providerId &&
            (target.effectiveModel ?? target.provider.model) === activeModel
        )?.id
      : undefined
    const proxyId = this.nextGenerationId()
    const proxy = this.createNativeResponsesProxy(
      (initialTargetId ? targets.get(initialTargetId) : undefined) ?? createTarget(activeTarget)
    )
    const entry = { proxy, connection: proxy.start() }
    this.nativeResponsesCompatibilityProxies.set(proxyId, entry)

    let connection: ResponsesBridgeConnection
    try {
      connection = await entry.connection
    } catch (error) {
      if (this.nativeResponsesCompatibilityProxies.get(proxyId) === entry) {
        this.nativeResponsesCompatibilityProxies.delete(proxyId)
      }
      await entry.proxy.close().catch(() => undefined)
      throw error
    }

    let released = false
    const leasedEntry = entry
    const release = async (): Promise<void> => {
      if (released) return
      released = true
      if (this.nativeResponsesCompatibilityProxies.get(proxyId) !== leasedEntry) return
      this.nativeResponsesCompatibilityProxies.delete(proxyId)
      await leasedEntry.proxy.close()
    }
    return {
      ...connection,
      lease: {
        selectSkills: (text, catalog, signal) =>
          leasedEntry.proxy.selectSkills(text, catalog, signal),
        registerReviewerSession: (promptCacheKey) =>
          leasedEntry.proxy.registerReviewerSession(promptCacheKey),
        unregisterReviewerSession: (promptCacheKey) =>
          leasedEntry.proxy.unregisterReviewerSession(promptCacheKey),
        registerToolLessSession: (promptCacheKey) =>
          leasedEntry.proxy.registerToolLessSession(promptCacheKey),
        unregisterToolLessSession: (promptCacheKey) =>
          leasedEntry.proxy.unregisterToolLessSession(promptCacheKey),
        setModelTarget: (target) => leasedEntry.proxy.setModelTarget(target),
        release
      },
      ...(targets.size > 0
        ? {
            providerTransportLease: {
              setTarget: (targetId: string) => {
                const providerTarget = targets.get(targetId)
                if (!providerTarget) return false
                leasedEntry.proxy.setTarget(providerTarget)
                return true
              },
              release
            }
          }
        : {})
    }
  }
}
