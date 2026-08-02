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
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import { opencodeConfigDir } from '../agent-framework/opencode'
import {
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
import { openAiCompletionsBase } from './base-url'
import { buildProviderEnv } from './provider-env'
import {
  ResponsesBridge,
  type ResponsesBridgeConnection,
  type ResponsesBridgeNamespacedTool,
  type ResponsesBridgeTarget
} from './responses-bridge'
import { NativeResponsesCompatibilityProxy } from './native-responses-compatibility'
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

export type AgentBackendSelection = Readonly<{
  frameworkId: AgentFrameworkId
}>

export type AgentBackendResolutionContext = {
  forcedSkillIds?: string[]
  systemPromptAppends?: string[]
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
  'resolveRuntimeTarget' | 'resolveRuntimeReasoningEffortProfile'
>

export type AgentBackendConnectorPort = Pick<ConnectorSettingsModule, 'enabledConnectorIds'>

type BridgeBasePort = Pick<
  ResponsesBridge,
  'start' | 'close' | 'selectSkills' | 'registerReviewerSession' | 'unregisterReviewerSession'
>

type ResponsesBridgePort = BridgeBasePort & Pick<ResponsesBridge, 'setReasoningEffort'>
type NativeResponsesProxyPort = BridgeBasePort

type NativeResponsesProxyTarget = {
  baseUrl: string
  key?: string
  model?: string
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
}

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

  async captureConfiguredSelection(): Promise<AgentBackendSelection> {
    const settings = await this.readSettings()
    return { frameworkId: this.resolveConfiguredFrameworkId(settings) }
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

    const resolvedEffort =
      effortIntent === DEFAULT_REASONING_EFFORT
        ? DEFAULT_REASONING_EFFORT
        : resolveReasoningEffortValue(effortIntent, target.reasoningEffortProfile)
    const sessionEffort: ModelReasoningEffort | undefined =
      resolvedEffort === 'default' ? undefined : resolvedEffort
    const supportedReasoningEfforts = target.reasoningEffortProfile.supported
      ? [...new Set(target.reasoningEffortProfile.slots)]
      : undefined
    const forcedSkillIds = new Set(context.forcedSkillIds ?? [])
    const connectorInstructions = renderConnectorInstructions(
      this.connectors.enabledConnectorIds(settings.connectors)
    )

    if (framework.id === 'claude-code') {
      const { envOverrides, executablePath, sessionOptions, contextWindow } =
        await this.resolveClaudeSpawnConfig(settings, target, forcedSkillIds)
      return {
        framework,
        backendId: `${framework.id}:${target.providerId}`,
        executablePath,
        env: envOverrides,
        sessionOptions,
        sessionEffort,
        contextWindow,
        contextUsageModel: target.effectiveModel,
        ...(connectorInstructions ? { systemPromptAppends: [connectorInstructions] } : {})
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
    const provider = target.provider
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

    const responsesBridge = target.needsChatResponsesBridge
      ? await this.ensureResponsesBridge(
          provider,
          sessionEffort,
          settings.conversationSkillImportEnabled ?? DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED
        )
      : target.needsNativeResponsesCompatibility
        ? await this.ensureNativeResponsesCompatibility(provider)
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
      const loopbackProxyBypass = responsesBridge
        ? loopbackProxyBypassEnvironment(process.env)
        : undefined
      const sessionModel = modelConfig.sessionModel ?? provider.model

      return {
        framework,
        backendId: `${framework.id}:${backendProviderId}`,
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
        responsesBridgeLease: responsesBridge?.lease
      }
    } catch (error) {
      await responsesBridge?.lease.release()
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
    const appConfigDir = await this.runtime.provisionClaudeRuntimeConfig(settings, forcedSkillIds)
    const provider = target.provider
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
                permissions: { ask: ['WebFetch'] }
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

  private async ensureResponsesBridge(
    provider: ProviderRuntimeTarget['provider'],
    reasoningEffort: ModelReasoningEffort | undefined,
    conversationSkillImportEnabled: boolean
  ): Promise<LeasedResponsesBridgeConnection> {
    const targetBaseUrl = openAiCompletionsBase(provider)
    if (!targetBaseUrl) throw new Error('The Chat Completions provider has no base URL.')
    const target: ResponsesBridgeTarget = {
      baseUrl: targetBaseUrl,
      key: provider.key,
      vendorId: provider.vendorId,
      reasoningEffortTransport: provider.reasoningEffortTransport,
      model: provider.model,
      reasoningEffort,
      namespacedTools: [
        ...CODEX_BRIDGE_NOTEBOOK_TOOLS,
        ...CODEX_BRIDGE_ARTIFACT_TOOLS,
        ...(conversationSkillImportEnabled ? CODEX_BRIDGE_SKILL_IMPORT_TOOLS : [])
      ],
      reviewerScope: { namespacedTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS }
    }
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
    return {
      ...connection,
      lease: {
        selectSkills: (text, catalog, signal) =>
          leasedEntry.bridge.selectSkills(text, catalog, signal),
        registerReviewerSession: (promptCacheKey) =>
          leasedEntry.bridge.registerReviewerSession(promptCacheKey),
        unregisterReviewerSession: (promptCacheKey) =>
          leasedEntry.bridge.unregisterReviewerSession(promptCacheKey),
        setReasoningEffort: (effort) => leasedEntry.bridge.setReasoningEffort(effort),
        release: async () => {
          if (released) return
          released = true
          if (this.responsesBridges.get(bridgeId) !== leasedEntry) return
          this.responsesBridges.delete(bridgeId)
          await leasedEntry.bridge.close()
        }
      }
    }
  }

  private async ensureNativeResponsesCompatibility(
    provider: ProviderRuntimeTarget['provider']
  ): Promise<LeasedResponsesBridgeConnection> {
    const targetBaseUrl = normalizeResponsesBaseUrl(provider.openaiBaseUrl ?? provider.baseUrl)
    if (!targetBaseUrl) throw new Error('The native Responses provider has no base URL.')
    const proxyId = this.nextGenerationId()
    const proxy = this.createNativeResponsesProxy({
      baseUrl: targetBaseUrl,
      key: provider.key,
      model: provider.model,
      reviewerScope: { namespacedTools: REVIEWER_BRIDGE_NAMESPACED_TOOLS }
    })
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
    return {
      ...connection,
      lease: {
        selectSkills: (text, catalog, signal) =>
          leasedEntry.proxy.selectSkills(text, catalog, signal),
        registerReviewerSession: (promptCacheKey) =>
          leasedEntry.proxy.registerReviewerSession(promptCacheKey),
        unregisterReviewerSession: (promptCacheKey) =>
          leasedEntry.proxy.unregisterReviewerSession(promptCacheKey),
        release: async () => {
          if (released) return
          released = true
          if (this.nativeResponsesCompatibilityProxies.get(proxyId) !== leasedEntry) return
          this.nativeResponsesCompatibilityProxies.delete(proxyId)
          await leasedEntry.proxy.close()
        }
      }
    }
  }
}
