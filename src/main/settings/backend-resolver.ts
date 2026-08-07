import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { z } from 'zod'

import type { ReasoningEffort } from '../../shared/settings'
import {
  CODEX_ISOLATED_PROVIDER_ID,
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_REASONING_EFFORT,
  isCodexSubscriptionProvider
} from '../../shared/settings'
import {
  buildActiveModelIncompatibleMessage,
  CODEX_BRIDGE_UNSUPPORTED_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE
} from '../../shared/run-error-classification'
import {
  resolveReasoningEffortValue,
  type ModelReasoningEffort,
  type ResolvedReasoningEffort
} from '../../shared/reasoning-effort'
import {
  DEFAULT_AGENT_FRAMEWORK_ID,
  getAgentFramework,
  type AgentModelCatalogEntry,
  type AgentModelChangeTarget,
  type AgentModelRoute,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import { opencodeConfigDir, opencodeTransportProviderId } from '../agent-framework/opencode'
import {
  CODEX_BRIDGE_MODEL,
  codexStorageDir,
  codexSubscriptionStorageDir,
  normalizeResponsesBaseUrl
} from '../agent-framework/codex'
import { renderConnectorInstructions } from '../connectors/skill-doc'
import { NOTEBOOK_MCP_SERVER_NAME, NOTEBOOK_RPC_TOOLS } from '../notebook/mcp-server'
import { ARTIFACT_MCP_SERVER_NAME, writeArtifactFileToolSchema } from '../artifacts/mcp-server'
import { REVIEWER_BRIDGE_NAMESPACED_TOOLS } from '../reviewer/bridge-tools'
import { requestSkillImportToolSchema } from '../skills/mcp-server'
import {
  REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
  REQUEST_SKILL_IMPORT_TOOL_NAME,
  SKILL_IMPORT_MCP_SERVER_NAME
} from '../../shared/skill-import'
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

export type AgentBackendSelection = Readonly<{
  frameworkId: AgentFrameworkId
}>

export type AgentBackendResolutionContext = {
  forcedSkillIds?: string[]
  systemPromptAppends?: string[]
  forceCodexNativeResponsesCompatibility?: boolean
}

export type ExplicitAgentBackendTarget = Readonly<{
  frameworkId: AgentFrameworkId
  providerId: string
  model: Readonly<{ kind: 'required'; id: string }> | Readonly<{ kind: 'provider-default' }>
  reasoningEffort: ReasoningEffort
}>

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

const modelRouteFor = (
  frameworkId: AgentFrameworkId,
  target: ProviderRuntimeTarget
): AgentModelRoute => {
  if (frameworkId === 'claude-code') return 'claude-anthropic'
  if (frameworkId === 'opencode') {
    return target.apiEndpoints.includes('openai') ? 'opencode-openai' : 'opencode-anthropic'
  }
  if (target.needsChatResponsesBridge) return 'codex-bridge'
  if (target.needsNativeResponsesCompatibility) return 'codex-responses-compatibility'
  return 'codex-responses'
}

const resolvedModelEffort = (
  intent: ReasoningEffort,
  target: ProviderRuntimeTarget
): ResolvedReasoningEffort =>
  intent === DEFAULT_REASONING_EFFORT
    ? DEFAULT_REASONING_EFFORT
    : resolveReasoningEffortValue(intent, target.reasoningEffortProfile)

const claudeBridgeTargetId = (providerId: string, model: string): string =>
  JSON.stringify([providerId, model])

const providerTransportTargetId = (
  frameworkId: AgentFrameworkId,
  providerId: string,
  model: string
): string => JSON.stringify([frameworkId, providerId, model])

type ClaudeBridgeCatalog = Readonly<{
  targets: readonly AnthropicProviderBridgeTarget[]
  initialTargetId: string
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

// Codex exposes local MCP tools as namespaced Responses functions. Chat Completions has no namespace
// field, so the bridge receives the app-owned notebook schemas and aliases them for the upstream.
const CODEX_NOTEBOOK_TOOL_NAMESPACE = `mcp__${NOTEBOOK_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_'
)}`
const CODEX_BRIDGE_NOTEBOOK_TOOLS: ResponsesBridgeNamespacedTool[] = NOTEBOOK_RPC_TOOLS.map(
  (tool) => ({
    namespace: CODEX_NOTEBOOK_TOOL_NAMESPACE,
    name: tool.name,
    description:
      tool.name === 'notebook_execute'
        ? `${tool.description} For Open Science data connectors, the Python code MUST call host.mcp(server, method, arguments). Never use requests, urllib, httpx, curl, or a raw upstream API for connector data; those bypass app permissions, credentials, and rate limits. Codex MCP resource-list tools are not connector discovery.`
        : tool.description,
    parameters: z.toJSONSchema(z.object(tool.inputSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  })
)
const CODEX_ARTIFACT_TOOL_NAMESPACE = `mcp__${ARTIFACT_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_'
)}`
const CODEX_BRIDGE_ARTIFACT_TOOLS: ResponsesBridgeNamespacedTool[] = [
  {
    namespace: CODEX_ARTIFACT_TOOL_NAMESPACE,
    name: 'write_artifact_file',
    description:
      'Attach a generated image, chart, report, data export, or archive to the current Open Science response. The file must already exist before using a localPath source.',
    parameters: z.toJSONSchema(z.object(writeArtifactFileToolSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]
const CODEX_SKILL_IMPORT_TOOL_NAMESPACE = `mcp__${SKILL_IMPORT_MCP_SERVER_NAME.replace(
  /[^a-zA-Z0-9_]/g,
  '_'
)}`
const CODEX_BRIDGE_SKILL_IMPORT_TOOLS: ResponsesBridgeNamespacedTool[] = [
  {
    namespace: CODEX_SKILL_IMPORT_TOOL_NAMESPACE,
    name: REQUEST_SKILL_IMPORT_TOOL_NAME,
    description: REQUEST_SKILL_IMPORT_TOOL_DESCRIPTION,
    parameters: z.toJSONSchema(z.object(requestSkillImportToolSchema), {
      target: 'draft-7'
    }) as ResponsesBridgeNamespacedTool['parameters']
  }
]

// Owns backend resolution decisions and every live bridge/proxy generation created for them. The
// constructor is intentionally side-effect free; runtime resources start only inside resolve calls.
export class AgentBackendResolver {
  private readonly readSettings: () => Promise<StoredSettings>
  private readonly providers: AgentBackendProviderPort
  private readonly runtime: AgentBackendRuntimePort
  private readonly connectors: AgentBackendConnectorPort
  private readonly storageRoot: string
  private readonly userClaudeDir: string
  private readonly readFrameworkOverride: () => string | undefined
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
    this.readFrameworkOverride =
      options.readFrameworkOverride ?? (() => process.env.OPEN_SCIENCE_AGENT_FRAMEWORK)
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
    return this.resolveClaudeSpawnConfig(
      settings,
      target,
      new Set(context.forcedSkillIds ?? []),
      executablePath
    )
  }

  async resolveActiveBackend(
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    const settings = await this.readSettings()
    const frameworkId = this.resolveConfiguredFrameworkId(settings)
    return this.resolveBackendFromSettings(
      settings,
      frameworkId,
      settings.activeProviderId,
      { kind: 'configured', requestedModel: settings.activeModel },
      settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      context
    )
  }

  async resolveActiveModelChangeTarget(): Promise<AgentModelChangeTarget | undefined> {
    const settings = await this.readSettings()
    const frameworkId = this.resolveConfiguredFrameworkId(settings)
    const framework = getAgentFramework(frameworkId)
    const storedProvider = settings.activeProviderId
      ? settings.providers.find((provider) => provider.id === settings.activeProviderId)
      : undefined
    if (!storedProvider) return undefined

    const target = this.providers.resolveRuntimeTarget(
      storedProvider,
      { kind: 'configured', requestedModel: settings.activeModel },
      framework
    )
    if (!target.frameworkCompatible || (frameworkId === 'codex' && !target.modelBridgeSupported)) {
      return undefined
    }

    const model = target.effectiveModel ?? target.provider.model
    if (!model) return undefined
    const route = modelRouteFor(frameworkId, target)
    const openCodeTransportTargets =
      frameworkId === 'opencode' ? this.resolveOpenCodeApiTargets(settings, target, route) : []
    const hasOpenCodeProviderTransport =
      new Set(openCodeTransportTargets.map((candidate) => candidate.providerId)).size >= 2
    const codexTransportTargets =
      frameworkId === 'codex' ? this.resolveCodexApiTargets(settings, target, route) : []
    const hasCodexProviderTransport =
      new Set(codexTransportTargets.map((candidate) => candidate.providerId)).size >= 2
    const hasClaudeProviderTransport =
      frameworkId === 'claude-code' &&
      this.resolveClaudeBridgeCatalog(settings, target) !== undefined
    const backendProviderId =
      frameworkId === 'codex' && isCodexSubscriptionProvider(target.provider.type)
        ? CODEX_ISOLATED_PROVIDER_ID
        : target.providerId

    return Object.freeze({
      frameworkId,
      backendId: `${frameworkId}:${backendProviderId}`,
      route,
      model,
      sessionModel:
        route === 'codex-bridge'
          ? CODEX_BRIDGE_MODEL
          : hasOpenCodeProviderTransport
            ? `${opencodeTransportProviderId(target.providerId, model)}/${model}`
            : model,
      sessionModelRequired:
        frameworkId === 'codex' && isCodexSubscriptionProvider(target.provider.type),
      supportsImageInput: target.provider.supportsImageInput === true,
      reasoningEffort: resolvedModelEffort(
        settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        target
      ),
      ...(hasClaudeProviderTransport
        ? { anthropicBridgeTargetId: claudeBridgeTargetId(target.providerId, model) }
        : {}),
      ...(hasOpenCodeProviderTransport || hasCodexProviderTransport
        ? {
            providerTransportTargetId: providerTransportTargetId(
              frameworkId,
              target.providerId,
              model
            )
          }
        : {}),
      ...(target.provider.contextWindow ? { contextWindow: target.provider.contextWindow } : {}),
      ...(route === 'codex-bridge' || route === 'codex-responses-compatibility'
        ? {
            bridge: Object.freeze({
              model,
              ...(target.provider.vendorId ? { vendorId: target.provider.vendorId } : {}),
              ...(target.provider.reasoningEffortTransport
                ? { reasoningEffortTransport: target.provider.reasoningEffortTransport }
                : {})
            })
          }
        : {})
    })
  }

  async captureConfiguredSelection(): Promise<AgentBackendSelection> {
    const settings = await this.readSettings()
    return { frameworkId: this.resolveConfiguredFrameworkId(settings) }
  }

  async captureExplicitTarget(): Promise<ExplicitAgentBackendTarget> {
    const settings = await this.readSettings()
    if (!settings.activeProviderId) throw new Error(NO_ACTIVE_PROVIDER_MESSAGE)
    return Object.freeze({
      frameworkId: this.resolveConfiguredFrameworkId(settings),
      providerId: settings.activeProviderId,
      model: settings.activeModel
        ? Object.freeze({ kind: 'required' as const, id: settings.activeModel })
        : Object.freeze({ kind: 'provider-default' as const }),
      reasoningEffort: settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    })
  }

  async resolveSelection(
    selection: AgentBackendSelection,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    const settings = await this.readSettings()
    return this.resolveBackendFromSettings(
      settings,
      selection.frameworkId,
      settings.activeProviderId,
      { kind: 'configured', requestedModel: settings.activeModel },
      settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      context
    )
  }

  async resolveExplicitTarget(
    target: ExplicitAgentBackendTarget,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    const settings = await this.readSettings()
    const modelSelection: RuntimeProviderModelSelection =
      target.model.kind === 'required'
        ? { kind: 'required', model: target.model.id }
        : { kind: 'provider-default' }
    return this.resolveBackendFromSettings(
      settings,
      target.frameworkId,
      target.providerId,
      modelSelection,
      target.reasoningEffort,
      context
    )
  }

  async resolveActiveReasoningEffort(intent: ReasoningEffort): Promise<ResolvedReasoningEffort> {
    const settings = await this.readSettings()
    if (intent === DEFAULT_REASONING_EFFORT) return DEFAULT_REASONING_EFFORT
    const activeProvider = settings.activeProviderId
      ? settings.providers.find((candidate) => candidate.id === settings.activeProviderId)
      : undefined
    if (!activeProvider) return DEFAULT_REASONING_EFFORT

    const profile = this.providers.resolveRuntimeReasoningEffortProfile(
      activeProvider,
      settings.activeModel
    )
    return resolveReasoningEffortValue(intent, profile)
  }

  private resolveConfiguredFrameworkId(settings: StoredSettings): AgentFrameworkId {
    const forced = this.readFrameworkOverride()
    return forced === 'opencode' || forced === 'claude-code' || forced === 'codex'
      ? forced
      : (settings.agentFrameworkId ?? DEFAULT_AGENT_FRAMEWORK_ID)
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

    const configuredModelRoute = modelRouteFor(frameworkId, target)
    const forceNativeResponsesCompatibility =
      context.forceCodexNativeResponsesCompatibility === true &&
      framework.id === 'codex' &&
      configuredModelRoute === 'codex-responses'
    if (forceNativeResponsesCompatibility && isCodexSubscriptionProvider(target.provider.type)) {
      throw new Error(
        'Artifact code reconstruction is unavailable with Codex subscription authentication.'
      )
    }
    const modelRoute = forceNativeResponsesCompatibility
      ? 'codex-responses-compatibility'
      : configuredModelRoute
    const resolvedEffort = resolvedModelEffort(effortIntent, target)
    const sessionEffort: ModelReasoningEffort | undefined =
      resolvedEffort === 'default' ? undefined : resolvedEffort
    const supportedReasoningEfforts = target.reasoningEffortProfile.supported
      ? [...new Set(target.reasoningEffortProfile.slots)]
      : undefined
    const forcedSkillIds = new Set(context.forcedSkillIds ?? [])
    const connectorSkillNames =
      framework.id === 'claude-code'
        ? await this.connectors.provisionedConnectorSkillNames()
        : this.connectors.enabledConnectorIds(settings.connectors).map((id) => `mcp-${id}`)
    const connectorInstructions = renderConnectorInstructions(connectorSkillNames)
    if (framework.id === 'claude-code') {
      const { envOverrides, executablePath, sessionOptions, contextWindow } =
        await this.resolveClaudeSpawnConfig(settings, target, forcedSkillIds)
      const bridgeCatalog = this.resolveClaudeBridgeCatalog(settings, target)
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
          executablePath,
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

    const executablePath =
      framework.id === 'codex'
        ? await this.runtime.resolveCodexExecutable(
            settings.codex?.resolvedPath,
            settings.codex?.nativePath
          )
        : await this.runtime.resolveOpencodeExecutable(settings.opencodePath)
    const codexNativeVersion =
      framework.id === 'codex'
        ? await this.runtime.probeCodexNativeVersion(settings.codex?.nativePath)
        : undefined
    let provider = target.provider
    const codexProviderTargets =
      framework.id === 'codex' ? this.resolveCodexApiTargets(settings, target, modelRoute) : []
    const hasCodexProviderTransport =
      new Set(codexProviderTargets.map((candidate) => candidate.providerId)).size >= 2
    const catalogTargets = hasCodexProviderTransport
      ? codexProviderTargets
      : this.providers.resolveRuntimeModelCatalog(storedProvider, framework)
    let providerModelCatalog: readonly AgentModelCatalogEntry[] = catalogTargets
      .filter(
        (candidate) =>
          candidate.frameworkCompatible &&
          (framework.id !== 'codex' || candidate.modelBridgeSupported) &&
          modelRouteFor(framework.id, candidate) === modelRoute
      )
      .map((candidate) => {
        const candidateEffort = resolvedModelEffort(effortIntent, candidate)
        return Object.freeze({
          provider: candidate.provider,
          ...(candidateEffort === 'default' ? {} : { reasoningEffort: candidateEffort }),
          ...(candidate.reasoningEffortProfile.supported
            ? { reasoningEfforts: [...new Set(candidate.reasoningEffortProfile.slots)] }
            : {})
        })
      })
    if (framework.id === 'codex' && isCodexSubscriptionProvider(provider.type)) {
      await this.ensureCodexSubscriptionHome()
    }
    const backendProviderId =
      framework.id === 'codex' && isCodexSubscriptionProvider(provider.type)
        ? CODEX_ISOLATED_PROVIDER_ID
        : target.providerId
    const skillsRoot =
      framework.id === 'codex'
        ? isCodexSubscriptionProvider(provider.type)
          ? codexSubscriptionStorageDir(this.storageRoot)
          : codexStorageDir(this.storageRoot)
        : opencodeConfigDir(this.storageRoot)
    await this.runtime.materializeAgentSkills(settings, skillsRoot, forcedSkillIds)

    const openCodeProviderTransport =
      framework.id === 'opencode'
        ? await this.ensureOpenCodeProviderTransports(settings, target, modelRoute, effortIntent)
        : undefined
    if (openCodeProviderTransport) {
      provider = openCodeProviderTransport.provider
      providerModelCatalog = openCodeProviderTransport.providerModelCatalog
    }
    const nativeCodexProviderTransport =
      framework.id === 'codex' && modelRoute === 'codex-responses' && hasCodexProviderTransport
        ? await this.ensureNativeCodexProviderTransport(target, codexProviderTargets)
        : undefined
    if (nativeCodexProviderTransport) provider = nativeCodexProviderTransport.provider

    const responsesBridge = target.needsChatResponsesBridge
      ? await this.ensureResponsesBridge(
          target,
          sessionEffort,
          settings.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
          hasCodexProviderTransport ? codexProviderTargets : undefined,
          effortIntent
        )
      : target.needsNativeResponsesCompatibility || forceNativeResponsesCompatibility
        ? await this.ensureNativeResponsesCompatibility(
            target,
            hasCodexProviderTransport ? codexProviderTargets : undefined
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
    resolvedExecutablePath?: string
  ): Promise<AgentSpawnConfig> {
    const executablePath =
      resolvedExecutablePath ??
      (await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath))
    if (target.providerType === 'claude-shared' && target.disconnectedAt !== undefined) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }
    const provider = target.provider
    const modelConfig = this.resolveClaudeModelConfig(settings, target)
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

  private resolveClaudeModelConfig(
    settings: StoredSettings,
    target: ProviderRuntimeTarget
  ): ClaudeRuntimeModelConfig | undefined {
    if (target.provider.type !== 'custom') return undefined
    const registered = [
      ...new Set(
        this.resolveClaudeApiTargets(settings, target).map(
          (candidate) => candidate.effectiveModel ?? candidate.provider.model
        )
      )
    ].filter((model): model is string => Boolean(model))
    if (registered.length < 2) return undefined

    return Object.freeze({
      availableModels: Object.freeze([...registered]),
      modelOverrides: Object.freeze(
        // Identity overrides deliberately register opaque third-party ids with Claude's SDK. A real
        // adapter spike verifies that this has no three-alias ceiling and setModel accepts every row.
        Object.fromEntries(registered.map((model) => [model, model]))
      )
    })
  }

  private resolveClaudeBridgeCatalog(
    settings: StoredSettings,
    target: ProviderRuntimeTarget
  ): ClaudeBridgeCatalog | undefined {
    if (target.provider.type !== 'custom') return undefined
    const apiTargets = this.resolveClaudeApiTargets(settings, target)
    if (new Set(apiTargets.map((candidate) => candidate.providerId)).size < 2) return undefined
    const targets = apiTargets.flatMap((candidate): AnthropicProviderBridgeTarget[] => {
      const model = candidate.effectiveModel ?? candidate.provider.model
      const baseUrl = normalizeAnthropicBaseUrl(candidate.provider.baseUrl ?? '')
      if (!model || !baseUrl) return []
      return [
        Object.freeze({
          id: claudeBridgeTargetId(candidate.providerId, model),
          baseUrl,
          ...(candidate.provider.key ? { key: candidate.provider.key } : {}),
          model
        })
      ]
    })
    const initialModel = target.effectiveModel ?? target.provider.model
    if (!initialModel) return undefined
    const initialTargetId = claudeBridgeTargetId(target.providerId, initialModel)
    if (!targets.some((candidate) => candidate.id === initialTargetId)) return undefined

    return Object.freeze({ targets: Object.freeze(targets), initialTargetId })
  }

  private resolveClaudeApiTargets(
    settings: StoredSettings,
    activeTarget: ProviderRuntimeTarget
  ): ProviderRuntimeTarget[] {
    const framework = getAgentFramework('claude-code')
    const candidates: ProviderRuntimeTarget[] = [activeTarget]

    for (const storedProvider of settings.providers) {
      try {
        const configured =
          storedProvider.id === activeTarget.providerId
            ? activeTarget
            : this.providers.resolveRuntimeTarget(
                storedProvider,
                { kind: 'configured', requestedModel: storedProvider.model },
                framework
              )
        candidates.push(configured)
        candidates.push(...this.providers.resolveRuntimeModelCatalog(storedProvider, framework))
      } catch {
        // Another configured provider may have stale/missing credentials. It must not prevent the
        // active backend from starting; selecting it later falls back to reconnect and validation.
      }
    }

    const seen = new Set<string>()
    return candidates.filter((candidate) => {
      const model = candidate.effectiveModel ?? candidate.provider.model
      if (
        !candidate.frameworkCompatible ||
        candidate.provider.type !== 'custom' ||
        !candidate.apiEndpoints.includes('anthropic') ||
        !model ||
        !candidate.provider.baseUrl ||
        !candidate.provider.key
      ) {
        return false
      }
      const id = claudeBridgeTargetId(candidate.providerId, model)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  private resolveOpenCodeApiTargets(
    settings: StoredSettings,
    activeTarget: ProviderRuntimeTarget,
    route: AgentModelRoute
  ): ProviderRuntimeTarget[] {
    if (route !== 'opencode-anthropic' && route !== 'opencode-openai') return []
    const framework = getAgentFramework('opencode')
    const candidates: ProviderRuntimeTarget[] = [activeTarget]

    for (const storedProvider of settings.providers) {
      try {
        const configured =
          storedProvider.id === activeTarget.providerId
            ? activeTarget
            : this.providers.resolveRuntimeTarget(
                storedProvider,
                { kind: 'configured', requestedModel: storedProvider.model },
                framework
              )
        candidates.push(configured)
        candidates.push(...this.providers.resolveRuntimeModelCatalog(storedProvider, framework))
      } catch {
        // A stale provider must not stop the active generation. If selected later it reconnects.
      }
    }

    const seen = new Set<string>()
    return candidates.filter((candidate) => {
      const model = candidate.effectiveModel ?? candidate.provider.model
      const endpoint =
        route === 'opencode-openai'
          ? openAiChatCompletionsUrl(candidate.provider)
          : normalizeAnthropicBaseUrl(candidate.provider.baseUrl ?? '')
      const id = model
        ? providerTransportTargetId('opencode', candidate.providerId, model)
        : undefined
      if (
        !candidate.frameworkCompatible ||
        modelRouteFor('opencode', candidate) !== route ||
        !model ||
        !endpoint ||
        !id ||
        seen.has(id)
      ) {
        return false
      }
      seen.add(id)
      return true
    })
  }

  private resolveCodexApiTargets(
    settings: StoredSettings,
    activeTarget: ProviderRuntimeTarget,
    route: AgentModelRoute
  ): ProviderRuntimeTarget[] {
    if (
      route !== 'codex-bridge' &&
      route !== 'codex-responses-compatibility' &&
      route !== 'codex-responses'
    ) {
      return []
    }
    const framework = getAgentFramework('codex')
    const candidates: ProviderRuntimeTarget[] = [activeTarget]

    for (const storedProvider of settings.providers) {
      try {
        const configured =
          storedProvider.id === activeTarget.providerId
            ? activeTarget
            : this.providers.resolveRuntimeTarget(
                storedProvider,
                { kind: 'configured', requestedModel: storedProvider.model },
                framework
              )
        candidates.push(configured)
        candidates.push(...this.providers.resolveRuntimeModelCatalog(storedProvider, framework))
      } catch {
        // A stale provider remains a reconnect-only target until it resolves successfully.
      }
    }

    const seen = new Set<string>()
    return candidates.filter((candidate) => {
      const model = candidate.effectiveModel ?? candidate.provider.model
      const baseUrl =
        route === 'codex-bridge'
          ? openAiCompletionsBase(candidate.provider)
          : normalizeResponsesBaseUrl(
              candidate.provider.openaiBaseUrl ?? candidate.provider.baseUrl
            )
      const id = model ? providerTransportTargetId('codex', candidate.providerId, model) : undefined
      if (
        !candidate.frameworkCompatible ||
        !candidate.modelBridgeSupported ||
        modelRouteFor('codex', candidate) !== route ||
        !model ||
        !baseUrl ||
        !id ||
        seen.has(id)
      ) {
        return false
      }
      seen.add(id)
      return true
    })
  }

  private async ensureOpenCodeProviderTransports(
    settings: StoredSettings,
    activeTarget: ProviderRuntimeTarget,
    route: AgentModelRoute,
    effortIntent: ReasoningEffort
  ): Promise<OpenCodeProviderTransport | undefined> {
    const candidates = this.resolveOpenCodeApiTargets(settings, activeTarget, route)
    if (new Set(candidates.map((candidate) => candidate.providerId)).size < 2) return undefined

    const bridges: Array<AnthropicProviderBridgePort | OpenAiProviderBridgePort> = []
    const targetIds = new Set<string>()
    const catalog: AgentModelCatalogEntry[] = []
    let activeProvider: ProviderRuntimeTarget['provider'] | undefined

    try {
      for (const candidate of candidates) {
        const model = candidate.effectiveModel ?? candidate.provider.model
        if (!model) continue
        const targetId = providerTransportTargetId('opencode', candidate.providerId, model)
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
        const effort = resolvedModelEffort(effortIntent, candidate)
        catalog.push(
          Object.freeze({
            provider: localProvider,
            ...(effort === 'default' ? {} : { reasoningEffort: effort }),
            ...(candidate.reasoningEffortProfile.supported
              ? { reasoningEfforts: [...new Set(candidate.reasoningEffortProfile.slots)] }
              : {})
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
    candidates: readonly ProviderRuntimeTarget[]
  ): Promise<NativeCodexProviderTransport> {
    const targets = candidates.map((candidate): OpenAiProviderBridgeTarget => {
      const model = candidate.effectiveModel ?? candidate.provider.model
      const baseUrl = normalizeResponsesBaseUrl(
        candidate.provider.openaiBaseUrl ?? candidate.provider.baseUrl
      )
      if (!model || !baseUrl) throw new Error('The native Responses provider target is incomplete.')
      return Object.freeze({
        id: providerTransportTargetId('codex', candidate.providerId, model),
        wire: 'responses',
        endpoint: `${baseUrl}/responses`,
        ...(candidate.provider.key ? { key: candidate.provider.key } : {}),
        model
      })
    })
    const activeModel = activeTarget.effectiveModel ?? activeTarget.provider.model
    if (!activeModel) throw new Error('The active native Responses model is unavailable.')
    const initialTargetId = providerTransportTargetId('codex', activeTarget.providerId, activeModel)
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
    conversationSkillImportEnabled: boolean,
    providerTargets?: readonly ProviderRuntimeTarget[],
    effortIntent: ReasoningEffort = DEFAULT_REASONING_EFFORT
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
        namespacedTools: [
          ...CODEX_BRIDGE_NOTEBOOK_TOOLS,
          ...CODEX_BRIDGE_ARTIFACT_TOOLS,
          ...(conversationSkillImportEnabled ? CODEX_BRIDGE_SKILL_IMPORT_TOOLS : [])
        ],
        reviewerScope: { namespacedTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS }
      }
    }
    const targets = new Map<string, ResponsesBridgeTarget>()
    for (const candidate of providerTargets ?? []) {
      const model = candidate.effectiveModel ?? candidate.provider.model
      if (!model) continue
      const resolvedEffort = resolvedModelEffort(effortIntent, candidate)
      targets.set(
        providerTransportTargetId('codex', candidate.providerId, model),
        createTarget(candidate, resolvedEffort === 'default' ? undefined : resolvedEffort)
      )
    }
    const activeModel = activeTarget.effectiveModel ?? activeTarget.provider.model
    const initialTargetId = activeModel
      ? providerTransportTargetId('codex', activeTarget.providerId, activeModel)
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
    providerTargets?: readonly ProviderRuntimeTarget[]
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
        reviewerScope: { namespacedTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS }
      }
    }
    const targets = new Map<string, NativeResponsesProxyTarget>()
    for (const candidate of providerTargets ?? []) {
      const model = candidate.effectiveModel ?? candidate.provider.model
      if (!model) continue
      targets.set(
        providerTransportTargetId('codex', candidate.providerId, model),
        createTarget(candidate)
      )
    }
    const activeModel = activeTarget.effectiveModel ?? activeTarget.provider.model
    const initialTargetId = activeModel
      ? providerTransportTargetId('codex', activeTarget.providerId, activeModel)
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
