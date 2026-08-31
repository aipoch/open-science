import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { CodexSubscriptionTransport, ReasoningEffort } from '../../shared/settings'
import {
  DEFAULT_CONVERSATION_SKILL_IMPORT_ENABLED,
  DEFAULT_REASONING_EFFORT,
  isCodexSubscriptionProvider,
  usesAppProviderTransport
} from '../../shared/settings'
import {
  buildActiveModelIncompatibleMessage,
  CODEX_BRIDGE_UNSUPPORTED_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE
} from '../../shared/run-error-classification'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import {
  getAgentFramework,
  releaseResolvedAgentBackendLeases,
  type AgentModelChangeTarget,
  type AgentModelRoute,
  type AgentFrameworkId,
  type ResolvedAgentBackend
} from '../agent-framework'
import { codeBuddyStorageDir } from '../agent-framework/codebuddy'
import { opencodeConfigDir } from '../agent-framework/opencode'
import { codexStorageDir, codexSubscriptionStorageDir } from '../agent-framework/codex'
import { renderConnectorInstructions } from '../connectors/skill-doc'
import { OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION } from '../skills/runtime-mcp-server'
import { buildProviderEnv } from './provider-env'
import type { AgentRuntimeManager } from './agent-runtime-manager'
import type { ConnectorSettingsModule } from './connector-settings'
import {
  CLAUDE_SHARED_DISCONNECTED_MESSAGE,
  type ProviderAccountsModule,
  type ProviderRuntimeTarget,
  type RuntimeProviderModelSelection
} from './provider-accounts'
import { ensureCodexAuthHome, resolveEffectiveCodexSubscriptionTransport } from './codex-auth'
import type { StoredSettings } from './types'
import type { ClaudeRuntimeModelConfig } from './claude-config-provision'
import {
  BackendSelectionOwner,
  type AgentBackendSelection,
  type BackendSelectionResolution,
  type ExplicitAgentBackendTarget
} from './backend-selection-owner'
import { BackendRoutePlanner } from './backend-route-planner'
import {
  ProviderTransportOwner,
  type ProviderTransportOwnerOptions
} from './provider-transport-owner'

export type { AgentBackendSelection, ExplicitAgentBackendTarget } from './backend-selection-owner'

export type AdmittedAgentBackendTarget = ExplicitAgentBackendTarget &
  Readonly<{
    expectedBackendId: string
    expectedModelRoute: AgentModelRoute
  }>

export type AgentBackendResolutionContext = {
  forcedSkillIds?: string[]
  systemPromptAppends?: string[]
  includeSkillAndConnectorContext?: boolean
  forceCodexNativeResponsesCompatibility?: boolean
}

const userSkillDirectorySystemPromptAppend = (storageRoot: string): string =>
  [
    '<open_science_user_skill_directories>',
    `When the user explicitly asks you to author a new Skill, write its complete \`<name>/SKILL.md\` package under \`${join(storageRoot, 'skills', 'personal')}\`.`,
    `Externally obtained Skill packages that the user or application has directly copied are discovered under \`${join(storageRoot, 'skills', 'imported')}\`. This path is informational; do not download, unpack, or copy an external Skill there yourself.`,
    'For a GitHub URL, eligible attachment, Skill name or keywords, or any source requiring preview or confirmation, use `request_skill_import` when it is available; otherwise direct the user to the application import flow.',
    'Use a stable name of 1–64 lowercase letters or numbers separated by single hyphens.',
    'Changes in either directory are discovered automatically.',
    '</open_science_user_skill_directories>'
  ].join('\n')

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
  | 'resolveCodeBuddyExecutable'
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

export type AgentBackendConnectorPort = Pick<ConnectorSettingsModule, 'connectorSkillNames'>

export type AgentBackendResolverOptions = ProviderTransportOwnerOptions & {
  readSettings: () => Promise<StoredSettings>
  providers: AgentBackendProviderPort
  runtime: AgentBackendRuntimePort
  connectors: AgentBackendConnectorPort
  storageRoot: string
  userClaudeDir: string
  skillRuntimeMcpEntryPath: string
  readFrameworkOverride?: () => string | undefined
  ensureCodexSubscriptionHome?: (transport: CodexSubscriptionTransport) => Promise<void>
}

// Coordinates stable backend decisions while ProviderTransportOwner owns every live generation.
// The constructor is intentionally side-effect free; runtime resources start only inside resolve calls.
export class AgentBackendResolver {
  private readonly readSettings: () => Promise<StoredSettings>
  private readonly providers: AgentBackendProviderPort
  private readonly runtime: AgentBackendRuntimePort
  private readonly connectors: AgentBackendConnectorPort
  private readonly storageRoot: string
  private readonly userClaudeDir: string
  private readonly skillRuntimeMcpEntryPath: string
  private readonly selection: BackendSelectionOwner
  private readonly planner: BackendRoutePlanner
  private readonly transports: ProviderTransportOwner
  private readonly ensureCodexSubscriptionHome: (
    transport: CodexSubscriptionTransport
  ) => Promise<void>

  constructor(options: AgentBackendResolverOptions) {
    this.readSettings = options.readSettings
    this.providers = options.providers
    this.runtime = options.runtime
    this.connectors = options.connectors
    this.storageRoot = options.storageRoot
    this.userClaudeDir = options.userClaudeDir
    this.skillRuntimeMcpEntryPath = options.skillRuntimeMcpEntryPath
    this.selection = new BackendSelectionOwner({
      readSettings: this.readSettings,
      readFrameworkOverride:
        options.readFrameworkOverride ?? (() => process.env.OPEN_SCIENCE_AGENT_FRAMEWORK),
      resolveRuntimeReasoningEffortProfile: (provider, model) =>
        this.providers.resolveRuntimeReasoningEffortProfile(provider, model)
    })
    this.planner = new BackendRoutePlanner({ providers: this.providers })
    this.transports = new ProviderTransportOwner(options)
    this.ensureCodexSubscriptionHome =
      options.ensureCodexSubscriptionHome ??
      ((transport) => ensureCodexAuthHome('isolated', this.storageRoot, transport))
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
      plan.claudeModelConfig,
      context.includeSkillAndConnectorContext !== false
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

  async resolveAdmittedTarget(
    target: AdmittedAgentBackendTarget,
    context: AgentBackendResolutionContext = {}
  ): Promise<ResolvedAgentBackend> {
    const backend = await this.resolveExplicitTarget(target, context)
    if (
      backend.framework.id === target.frameworkId &&
      backend.backendId === target.expectedBackendId &&
      backend.modelRoute === target.expectedModelRoute
    ) {
      return backend
    }
    await releaseResolvedAgentBackendLeases(backend)
    throw new Error('The configured Subagent backend route changed since admission.')
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
      context,
      selection.resolvedReasoningEffort
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
    context: AgentBackendResolutionContext,
    resolvedEffort?: ResolvedReasoningEffort
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
    const includeSkillAndConnectorContext = context.includeSkillAndConnectorContext !== false
    const codeBuddySkillRuntimeRoot = join(codeBuddyStorageDir(this.storageRoot), 'skill-runtime')
    const userSkillDirectoryGuidance =
      includeSkillAndConnectorContext && framework.supportsSkills
        ? userSkillDirectorySystemPromptAppend(this.storageRoot)
        : undefined
    let connectorInstructions =
      includeSkillAndConnectorContext && framework.id === 'claude-code'
        ? renderConnectorInstructions(this.connectors.connectorSkillNames(settings.connectors))
        : ''
    const executablePath =
      framework.id === 'claude-code'
        ? await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath)
        : framework.id === 'codex'
          ? await this.runtime.resolveCodexExecutable(
              settings.codex?.resolvedPath,
              settings.codex?.nativePath
            )
          : framework.id === 'codebuddy'
            ? await this.runtime.resolveCodeBuddyExecutable(settings.codebuddyPath)
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
      resolvedEffort,
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
        plan.claudeModelConfig,
        includeSkillAndConnectorContext
      )
      const transport = await this.transports.acquire({ activeTarget: target, plan })
      return {
        framework,
        providerId: target.providerId,
        backendId: `${framework.id}:${target.providerId}`,
        modelRoute,
        executablePath: claudeExecutablePath,
        env: { ...envOverrides, ...(transport.environment ?? {}) },
        sessionOptions,
        sessionEffort,
        contextWindow,
        ...(target.provider.supportsImageInput ? { supportsImageInput: true } : {}),
        contextUsageModel: target.effectiveModel,
        providerConfiguration: transport.providerConfiguration,
        systemPromptAppends: [userSkillDirectoryGuidance, connectorInstructions].filter(
          (append): append is string => Boolean(append)
        ),
        ...(transport.anthropicBridgeLease
          ? { anthropicBridgeLease: transport.anthropicBridgeLease }
          : {})
      }
    }

    if (framework.id === 'codex' && isCodexSubscriptionProvider(target.provider.type)) {
      await this.ensureCodexSubscriptionHome(
        resolveEffectiveCodexSubscriptionTransport(target.provider)
      )
    }
    const backendProviderId = plan.backendProviderId
    if (framework.supportsSkills || framework.id === 'codebuddy') {
      const skillsRoot =
        framework.id === 'codebuddy'
          ? join(codeBuddySkillRuntimeRoot, '.claude')
          : framework.id === 'codex'
            ? isCodexSubscriptionProvider(target.provider.type)
              ? codexSubscriptionStorageDir(this.storageRoot)
              : codexStorageDir(this.storageRoot)
            : opencodeConfigDir(this.storageRoot)
      const materializedConnectorSkillNames = includeSkillAndConnectorContext
        ? await this.runtime.materializeAgentSkills(
            settings,
            skillsRoot,
            forcedSkillIds,
            ...(framework.id === 'codebuddy' ? [{ directoryLayout: 'agent-facing' as const }] : [])
          )
        : []
      connectorInstructions = includeSkillAndConnectorContext
        ? renderConnectorInstructions(materializedConnectorSkillNames)
        : ''
    } else if (includeSkillAndConnectorContext) {
      connectorInstructions = renderConnectorInstructions(
        this.connectors.connectorSkillNames(settings.connectors)
      )
    }

    const transport = await this.transports.acquire({ activeTarget: target, plan })
    const provider = transport.provider ?? target.provider
    const providerModelCatalog = transport.providerModelCatalog ?? plan.providerModelCatalog
    const responsesBridge = transport.responsesBridge
    const persistentSystemPromptAppends = [
      ...(context.systemPromptAppends ?? []),
      ...(userSkillDirectoryGuidance ? [userSkillDirectoryGuidance] : []),
      ...(framework.id !== 'opencode' && connectorInstructions ? [connectorInstructions] : [])
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
      const sessionModel = modelConfig.sessionModel ?? provider.model

      return {
        framework,
        providerId: target.providerId,
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
          ...(transport.environment ?? {}),
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
        ...(framework.id === 'codebuddy' && includeSkillAndConnectorContext
          ? {
              sessionOptions: {
                [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
                  command: process.execPath,
                  entryPath: this.skillRuntimeMcpEntryPath,
                  root: codeBuddySkillRuntimeRoot
                }
              }
            }
          : {}),
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
        providerTransportLease: transport.providerTransportLease
      }
    } catch (error) {
      await transport.release()
      throw error
    }
  }

  private async resolveClaudeSpawnConfig(
    settings: StoredSettings,
    target: ProviderRuntimeTarget,
    forcedSkillIds: ReadonlySet<string>,
    resolvedExecutablePath?: string,
    modelConfig?: ClaudeRuntimeModelConfig,
    includeSkillAndConnectorContext = true
  ): Promise<AgentSpawnConfig> {
    const executablePath =
      resolvedExecutablePath ??
      (await this.runtime.resolveClaudeExecutable(settings.claude?.resolvedPath))
    if (target.providerType === 'claude-shared' && target.disconnectedAt !== undefined) {
      throw new Error(CLAUDE_SHARED_DISCONNECTED_MESSAGE)
    }
    const provider = target.provider
    const runtimeConfig = await this.runtime.provisionClaudeRuntimeConfig(
      settings,
      forcedSkillIds,
      modelConfig ?? null,
      includeSkillAndConnectorContext
    )
    const envOverrides = buildProviderEnv(provider, {
      storageRoot: this.storageRoot,
      claudeExecutablePath: executablePath,
      userClaudeConfigDir: this.userClaudeDir
    })
    const skillProjectionOptions = {
      // The additional directory makes the immutable Skill package and its supporting files
      // readable without enabling the workspace `project` settings source. Session presentation
      // grants primary Agents a scoped loader that preserves the native `Skill` call shape.
      additionalDirectories: [runtimeConfig.skillProjection.root],
      sandbox: {
        filesystem: {
          allowRead: [runtimeConfig.skillProjection.root],
          denyWrite: [runtimeConfig.skillProjection.root]
        }
      },
      [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
        command: process.execPath,
        entryPath: this.skillRuntimeMcpEntryPath,
        root: runtimeConfig.skillProjection.root
      }
    }
    const sessionOptions =
      target.providerType === 'claude-shared'
        ? {
            // The SDK rejects a settings file path combined with a session sandbox. Pass the exact
            // app-owned settings snapshot instead; settingsPath remains the CLI probe seam.
            settings: runtimeConfig.privateSettings,
            ...skillProjectionOptions
          }
        : usesAppProviderTransport(provider.type)
          ? {
              settings: {
                skipWebFetchPreflight: true,
                permissions: { ask: ['WebFetch'] },
                ...(modelConfig ?? {})
              },
              ...skillProjectionOptions
            }
          : skillProjectionOptions

    return {
      envOverrides,
      executablePath,
      sessionOptions,
      contextWindow: provider.contextWindow
    }
  }
}
