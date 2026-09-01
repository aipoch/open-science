import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import type { AgentConfigFile, AgentFrameworkId } from '../agent-framework'
import { opencodeTransportProviderId } from '../agent-framework/opencode'
import { SKILL_IMPORT_SYSTEM_PROMPT_APPEND } from '../skills/mcp-server'
import { OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION } from '../skills/runtime-mcp-server'
import type { ResolvedProvider } from './provider-env'
import type { ProviderRuntimeTarget, RuntimeProviderModelSelection } from './provider-accounts'
import type { StoredProvider, StoredSettings } from './types'
import {
  AgentBackendResolver,
  type AgentBackendConnectorPort,
  type AgentBackendProviderPort,
  type AgentBackendResolverOptions,
  type AgentBackendRuntimePort
} from './backend-resolver'

type ResponsesBridgeFactory = NonNullable<AgentBackendResolverOptions['createResponsesBridge']>
type ResponsesBridgeDouble = ReturnType<ResponsesBridgeFactory>
type NativeResponsesProxyFactory = NonNullable<
  AgentBackendResolverOptions['createNativeResponsesProxy']
>
type NativeResponsesProxyDouble = ReturnType<NativeResponsesProxyFactory>
type AnthropicProviderBridgeFactory = NonNullable<
  AgentBackendResolverOptions['createAnthropicProviderBridge']
>
type AnthropicProviderBridgeDouble = ReturnType<AnthropicProviderBridgeFactory>
type OpenAiProviderBridgeFactory = NonNullable<
  AgentBackendResolverOptions['createOpenAiProviderBridge']
>
type OpenAiProviderBridgeDouble = ReturnType<OpenAiProviderBridgeFactory>
type ResolveRuntimeTarget = AgentBackendProviderPort['resolveRuntimeTarget']
type ResolveRuntimeModelCatalog = AgentBackendProviderPort['resolveRuntimeModelCatalog']
type TargetOverride = Omit<Partial<ProviderRuntimeTarget>, 'provider'> & {
  provider?: Partial<ResolvedProvider>
}

const makeStoredProvider = (
  id: string,
  model = `${id}-default`,
  keyRef = `${id}-key-ref`
): StoredProvider => ({
  id,
  type: 'custom',
  name: id,
  apiEndpoints: ['anthropic', 'openai', 'responses'],
  baseUrl: 'https://gateway.example/v1',
  model,
  keyRef
})

const makeSettings = (overrides: Partial<StoredSettings> = {}): StoredSettings => {
  const provider = makeStoredProvider('provider-a', 'model-a')
  return {
    version: SETTINGS_FILE_VERSION,
    providers: [provider],
    activeProviderId: provider.id,
    activeModel: provider.model,
    agentFrameworkId: 'claude-code',
    reasoningEffort: 'high',
    ...overrides
  }
}

const effectiveModelFor = (
  provider: StoredProvider,
  selection: RuntimeProviderModelSelection
): string => {
  if (selection.kind === 'required') return selection.model
  if (selection.kind === 'configured' && selection.requestedModel) {
    return selection.requestedModel
  }
  return provider.model ?? 'provider-default-model'
}

const makeResponsesBridgeDouble = (
  options: {
    startError?: Error
    closeError?: Error
  } = {}
): ResponsesBridgeDouble => ({
  start: vi.fn(async () => {
    if (options.startError) throw options.startError
    return { baseUrl: 'http://127.0.0.1:41001/v1', token: 'bridge-token' }
  }),
  close: vi.fn(async () => {
    if (options.closeError) throw options.closeError
  }),
  selectSkills: vi.fn(async () => []),
  registerReviewerSession: vi.fn(),
  unregisterReviewerSession: vi.fn(() => false),
  registerToolLessSession: vi.fn(),
  unregisterToolLessSession: vi.fn(() => false),
  registerHostMessageSession: vi.fn(),
  unregisterHostMessageSession: vi.fn(() => false),
  setTarget: vi.fn(),
  setReasoningEffort: vi.fn(),
  setModelTarget: vi.fn()
})

const makeNativeResponsesProxyDouble = (
  options: {
    startError?: Error
    closeError?: Error
  } = {}
): NativeResponsesProxyDouble => ({
  start: vi.fn(async () => {
    if (options.startError) throw options.startError
    return {
      baseUrl: 'http://127.0.0.1:41002/v1',
      token: 'proxy-token',
      kind: 'responses-compatibility' as const
    }
  }),
  close: vi.fn(async () => {
    if (options.closeError) throw options.closeError
  }),
  selectSkills: vi.fn(async () => []),
  registerReviewerSession: vi.fn(),
  unregisterReviewerSession: vi.fn(() => false),
  registerToolLessSession: vi.fn(),
  unregisterToolLessSession: vi.fn(() => false),
  registerHostMessageSession: vi.fn(),
  unregisterHostMessageSession: vi.fn(() => false),
  setTarget: vi.fn(),
  setModelTarget: vi.fn()
})

const makeAnthropicProviderBridgeDouble = (): AnthropicProviderBridgeDouble => ({
  start: vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:41003',
    token: 'anthropic-bridge-token'
  })),
  close: vi.fn(async () => undefined),
  setTarget: vi.fn(() => true),
  clearErrorReplay: vi.fn()
})

const makeOpenAiProviderBridgeDouble = (index: number): OpenAiProviderBridgeDouble => ({
  start: vi.fn(async () => ({
    baseUrl: `http://127.0.0.1:${42000 + index}`,
    token: `openai-bridge-token-${index}`
  })),
  close: vi.fn(async () => undefined),
  setTarget: vi.fn(() => true),
  clearErrorReplay: vi.fn()
})

type HarnessOptions = {
  settings?: StoredSettings
  frameworkOverride?: string
  connectorIds?: string[]
  connectorSkillNames?: string[]
  materializedConnectorSkillNames?: string[]
  rejectRequiredModels?: ReadonlySet<string>
  targetOverride?: (
    provider: StoredProvider,
    selection: RuntimeProviderModelSelection,
    frameworkId: AgentFrameworkId
  ) => TargetOverride
  responsesBridgeBuilder?: (index: number) => ResponsesBridgeDouble
  nativeResponsesProxyBuilder?: (index: number) => NativeResponsesProxyDouble
  anthropicProviderBridgeBuilder?: (index: number) => AnthropicProviderBridgeDouble
  openAiProviderBridgeBuilder?: (index: number) => OpenAiProviderBridgeDouble
  nextGenerationId?: () => string
  getXaiOAuthAccessToken?: (forceRefresh?: boolean) => Promise<string>
}

// The inferred return preserves each Vitest mock's concrete call signature for assertions below.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const makeHarness = (options: HarnessOptions = {}) => {
  let currentSettings = options.settings ?? makeSettings()
  const readSettings = vi.fn(async () => currentSettings)
  const readFrameworkOverride = vi.fn(() => options.frameworkOverride)
  const ensureCodexSubscriptionHome = vi.fn(async () => undefined)
  const nextGenerationId = vi.fn(options.nextGenerationId ?? (() => 'generation'))

  const resolveRuntimeTarget = vi.fn(
    (
      storedProvider: Parameters<ResolveRuntimeTarget>[0],
      selection: Parameters<ResolveRuntimeTarget>[1],
      framework: Parameters<ResolveRuntimeTarget>[2]
    ): ProviderRuntimeTarget => {
      if (selection.kind === 'required' && options.rejectRequiredModels?.has(selection.model)) {
        throw new Error(`required model unavailable: ${selection.model}`)
      }

      const effectiveModel = effectiveModelFor(storedProvider, selection)
      const provider: ResolvedProvider = {
        type: storedProvider.type,
        baseUrl: storedProvider.baseUrl ?? 'https://gateway.example/v1',
        openaiBaseUrl: storedProvider.baseUrl ?? 'https://gateway.example/v1',
        model: effectiveModel,
        contextWindow: 128_000,
        apiEndpoints: ['anthropic', 'openai', 'responses'],
        ...(storedProvider.keyRef ? { key: `plain:${storedProvider.keyRef}` } : {})
      }
      const override = options.targetOverride?.(storedProvider, selection, framework.id)
      const { provider: providerOverride, ...targetOverride } = override ?? {}
      return {
        providerId: storedProvider.id,
        providerType: storedProvider.type,
        effectiveModel,
        apiEndpoints: ['anthropic', 'openai', 'responses'],
        provider: { ...provider, ...providerOverride },
        reasoningEffortProfile: {
          supported: true,
          slots: ['low', 'medium', 'high', 'xhigh', 'max']
        },
        frameworkCompatible: true,
        modelBridgeSupported: true,
        needsChatResponsesBridge: false,
        needsNativeResponsesCompatibility: false,
        ...targetOverride
      }
    }
  )
  const resolveRuntimeReasoningEffortProfile = vi.fn(() => ({
    supported: true as const,
    slots: ['low', 'medium', 'high', 'xhigh', 'max'] as const
  }))
  const resolveRuntimeModelCatalog = vi.fn(
    (
      storedProvider: Parameters<ResolveRuntimeModelCatalog>[0],
      framework: Parameters<ResolveRuntimeModelCatalog>[1]
    ): ProviderRuntimeTarget[] => {
      void storedProvider
      void framework
      return []
    }
  )
  const providers: AgentBackendProviderPort = {
    resolveRuntimeTarget,
    resolveRuntimeModelCatalog,
    resolveRuntimeReasoningEffortProfile
  }

  const runtime = {
    resolveClaudeExecutable: vi.fn(async () => '/runtime/claude'),
    resolveOpencodeExecutable: vi.fn(async () => '/runtime/opencode'),
    resolveCodeBuddyExecutable: vi.fn(async () => '/runtime/codebuddy'),
    resolveCodexExecutable: vi.fn(async () => '/runtime/codex-acp'),
    probeCodexNativeVersion: vi.fn(async () => '0.144.6'),
    provisionClaudeRuntimeConfig: vi.fn(async () => ({
      privateProfileDir: '/storage/claude-private',
      settingsPath: '/storage/claude-private/settings.json',
      privateSettings: {
        disableBundledSkills: true,
        permissions: { deny: ['Read(//storage/claude-private/**)'] }
      },
      skillProjection: {
        root: '/storage/runtime-support/agent-skills/claude/v1/revision-1',
        revision: 'revision-1'
      }
    })),
    materializeAgentSkills: vi.fn(
      async () =>
        options.materializedConnectorSkillNames ??
        options.connectorSkillNames ??
        (options.connectorIds ?? []).map((id) => `mcp-${id}`)
    ),
    materializeAgentConfigFiles: vi.fn(async (files?: AgentConfigFile[]) => {
      void files
    }),
    reserveOpenCodeUsagePort: vi.fn(async () => 42_424),
    resolveCodexProxyEnvironment: vi.fn(async () => undefined)
  } satisfies AgentBackendRuntimePort
  const connectors = {
    connectorSkillNames: vi.fn(
      () => options.connectorSkillNames ?? (options.connectorIds ?? []).map((id) => `mcp-${id}`)
    )
  } satisfies AgentBackendConnectorPort

  const responsesBridges: ResponsesBridgeDouble[] = []
  const createResponsesBridge = vi.fn((): ResponsesBridgeDouble => {
    const bridge =
      options.responsesBridgeBuilder?.(responsesBridges.length) ?? makeResponsesBridgeDouble()
    responsesBridges.push(bridge)
    return bridge
  })
  const nativeResponsesProxies: NativeResponsesProxyDouble[] = []
  const createNativeResponsesProxy = vi.fn((): NativeResponsesProxyDouble => {
    const proxy =
      options.nativeResponsesProxyBuilder?.(nativeResponsesProxies.length) ??
      makeNativeResponsesProxyDouble()
    nativeResponsesProxies.push(proxy)
    return proxy
  })
  const anthropicProviderBridges: AnthropicProviderBridgeDouble[] = []
  const createAnthropicProviderBridge = vi.fn((): AnthropicProviderBridgeDouble => {
    const bridge =
      options.anthropicProviderBridgeBuilder?.(anthropicProviderBridges.length) ??
      makeAnthropicProviderBridgeDouble()
    anthropicProviderBridges.push(bridge)
    return bridge
  })
  const openAiProviderBridges: OpenAiProviderBridgeDouble[] = []
  const createOpenAiProviderBridge = vi.fn((): OpenAiProviderBridgeDouble => {
    const bridge =
      options.openAiProviderBridgeBuilder?.(openAiProviderBridges.length) ??
      makeOpenAiProviderBridgeDouble(openAiProviderBridges.length)
    openAiProviderBridges.push(bridge)
    return bridge
  })

  const resolver = new AgentBackendResolver({
    readSettings,
    providers,
    runtime,
    connectors,
    storageRoot: '/storage',
    userClaudeDir: '/user/.claude',
    skillRuntimeMcpEntryPath: '/app/main.js',
    readFrameworkOverride,
    createResponsesBridge,
    createNativeResponsesProxy,
    createAnthropicProviderBridge,
    createOpenAiProviderBridge,
    ensureCodexSubscriptionHome,
    nextGenerationId,
    ...(options.getXaiOAuthAccessToken
      ? { getXaiOAuthAccessToken: options.getXaiOAuthAccessToken }
      : {})
  })

  return {
    resolver,
    readSettings,
    readFrameworkOverride,
    ensureCodexSubscriptionHome,
    nextGenerationId,
    resolveRuntimeTarget,
    resolveRuntimeModelCatalog,
    resolveRuntimeReasoningEffortProfile,
    runtime,
    connectors,
    createResponsesBridge,
    createNativeResponsesProxy,
    createAnthropicProviderBridge,
    createOpenAiProviderBridge,
    responsesBridges,
    nativeResponsesProxies,
    anthropicProviderBridges,
    openAiProviderBridges,
    getSettings: () => currentSettings,
    setSettings: (settings: StoredSettings) => {
      currentSettings = settings
    }
  }
}

const expectRuntimeNotStarted = (runtime: ReturnType<typeof makeHarness>['runtime']): void => {
  expect(runtime.resolveClaudeExecutable).not.toHaveBeenCalled()
  expect(runtime.resolveOpencodeExecutable).not.toHaveBeenCalled()
  expect(runtime.resolveCodexExecutable).not.toHaveBeenCalled()
  expect(runtime.probeCodexNativeVersion).not.toHaveBeenCalled()
  expect(runtime.provisionClaudeRuntimeConfig).not.toHaveBeenCalled()
  expect(runtime.materializeAgentSkills).not.toHaveBeenCalled()
  expect(runtime.materializeAgentConfigFiles).not.toHaveBeenCalled()
  expect(runtime.reserveOpenCodeUsagePort).not.toHaveBeenCalled()
  expect(runtime.resolveCodexProxyEnvironment).not.toHaveBeenCalled()
}

describe('AgentBackendResolver construction and selection', () => {
  it('constructs without side effects and captures a secret-free framework selection', async () => {
    const harness = makeHarness({
      settings: makeSettings({ agentFrameworkId: 'codex' })
    })

    expect(harness.readSettings).not.toHaveBeenCalled()
    expect(harness.readFrameworkOverride).not.toHaveBeenCalled()
    expect(harness.resolveRuntimeTarget).not.toHaveBeenCalled()
    expect(harness.resolveRuntimeReasoningEffortProfile).not.toHaveBeenCalled()
    expect(harness.connectors.connectorSkillNames).not.toHaveBeenCalled()
    expect(harness.createResponsesBridge).not.toHaveBeenCalled()
    expect(harness.createNativeResponsesProxy).not.toHaveBeenCalled()
    expect(harness.createAnthropicProviderBridge).not.toHaveBeenCalled()
    expect(harness.ensureCodexSubscriptionHome).not.toHaveBeenCalled()
    expect(harness.nextGenerationId).not.toHaveBeenCalled()
    expectRuntimeNotStarted(harness.runtime)

    const selection = await harness.resolver.captureConfiguredSelection()

    expect(selection).toEqual({ frameworkId: 'codex' })
    expect(Object.keys(selection)).toEqual(['frameworkId'])
    expect(JSON.stringify(selection)).not.toContain('key')
    expect(harness.resolveRuntimeTarget).not.toHaveBeenCalled()
    expect(harness.resolveRuntimeReasoningEffortProfile).not.toHaveBeenCalled()
    expectRuntimeNotStarted(harness.runtime)
  })

  it('projects reasoning capability without resolving a secret-bearing runtime target', async () => {
    const harness = makeHarness()

    await expect(harness.resolver.resolveActiveReasoningEffort('max')).resolves.toBe('max')

    expect(harness.resolveRuntimeReasoningEffortProfile).toHaveBeenCalledWith(
      harness.getSettings().providers[0],
      'model-a'
    )
    expect(harness.resolveRuntimeTarget).not.toHaveBeenCalled()
    expectRuntimeNotStarted(harness.runtime)
  })
})

describe('AgentBackendResolver configured and explicit targets', () => {
  it('fails closed instead of rerouting an admitted backend after endpoint compatibility changes', async () => {
    let apiEndpoints: ProviderRuntimeTarget['apiEndpoints'] = ['openai']
    const harness = makeHarness({
      settings: makeSettings({ agentFrameworkId: 'opencode' }),
      targetOverride: () => ({
        apiEndpoints,
        provider: { apiEndpoints }
      })
    })
    const admitted = {
      frameworkId: 'opencode' as const,
      providerId: 'provider-a',
      model: { kind: 'required' as const, id: 'model-a' },
      reasoningEffort: 'default' as const,
      expectedBackendId: 'opencode:provider-a',
      expectedModelRoute: 'opencode-openai' as const
    }

    await expect(harness.resolver.resolveAdmittedTarget(admitted)).resolves.toMatchObject({
      backendId: 'opencode:provider-a',
      modelRoute: 'opencode-openai'
    })

    apiEndpoints = ['anthropic']
    await expect(harness.resolver.resolveAdmittedTarget(admitted)).rejects.toThrow(
      'changed since admission'
    )
  })

  it('captures the click-time provider, model, framework, and effort as one explicit target', async () => {
    const harness = makeHarness({
      settings: makeSettings({ agentFrameworkId: 'codex', reasoningEffort: 'max' })
    })

    await expect(harness.resolver.captureExplicitTarget()).resolves.toEqual({
      frameworkId: 'codex',
      providerId: 'provider-a',
      model: { kind: 'required', id: 'model-a' },
      reasoningEffort: 'max'
    })
    expect(harness.resolveRuntimeTarget).not.toHaveBeenCalled()
    expectRuntimeNotStarted(harness.runtime)
  })

  it('forces direct API-key Codex Responses through the existing compatibility proxy', async () => {
    const harness = makeHarness({
      settings: makeSettings({ agentFrameworkId: 'codex' }),
      targetOverride: () => ({
        apiEndpoints: ['responses'],
        needsChatResponsesBridge: false,
        needsNativeResponsesCompatibility: false,
        provider: { apiEndpoints: ['responses'] }
      })
    })

    const backend = await harness.resolver.resolveExplicitTarget(
      {
        frameworkId: 'codex',
        providerId: 'provider-a',
        model: { kind: 'required', id: 'model-a' },
        reasoningEffort: 'high'
      },
      { forceCodexNativeResponsesCompatibility: true }
    )

    expect(backend.modelRoute).toBe('codex-responses-compatibility')
    expect(harness.createNativeResponsesProxy).toHaveBeenCalledOnce()
    expect(harness.createResponsesBridge).not.toHaveBeenCalled()
    expect(backend.responsesBridgeLease).toBeDefined()
    await backend.responsesBridgeLease?.release()
  })

  it('fails closed for Codex subscription reconstruction before starting a runtime', async () => {
    const provider: StoredProvider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexAuthMode: 'isolated',
      name: 'Codex subscription',
      model: 'gpt-5.4'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [provider],
        activeProviderId: provider.id,
        activeModel: provider.model,
        agentFrameworkId: 'codex'
      }),
      targetOverride: () => ({
        apiEndpoints: ['responses'],
        provider: { apiEndpoints: ['responses'] }
      })
    })

    await expect(
      harness.resolver.resolveExplicitTarget(
        {
          frameworkId: 'codex',
          providerId: provider.id,
          model: { kind: 'required', id: 'gpt-5.4' },
          reasoningEffort: 'high'
        },
        { forceCodexNativeResponsesCompatibility: true }
      )
    ).rejects.toThrow('unavailable with Codex subscription authentication')
    expect(harness.createNativeResponsesProxy).not.toHaveBeenCalled()
    expectRuntimeNotStarted(harness.runtime)
  })

  it('keeps projecting learned HTTPS while the Codex subscription preference remains Auto', async () => {
    const provider: StoredProvider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexAuthMode: 'isolated',
      codexTransport: 'auto',
      codexAutoUseHttps: true,
      name: 'Codex subscription',
      model: 'gpt-5.4'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [provider],
        activeProviderId: provider.id,
        activeModel: provider.model,
        agentFrameworkId: 'codex'
      }),
      targetOverride: () => ({
        apiEndpoints: ['responses'],
        provider: {
          type: 'codex-isolated',
          codexAuthMode: 'isolated',
          codexTransport: 'auto',
          codexAutoUseHttps: true,
          apiEndpoints: ['responses']
        }
      })
    })

    await harness.resolver.resolveExplicitTarget({
      frameworkId: 'codex',
      providerId: provider.id,
      model: { kind: 'required', id: 'gpt-5.4' },
      reasoningEffort: 'high'
    })

    expect(harness.ensureCodexSubscriptionHome).toHaveBeenCalledWith('https')
  })

  it.each(['https', 'websocket'] as const)(
    'ignores automatic transport memory for the manual %s preference',
    async (codexTransport) => {
      const provider: StoredProvider = {
        id: 'builtin-codex-subscription',
        type: 'codex-isolated',
        codexAuthMode: 'isolated',
        codexTransport,
        codexAutoUseHttps: true,
        name: 'Codex subscription',
        model: 'gpt-5.4'
      }
      const harness = makeHarness({
        settings: makeSettings({
          providers: [provider],
          activeProviderId: provider.id,
          activeModel: provider.model,
          agentFrameworkId: 'codex'
        }),
        targetOverride: () => ({
          apiEndpoints: ['responses'],
          provider: {
            type: 'codex-isolated',
            codexAuthMode: 'isolated',
            codexTransport,
            codexAutoUseHttps: true,
            apiEndpoints: ['responses']
          }
        })
      })

      await harness.resolver.resolveExplicitTarget({
        frameworkId: 'codex',
        providerId: provider.id,
        model: { kind: 'required', id: 'gpt-5.4' },
        reasoningEffort: 'high'
      })

      expect(harness.ensureCodexSubscriptionHome).toHaveBeenCalledWith(codexTransport)
    }
  )

  it('registers third-party Claude model ids through canonical override lanes', async () => {
    const provider: StoredProvider = {
      ...makeStoredProvider('provider-a', 'third-party/model-a'),
      type: 'official',
      vendorId: 'deepseek',
      fetchedModels: ['third-party/model-a', 'third-party/model-b']
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [provider],
        activeProviderId: provider.id,
        activeModel: provider.model,
        agentFrameworkId: 'claude-code'
      }),
      targetOverride: () => ({
        apiEndpoints: ['anthropic'],
        provider: { type: 'custom', apiEndpoints: ['anthropic'], vendorId: 'deepseek' }
      })
    })
    harness.resolveRuntimeModelCatalog.mockImplementation((storedProvider, framework) =>
      ['third-party/model-a', 'third-party/model-b'].map((model) =>
        harness.resolveRuntimeTarget(storedProvider, { kind: 'required', model }, framework)
      )
    )

    const backend = await harness.resolver.resolveActiveBackend()
    const modelConfig = (backend.sessionOptions as { settings?: unknown })?.settings

    expect(modelConfig).toMatchObject({
      availableModels: ['third-party/model-a', 'third-party/model-b'],
      modelOverrides: {
        'third-party/model-a': 'third-party/model-a',
        'third-party/model-b': 'third-party/model-b'
      }
    })
    expect(harness.runtime.provisionClaudeRuntimeConfig).toHaveBeenCalledWith(
      harness.getSettings(),
      new Set(),
      {
        availableModels: ['third-party/model-a', 'third-party/model-b'],
        modelOverrides: {
          'third-party/model-a': 'third-party/model-a',
          'third-party/model-b': 'third-party/model-b'
        }
      },
      true
    )
    expect(JSON.stringify(modelConfig)).not.toContain('plain:key-a')
  })

  it('keeps Claude Code on a recognized alias while the xAI loopback pins grok-4.6', async () => {
    const provider: StoredProvider = {
      id: 'builtin-xai-subscription',
      type: 'xai-subscription',
      name: 'xAI (Grok) OAuth',
      apiEndpoints: ['anthropic', 'openai', 'responses'],
      model: 'grok-4.6'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [provider],
        activeProviderId: provider.id,
        activeModel: provider.model,
        agentFrameworkId: 'claude-code'
      }),
      getXaiOAuthAccessToken: vi.fn(async () => 'xai-access'),
      targetOverride: () => ({
        apiEndpoints: ['anthropic', 'openai', 'responses'],
        provider: {
          type: 'xai-subscription',
          vendorId: 'xai',
          apiEndpoints: ['anthropic', 'openai', 'responses'],
          model: 'grok-4.6',
          key: undefined
        }
      })
    })
    harness.resolveRuntimeModelCatalog.mockImplementation((storedProvider, framework) =>
      ['grok-4.6', 'grok-4.5'].map((model) =>
        harness.resolveRuntimeTarget(storedProvider, { kind: 'required', model }, framework)
      )
    )

    const backend = await harness.resolver.resolveActiveBackend()
    try {
      expect((backend.sessionOptions as { settings?: unknown })?.settings).toEqual({
        skipWebFetchPreflight: true,
        permissions: { ask: ['WebFetch'] }
      })
      expect(harness.runtime.provisionClaudeRuntimeConfig).toHaveBeenCalledWith(
        harness.getSettings(),
        new Set(),
        null,
        true
      )
      expect(backend.env).toMatchObject({
        ANTHROPIC_MODEL: 'sonnet',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable',
        ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/)
      })
      expect(backend.providerConfiguration).toEqual({
        providerId: 'main',
        apiType: 'anthropic',
        baseUrl: backend.env.ANTHROPIC_BASE_URL,
        headers: { 'x-api-key': backend.env.ANTHROPIC_AUTH_TOKEN }
      })
      expect(backend.env).not.toHaveProperty('ANTHROPIC_CUSTOM_MODEL_OPTION')
    } finally {
      await backend.anthropicBridgeLease?.release()
    }
  })

  it.each([
    {
      providerType: 'claude-shared' as const,
      expectedSettings: expect.objectContaining({
        disableBundledSkills: true,
        permissions: { deny: ['Read(//storage/claude-private/**)'] }
      })
    },
    { providerType: 'claude-isolated' as const, expectedSettings: undefined },
    {
      providerType: 'custom' as const,
      expectedSettings: expect.objectContaining({
        skipWebFetchPreflight: true,
        permissions: { ask: ['WebFetch'] }
      })
    }
  ])(
    'mounts the external canonical Skill projection read-only for $providerType Claude sessions',
    async ({ providerType, expectedSettings }) => {
      const provider: StoredProvider = {
        ...makeStoredProvider('claude-provider'),
        type: providerType
      }
      const harness = makeHarness({
        settings: makeSettings({
          providers: [provider],
          activeProviderId: provider.id,
          activeModel: provider.model
        })
      })

      const backend = await harness.resolver.resolveActiveBackend()
      const projectionRoot = '/storage/runtime-support/agent-skills/claude/v1/revision-1'

      expect(backend.sessionOptions).not.toHaveProperty('plugins')
      expect(backend.sessionOptions).toMatchObject({
        additionalDirectories: [projectionRoot],
        sandbox: {
          filesystem: {
            allowRead: [projectionRoot],
            denyWrite: [projectionRoot]
          }
        }
      })
      if (expectedSettings === undefined) {
        expect(backend.sessionOptions).not.toHaveProperty('settings')
      } else {
        expect(backend.sessionOptions).toHaveProperty('settings', expectedSettings)
      }
      expect(backend.sessionOptions).not.toHaveProperty('strictPluginOnlyCustomization')
    }
  )

  it('leaves application prompt appends to the Claude session presentation owner', async () => {
    const harness = makeHarness()

    const backend = await harness.resolver.resolveExplicitTarget(
      {
        frameworkId: 'claude-code',
        providerId: 'provider-a',
        model: { kind: 'required', id: 'model-a' },
        reasoningEffort: 'high'
      },
      { systemPromptAppends: ['Stable Open Science app guidance.'] }
    )

    expect(backend.systemPromptAppends?.join('\n')).toContain(
      join('/storage', 'skills', 'personal')
    )
    expect(backend.systemPromptAppends?.join('\n')).not.toContain(
      'Stable Open Science app guidance.'
    )
    await backend.anthropicBridgeLease?.release()
  })

  it('persists application guidance before user Skill directories for OpenCode', async () => {
    const harness = makeHarness()
    const applicationGuidance = 'Stable Open Science app guidance.'

    const backend = await harness.resolver.resolveExplicitTarget(
      {
        frameworkId: 'opencode',
        providerId: 'provider-a',
        model: { kind: 'required', id: 'model-a' },
        reasoningEffort: 'high'
      },
      { systemPromptAppends: [applicationGuidance] }
    )
    const instructions = backend.persistentSystemPrompt ?? ''

    expect(instructions.indexOf(applicationGuidance)).toBeGreaterThanOrEqual(0)
    expect(instructions.indexOf('<open_science_user_skill_directories>')).toBeGreaterThan(
      instructions.indexOf(applicationGuidance)
    )
    await backend.providerTransportLease?.release()
  })

  it.each([
    { name: 'Claude Code', frameworkId: 'claude-code' as const, target: {} },
    { name: 'OpenCode', frameworkId: 'opencode' as const, target: {} },
    {
      name: 'Codex Responses',
      frameworkId: 'codex' as const,
      target: { provider: { apiEndpoints: ['responses'] as const } }
    }
  ])('omits Skill and Connector context for a restricted $name backend', async (testCase) => {
    const harness = makeHarness({
      connectorIds: ['pubmed'],
      targetOverride: () => testCase.target
    })
    const restrictedPrompt = 'Restricted single-purpose prompt.'

    const backend = await harness.resolver.resolveExplicitTarget(
      {
        frameworkId: testCase.frameworkId,
        providerId: 'provider-a',
        model: { kind: 'provider-default' },
        reasoningEffort: 'high'
      },
      {
        systemPromptAppends: [restrictedPrompt],
        includeSkillAndConnectorContext: false
      }
    )
    const instructions =
      testCase.frameworkId === 'claude-code'
        ? backend.systemPromptAppends?.join('\n\n')
        : backend.persistentSystemPrompt

    if (testCase.frameworkId === 'claude-code') {
      expect(instructions).toBe('')
    } else {
      expect(instructions).toBe(restrictedPrompt)
    }
    expect(instructions).not.toContain('<open_science_user_skill_directories>')
    expect(instructions).not.toContain('# Open Science data connector conventions')
    expect(harness.runtime.materializeAgentSkills).not.toHaveBeenCalled()
    if (testCase.frameworkId === 'claude-code') {
      expect(harness.runtime.provisionClaudeRuntimeConfig).toHaveBeenCalledWith(
        harness.getSettings(),
        new Set(),
        expect.anything(),
        false
      )
    }
    await backend.anthropicBridgeLease?.release()
    await backend.responsesBridgeLease?.release()
    await backend.providerTransportLease?.release()
  })

  it('keeps a single Claude target behind loopback and projects its model target', async () => {
    const harness = makeHarness()
    const backend = await harness.resolver.resolveActiveBackend()

    expect(backend.anthropicBridgeLease).toBeDefined()
    expect(harness.createAnthropicProviderBridge).toHaveBeenCalledWith(
      [
        {
          id: JSON.stringify(['provider-a', 'model-a']),
          baseUrl: 'https://gateway.example',
          key: 'plain:provider-a-key-ref',
          model: 'model-a'
        }
      ],
      JSON.stringify(['provider-a', 'model-a'])
    )
    await expect(harness.resolver.resolveActiveModelChangeTarget()).resolves.toMatchObject({
      anthropicBridgeTargetId: JSON.stringify(['provider-a', 'model-a'])
    })
    await backend.anthropicBridgeLease?.release()
  })

  it('routes configured Claude API providers through one retargetable loopback generation', async () => {
    const deepseek = {
      ...makeStoredProvider('deepseek', 'deepseek-v4-pro'),
      baseUrl: 'https://api.deepseek.example'
    }
    const kimi = {
      ...makeStoredProvider('kimi', 'kimi-k3'),
      baseUrl: 'https://api.kimi.example'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [deepseek, kimi],
        activeProviderId: deepseek.id,
        activeModel: deepseek.model,
        agentFrameworkId: 'claude-code'
      }),
      targetOverride: (_provider, _selection, frameworkId) => ({
        apiEndpoints: frameworkId === 'claude-code' ? ['anthropic'] : ['openai'],
        provider: { apiEndpoints: ['anthropic'] }
      })
    })

    const backend = await harness.resolver.resolveActiveBackend()

    expect(harness.createAnthropicProviderBridge).toHaveBeenCalledWith(
      [
        {
          id: JSON.stringify(['deepseek', 'deepseek-v4-pro']),
          baseUrl: 'https://api.deepseek.example',
          key: 'plain:deepseek-key-ref',
          model: 'deepseek-v4-pro'
        },
        {
          id: JSON.stringify(['kimi', 'kimi-k3']),
          baseUrl: 'https://api.kimi.example',
          key: 'plain:kimi-key-ref',
          model: 'kimi-k3'
        }
      ],
      JSON.stringify(['deepseek', 'deepseek-v4-pro'])
    )
    expect(backend.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:41003',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-bridge-token'
    })
    expect(JSON.stringify(backend)).not.toContain('plain:deepseek-key-ref')
    expect(JSON.stringify(backend)).not.toContain('plain:kimi-key-ref')

    harness.setSettings({
      ...harness.getSettings(),
      activeProviderId: kimi.id,
      activeModel: kimi.model
    })
    await expect(harness.resolver.resolveActiveModelChangeTarget()).resolves.toMatchObject({
      backendId: 'claude-code:kimi',
      model: 'kimi-k3',
      anthropicBridgeTargetId: JSON.stringify(['kimi', 'kimi-k3'])
    })

    backend.anthropicBridgeLease?.setTarget(JSON.stringify(['kimi', 'kimi-k3']))
    expect(harness.anthropicProviderBridges[0].setTarget).toHaveBeenCalledWith(
      JSON.stringify(['kimi', 'kimi-k3'])
    )
    await backend.anthropicBridgeLease?.release()
    expect(harness.anthropicProviderBridges[0].close).toHaveBeenCalledOnce()
  })

  it('resolves a secret-free live model target without starting runtime resources', async () => {
    const harness = makeHarness({
      settings: makeSettings({ agentFrameworkId: 'codex', reasoningEffort: 'max' }),
      targetOverride: () => ({
        apiEndpoints: ['openai'],
        needsChatResponsesBridge: true,
        provider: {
          apiEndpoints: ['openai'],
          vendorId: 'deepseek',
          supportsImageInput: true,
          reasoningEffortTransport: 'deepseek'
        }
      })
    })

    const target = await harness.resolver.resolveActiveModelChangeTarget()

    expect(target).toEqual({
      frameworkId: 'codex',
      providerId: 'provider-a',
      backendId: 'codex:provider-a',
      route: 'codex-bridge',
      model: 'model-a',
      sessionModel: 'gpt-5.4',
      sessionModelRequired: false,
      supportsImageInput: true,
      reasoningEffort: 'max',
      contextWindow: 128_000,
      bridge: {
        model: 'model-a',
        vendorId: 'deepseek',
        reasoningEffortTransport: 'deepseek'
      }
    })
    expect(JSON.stringify(target)).not.toContain('plain:key-a')
    expect(harness.createResponsesBridge).not.toHaveBeenCalled()
    expectRuntimeNotStarted(harness.runtime)
  })

  it('distinguishes OpenCode endpoint routes so cross-route model changes reconnect', async () => {
    const harness = makeHarness({
      settings: makeSettings({ agentFrameworkId: 'opencode' }),
      targetOverride: () => ({
        apiEndpoints: ['openai'],
        provider: { apiEndpoints: ['openai'] }
      })
    })

    await expect(harness.resolver.resolveActiveModelChangeTarget()).resolves.toMatchObject({
      route: 'opencode-openai'
    })
  })

  it('pre-registers immutable OpenCode provider routes without exposing upstream credentials', async () => {
    const providerA = {
      ...makeStoredProvider('provider-a', 'model-a'),
      baseUrl: 'https://provider-a.example/v1'
    }
    const providerB = {
      ...makeStoredProvider('provider-b', 'model-b'),
      baseUrl: 'https://provider-b.example/custom'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [providerA, providerB],
        activeProviderId: providerA.id,
        activeModel: providerA.model,
        agentFrameworkId: 'opencode'
      }),
      targetOverride: () => ({
        apiEndpoints: ['openai'],
        provider: { apiEndpoints: ['openai'] }
      })
    })

    const backend = await harness.resolver.resolveActiveBackend()
    const providerAId = opencodeTransportProviderId(providerA.id, 'model-a')
    const providerBId = opencodeTransportProviderId(providerB.id, 'model-b')
    const configFiles = harness.runtime.materializeAgentConfigFiles.mock.calls[0]?.[0] ?? []
    const opencodeConfig = configFiles.find((file) => file.path.endsWith('opencode.json'))

    expect(harness.createOpenAiProviderBridge).toHaveBeenNthCalledWith(
      1,
      [
        {
          id: JSON.stringify(['opencode', 'provider-a', 'model-a']),
          wire: 'chat-completions',
          endpoint: 'https://provider-a.example/v1/chat/completions',
          key: 'plain:provider-a-key-ref',
          model: 'model-a'
        }
      ],
      JSON.stringify(['opencode', 'provider-a', 'model-a'])
    )
    expect(harness.createOpenAiProviderBridge).toHaveBeenNthCalledWith(
      2,
      [
        {
          id: JSON.stringify(['opencode', 'provider-b', 'model-b']),
          wire: 'chat-completions',
          endpoint: 'https://provider-b.example/custom/chat/completions',
          key: 'plain:provider-b-key-ref',
          model: 'model-b'
        }
      ],
      JSON.stringify(['opencode', 'provider-b', 'model-b'])
    )
    expect(backend.sessionModel).toBe(`${providerAId}/model-a`)
    expect(opencodeConfig?.content).toContain(providerAId)
    expect(opencodeConfig?.content).toContain(providerBId)
    expect(JSON.stringify(backend)).not.toContain('plain:provider-a-key-ref')
    expect(JSON.stringify(backend)).not.toContain('plain:provider-b-key-ref')
    expect(
      backend.providerTransportLease?.setTarget(
        JSON.stringify(['opencode', 'provider-b', 'model-b'])
      )
    ).toBe(true)

    harness.setSettings({
      ...harness.getSettings(),
      activeProviderId: providerB.id,
      activeModel: providerB.model
    })
    await expect(harness.resolver.resolveActiveModelChangeTarget()).resolves.toMatchObject({
      backendId: 'opencode:provider-b',
      route: 'opencode-openai',
      sessionModel: `${providerBId}/model-b`,
      providerTransportTargetId: JSON.stringify(['opencode', 'provider-b', 'model-b'])
    })

    await backend.providerTransportLease?.release()
    expect(harness.openAiProviderBridges[0].close).toHaveBeenCalledOnce()
    expect(harness.openAiProviderBridges[1].close).toHaveBeenCalledOnce()
  })

  it('pre-registers immutable Anthropic routes for OpenCode providers', async () => {
    const providerA = {
      ...makeStoredProvider('provider-a', 'model-a'),
      baseUrl: 'https://provider-a.example/anthropic'
    }
    const providerB = {
      ...makeStoredProvider('provider-b', 'model-b'),
      baseUrl: 'https://provider-b.example/anthropic'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [providerA, providerB],
        activeProviderId: providerA.id,
        activeModel: providerA.model,
        agentFrameworkId: 'opencode'
      }),
      targetOverride: () => ({
        apiEndpoints: ['anthropic'],
        provider: { apiEndpoints: ['anthropic'] }
      })
    })

    const backend = await harness.resolver.resolveActiveBackend()
    const providerATargetId = JSON.stringify(['opencode', 'provider-a', 'model-a'])
    const providerBTargetId = JSON.stringify(['opencode', 'provider-b', 'model-b'])

    expect(harness.createAnthropicProviderBridge).toHaveBeenNthCalledWith(
      1,
      [
        {
          id: providerATargetId,
          baseUrl: 'https://provider-a.example/anthropic',
          key: 'plain:provider-a-key-ref',
          model: 'model-a'
        }
      ],
      providerATargetId
    )
    expect(harness.createAnthropicProviderBridge).toHaveBeenNthCalledWith(
      2,
      [
        {
          id: providerBTargetId,
          baseUrl: 'https://provider-b.example/anthropic',
          key: 'plain:provider-b-key-ref',
          model: 'model-b'
        }
      ],
      providerBTargetId
    )
    expect(backend.providerTransportLease?.setTarget(providerBTargetId)).toBe(true)
    expect(JSON.stringify(backend)).not.toContain('plain:provider-a-key-ref')
    expect(JSON.stringify(backend)).not.toContain('plain:provider-b-key-ref')
  })

  it('retargets a Codex Chat bridge across pre-registered providers', async () => {
    const providerA = {
      ...makeStoredProvider('provider-a', 'model-a'),
      baseUrl: 'https://provider-a.example/v1'
    }
    const providerB = {
      ...makeStoredProvider('provider-b', 'model-b'),
      baseUrl: 'https://provider-b.example/custom'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [providerA, providerB],
        activeProviderId: providerA.id,
        activeModel: providerA.model,
        agentFrameworkId: 'codex'
      }),
      targetOverride: () => ({
        apiEndpoints: ['openai'],
        needsChatResponsesBridge: true,
        provider: { apiEndpoints: ['openai'] }
      })
    })

    const backend = await harness.resolver.resolveActiveBackend()
    const providerBTargetId = JSON.stringify(['codex', 'provider-b', 'model-b'])

    expect(backend.providerTransportLease?.setTarget(providerBTargetId)).toBe(true)
    expect(harness.responsesBridges[0].setTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://provider-b.example/custom',
        key: 'plain:provider-b-key-ref',
        model: 'model-b'
      })
    )

    harness.setSettings({
      ...harness.getSettings(),
      activeProviderId: providerB.id,
      activeModel: providerB.model
    })
    await expect(harness.resolver.resolveActiveModelChangeTarget()).resolves.toMatchObject({
      backendId: 'codex:provider-b',
      route: 'codex-bridge',
      providerTransportTargetId: providerBTargetId
    })
  })

  it('retargets Codex Responses compatibility across pre-registered providers', async () => {
    const providerA = {
      ...makeStoredProvider('provider-a', 'model-a'),
      baseUrl: 'https://provider-a.example/v1'
    }
    const providerB = {
      ...makeStoredProvider('provider-b', 'model-b'),
      baseUrl: 'https://provider-b.example/custom'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [providerA, providerB],
        activeProviderId: providerA.id,
        activeModel: providerA.model,
        agentFrameworkId: 'codex'
      }),
      targetOverride: () => ({
        apiEndpoints: ['responses'],
        needsNativeResponsesCompatibility: true,
        provider: { apiEndpoints: ['responses'] }
      })
    })

    const backend = await harness.resolver.resolveActiveBackend()
    const providerBTargetId = JSON.stringify(['codex', 'provider-b', 'model-b'])

    expect(backend.providerTransportLease?.setTarget(providerBTargetId)).toBe(true)
    expect(harness.nativeResponsesProxies[0].setTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://provider-b.example/custom',
        key: 'plain:provider-b-key-ref',
        model: 'model-b'
      })
    )
  })

  it('routes native Codex Responses providers through one retargetable loopback', async () => {
    const providerA = {
      ...makeStoredProvider('provider-a', 'model-a'),
      baseUrl: 'https://provider-a.example/v1'
    }
    const providerB = {
      ...makeStoredProvider('provider-b', 'model-b'),
      baseUrl: 'https://provider-b.example/custom'
    }
    const harness = makeHarness({
      settings: makeSettings({
        providers: [providerA, providerB],
        activeProviderId: providerA.id,
        activeModel: providerA.model,
        agentFrameworkId: 'codex'
      }),
      targetOverride: () => ({
        apiEndpoints: ['responses'],
        provider: { apiEndpoints: ['responses'], vendorId: 'openai' }
      })
    })

    const backend = await harness.resolver.resolveActiveBackend()
    const providerATargetId = JSON.stringify(['codex', 'provider-a', 'model-a'])
    const providerBTargetId = JSON.stringify(['codex', 'provider-b', 'model-b'])

    expect(harness.createOpenAiProviderBridge).toHaveBeenCalledWith(
      [
        {
          id: providerATargetId,
          wire: 'responses',
          endpoint: 'https://provider-a.example/v1/responses',
          key: 'plain:provider-a-key-ref',
          model: 'model-a'
        },
        {
          id: providerBTargetId,
          wire: 'responses',
          endpoint: 'https://provider-b.example/custom/responses',
          key: 'plain:provider-b-key-ref',
          model: 'model-b'
        }
      ],
      providerATargetId
    )
    expect(backend.authentication).toEqual({
      methodId: 'api-key',
      _meta: { 'api-key': { apiKey: 'openai-bridge-token-0' } }
    })
    expect(backend.providerTransportLease?.setTarget(providerBTargetId)).toBe(true)
    expect(harness.openAiProviderBridges[0].setTarget).toHaveBeenCalledWith(providerBTargetId)
    expect(JSON.stringify(backend)).not.toContain('plain:provider-a-key-ref')
    expect(JSON.stringify(backend)).not.toContain('plain:provider-b-key-ref')
  })

  it('produces equivalent stable backends for configured and provider-default explicit targets', async () => {
    const settings = makeSettings()
    const harness = makeHarness({ settings })

    const configured = await harness.resolver.resolveActiveBackend()
    const explicit = await harness.resolver.resolveExplicitTarget({
      frameworkId: 'claude-code',
      providerId: 'provider-a',
      model: { kind: 'provider-default' },
      reasoningEffort: 'high'
    })

    const { anthropicBridgeLease: configuredLease, ...configuredStable } = configured
    const { anthropicBridgeLease: explicitLease, ...explicitStable } = explicit
    expect(explicitStable).toEqual(configuredStable)
    expect(configuredLease).toBeDefined()
    expect(explicitLease).toBeDefined()
    expect(harness.resolveRuntimeTarget).toHaveBeenNthCalledWith(
      1,
      settings.providers[0],
      { kind: 'configured', requestedModel: 'model-a' },
      expect.objectContaining({ id: 'claude-code' })
    )
    expect(harness.resolveRuntimeTarget).toHaveBeenNthCalledWith(
      2,
      settings.providers[0],
      { kind: 'provider-default' },
      expect.objectContaining({ id: 'claude-code' })
    )
    await configuredLease?.release()
    await explicitLease?.release()
  })

  it('late-binds a configured selection but keeps an explicit target fixed', async () => {
    const providerA = makeStoredProvider('provider-a', 'model-a', 'key-a')
    const providerB = makeStoredProvider('provider-b', 'model-b', 'key-b')
    const harness = makeHarness({
      settings: makeSettings({
        providers: [providerA, providerB],
        activeProviderId: providerA.id,
        activeModel: providerA.model,
        agentFrameworkId: 'codex',
        reasoningEffort: 'high'
      })
    })
    const selection = await harness.resolver.captureConfiguredSelection()
    const rotatedProviderA = { ...providerA, keyRef: 'key-a-rotated' }
    harness.setSettings(
      makeSettings({
        providers: [rotatedProviderA, providerB],
        activeProviderId: providerB.id,
        activeModel: 'model-b-current',
        agentFrameworkId: 'claude-code',
        reasoningEffort: 'low'
      })
    )

    const lateBound = await harness.resolver.resolveSelection(selection)
    const fixed = await harness.resolver.resolveExplicitTarget({
      frameworkId: 'codex',
      providerId: providerA.id,
      model: { kind: 'required', id: 'model-a-fixed' },
      reasoningEffort: 'max'
    })

    expect(lateBound).toMatchObject({
      backendId: 'codex:provider-b',
      sessionModel: 'model-b-current',
      sessionEffort: 'low',
      authentication: {
        methodId: 'api-key',
        _meta: { 'api-key': { apiKey: 'openai-bridge-token-0' } }
      }
    })
    expect(fixed).toMatchObject({
      backendId: 'codex:provider-a',
      sessionModel: 'model-a-fixed',
      sessionEffort: 'max',
      authentication: {
        methodId: 'api-key',
        _meta: { 'api-key': { apiKey: 'openai-bridge-token-1' } }
      }
    })
    expect(JSON.stringify(lateBound)).not.toContain('plain:key-b')
    expect(JSON.stringify(fixed)).not.toContain('plain:key-a-rotated')
    expect(harness.resolveRuntimeTarget).toHaveBeenCalledWith(
      providerB,
      { kind: 'configured', requestedModel: 'model-b-current' },
      expect.objectContaining({ id: 'codex' })
    )
    expect(harness.resolveRuntimeTarget).toHaveBeenCalledWith(
      rotatedProviderA,
      { kind: 'required', model: 'model-a-fixed' },
      expect.objectContaining({ id: 'codex' })
    )
  })

  it('fails an unavailable required model before runtime work without mutating settings', async () => {
    const harness = makeHarness({ rejectRequiredModels: new Set(['missing-model']) })
    const before = structuredClone(harness.getSettings())

    await expect(
      harness.resolver.resolveExplicitTarget({
        frameworkId: 'codex',
        providerId: 'provider-a',
        model: { kind: 'required', id: 'missing-model' },
        reasoningEffort: 'high'
      })
    ).rejects.toThrow('required model unavailable: missing-model')

    expect(harness.getSettings()).toEqual(before)
    expect(harness.createResponsesBridge).not.toHaveBeenCalled()
    expect(harness.createNativeResponsesProxy).not.toHaveBeenCalled()
    expect(harness.nextGenerationId).not.toHaveBeenCalled()
    expectRuntimeNotStarted(harness.runtime)
  })

  it('ignores the configured framework override for an explicit target', async () => {
    const harness = makeHarness({ frameworkOverride: 'opencode' })

    const backend = await harness.resolver.resolveExplicitTarget({
      frameworkId: 'codex',
      providerId: 'provider-a',
      model: { kind: 'provider-default' },
      reasoningEffort: 'high'
    })

    expect(backend.framework.id).toBe('codex')
    expect(harness.readFrameworkOverride).not.toHaveBeenCalled()
  })
})

describe('AgentBackendResolver runtime delegation', () => {
  it('preserves legacy spawn-config error priority by resolving Claude before the provider', async () => {
    const harness = makeHarness({
      settings: makeSettings({ providers: [], activeProviderId: undefined })
    })
    const executableError = new Error('Claude executable is unavailable')
    harness.runtime.resolveClaudeExecutable.mockRejectedValueOnce(executableError)

    await expect(harness.resolver.resolveActiveSpawnConfig()).rejects.toBe(executableError)

    expect(harness.resolveRuntimeTarget).not.toHaveBeenCalled()
  })

  it.each(['opencode', 'codex'] as const)(
    'preserves %s executable error priority over route catalog projection',
    async (frameworkId) => {
      const harness = makeHarness()
      const executableError = new Error(`${frameworkId} executable is unavailable`)
      harness.resolveRuntimeModelCatalog.mockImplementation(() => {
        throw new Error('catalog projection failed')
      })
      if (frameworkId === 'codex') {
        harness.runtime.resolveCodexExecutable.mockRejectedValueOnce(executableError)
      } else {
        harness.runtime.resolveOpencodeExecutable.mockRejectedValueOnce(executableError)
      }

      await expect(
        harness.resolver.resolveExplicitTarget({
          frameworkId,
          providerId: 'provider-a',
          model: { kind: 'provider-default' },
          reasoningEffort: 'high'
        })
      ).rejects.toBe(executableError)
    }
  )

  it('preserves Codex native probe error priority over route catalog projection', async () => {
    const harness = makeHarness()
    const probeError = new Error('Codex native probe failed')
    harness.resolveRuntimeModelCatalog.mockImplementation(() => {
      throw new Error('catalog projection failed')
    })
    harness.runtime.probeCodexNativeVersion.mockRejectedValueOnce(probeError)

    await expect(
      harness.resolver.resolveExplicitTarget({
        frameworkId: 'codex',
        providerId: 'provider-a',
        model: { kind: 'provider-default' },
        reasoningEffort: 'high'
      })
    ).rejects.toBe(probeError)
  })

  it.each([
    { frameworkId: 'claude-code' as const, executableMethod: 'resolveClaudeExecutable' as const },
    { frameworkId: 'opencode' as const, executableMethod: 'resolveOpencodeExecutable' as const },
    { frameworkId: 'codex' as const, executableMethod: 'resolveCodexExecutable' as const }
  ])('delegates $frameworkId preparation through the S5a runtime port', async (testCase) => {
    const harness = makeHarness()

    const backend = await harness.resolver.resolveExplicitTarget(
      {
        frameworkId: testCase.frameworkId,
        providerId: 'provider-a',
        model: { kind: 'provider-default' },
        reasoningEffort: 'high'
      },
      { forcedSkillIds: ['forced-skill'] }
    )

    expect(backend.framework.id).toBe(testCase.frameworkId)
    expect(harness.runtime[testCase.executableMethod]).toHaveBeenCalledTimes(1)
    if (testCase.frameworkId === 'claude-code') {
      expect(harness.runtime.provisionClaudeRuntimeConfig).toHaveBeenCalledWith(
        harness.getSettings(),
        new Set(['forced-skill']),
        {
          availableModels: ['model-a'],
          modelOverrides: { 'model-a': 'model-a' }
        },
        true
      )
      expect(harness.runtime.materializeAgentSkills).not.toHaveBeenCalled()
      expect(harness.runtime.materializeAgentConfigFiles).not.toHaveBeenCalled()
    } else {
      expect(harness.runtime.materializeAgentSkills).toHaveBeenCalledWith(
        harness.getSettings(),
        expect.any(String),
        new Set(['forced-skill'])
      )
      expect(harness.runtime.materializeAgentConfigFiles).toHaveBeenCalledTimes(1)
    }
    expect(harness.runtime.reserveOpenCodeUsagePort).toHaveBeenCalledTimes(
      testCase.frameworkId === 'opencode' ? 1 : 0
    )
    expect(harness.runtime.probeCodexNativeVersion).toHaveBeenCalledTimes(
      testCase.frameworkId === 'codex' ? 1 : 0
    )
  })
})

describe('AgentBackendResolver bridge predicates', () => {
  it.each([
    { name: 'Claude Code', frameworkId: 'claude-code' as const, target: {} },
    { name: 'OpenCode', frameworkId: 'opencode' as const, target: {} },
    {
      name: 'Codex Responses',
      frameworkId: 'codex' as const,
      target: { provider: { apiEndpoints: ['responses'] as const } }
    },
    {
      name: 'Codex bridge',
      frameworkId: 'codex' as const,
      target: {
        needsChatResponsesBridge: true,
        provider: { apiEndpoints: ['openai'] as const }
      }
    }
  ])('provides the fixed Personal and Imported Skill paths to $name', async (testCase) => {
    const harness = makeHarness({ targetOverride: () => testCase.target })

    const backend = await harness.resolver.resolveExplicitTarget(
      {
        frameworkId: testCase.frameworkId,
        providerId: 'provider-a',
        model: { kind: 'provider-default' },
        reasoningEffort: 'high'
      },
      { systemPromptAppends: [SKILL_IMPORT_SYSTEM_PROMPT_APPEND] }
    )
    const instructions =
      testCase.frameworkId === 'claude-code'
        ? [SKILL_IMPORT_SYSTEM_PROMPT_APPEND, ...(backend.systemPromptAppends ?? [])].join('\n\n')
        : backend.persistentSystemPrompt

    expect(instructions).toContain(join('/storage', 'skills', 'personal'))
    expect(instructions).toContain(join('/storage', 'skills', 'imported'))
    expect(instructions).toContain('<name>/SKILL.md')
    expect(instructions).toContain('discovered automatically')
    expect(instructions).toContain('do not download, unpack, or copy an external Skill there')
    expect(instructions).toContain('request_skill_import')
    expect(instructions).toContain('when it is available')
    expect(instructions).toContain('Never unpack or copy a Skill into a Skill directory yourself')
    expect(instructions).not.toContain('Do not use names beginning with')
    expect(instructions).not.toContain('copy over bundled Skill names or ids')
    expect(instructions).not.toContain('reuse another user Skill id')
    await backend.anthropicBridgeLease?.release()
    await backend.responsesBridgeLease?.release()
    await backend.providerTransportLease?.release()
  })

  it.each([
    { name: 'Claude Code', frameworkId: 'claude-code' as const, target: {} },
    { name: 'OpenCode', frameworkId: 'opencode' as const, target: {} },
    {
      name: 'Codex Responses',
      frameworkId: 'codex' as const,
      target: { provider: { apiEndpoints: ['responses'] as const } }
    },
    {
      name: 'Codex bridge',
      frameworkId: 'codex' as const,
      target: {
        needsChatResponsesBridge: true,
        provider: { apiEndpoints: ['openai'] as const }
      }
    }
  ])(
    'rematerializes exact enabled Connector Skill names for each $name generation',
    async (testCase) => {
      const harness = makeHarness({
        connectorIds: ['pubmed', 'literature'],
        connectorSkillNames: ['mcp-pubmed', 'mcp-literature', 'mcp-custom-chemistry'],
        targetOverride: () => testCase.target
      })
      const target = {
        frameworkId: testCase.frameworkId,
        providerId: 'provider-a',
        model: { kind: 'provider-default' as const },
        reasoningEffort: 'high' as const
      }

      const previousBackend = await harness.resolver.resolveExplicitTarget(target)
      await previousBackend.anthropicBridgeLease?.release()
      await previousBackend.responsesBridgeLease?.release()
      await previousBackend.providerTransportLease?.release()

      const backend = await harness.resolver.resolveExplicitTarget(target)
      const instructions =
        testCase.frameworkId === 'claude-code'
          ? backend.systemPromptAppends?.join('\n\n')
          : backend.persistentSystemPrompt

      expect(instructions).toContain(
        'Globally Enabled Connector Skills: `mcp-pubmed`, `mcp-literature`, `mcp-custom-chemistry`.'
      )
      expect(instructions).toContain('`<open_science_specialist_skill_scope>` block')
      expect(instructions).not.toContain('host.mcp("custom-chemistry"')
      expect(instructions).not.toContain('`mcp-openalex`')
      expect(harness.runtime.provisionClaudeRuntimeConfig).toHaveBeenCalledTimes(
        testCase.frameworkId === 'claude-code' ? 2 : 0
      )
      expect(harness.runtime.materializeAgentSkills).toHaveBeenCalledTimes(
        testCase.frameworkId === 'claude-code' ? 0 : 2
      )
      await backend.anthropicBridgeLease?.release()
      await backend.responsesBridgeLease?.release()
      await backend.providerTransportLease?.release()
    }
  )

  it('provisions an isolated Connector Skill runtime for CodeBuddy', async () => {
    const harness = makeHarness({ connectorIds: ['pubmed'] })

    const backend = await harness.resolver.resolveExplicitTarget({
      frameworkId: 'codebuddy',
      providerId: 'provider-a',
      model: { kind: 'provider-default' },
      reasoningEffort: 'high'
    })

    expect(harness.runtime.materializeAgentSkills).toHaveBeenCalledWith(
      expect.any(Object),
      join('/storage', 'codebuddy', 'skill-runtime', '.claude'),
      new Set(),
      { directoryLayout: 'agent-facing' }
    )
    expect(backend.sessionOptions).toEqual({
      [OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION]: {
        command: process.execPath,
        entryPath: '/app/main.js',
        root: join('/storage', 'codebuddy', 'skill-runtime')
      }
    })
    expect(backend.persistentSystemPrompt).toContain('`mcp-pubmed`')
    expect(backend.persistentSystemPrompt).not.toContain('search_articles')
    expect(backend.env).toMatchObject({
      CODEBUDDY_API_KEY: 'openai-bridge-token-0',
      CODEBUDDY_BASE_URL: 'http://127.0.0.1:42000/v1',
      OPEN_SCIENCE_CODEBUDDY_CHAT_COMPLETIONS_URL: 'http://127.0.0.1:42000/v1/chat/completions'
    })
    expect(harness.createOpenAiProviderBridge).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          wire: 'chat-completions',
          endpoint: 'https://gateway.example/v1/chat/completions',
          key: 'plain:provider-a-key-ref',
          model: 'model-a',
          adaptRequest: expect.any(Function)
        })
      ],
      expect.any(String)
    )
    await backend.providerTransportLease?.release()
    expect(harness.openAiProviderBridges[0]?.close).toHaveBeenCalledOnce()
  })

  it('keeps the isolated CodeBuddy Skill runtime available without enabled Connectors', async () => {
    const harness = makeHarness({ connectorIds: [] })

    const backend = await harness.resolver.resolveExplicitTarget({
      frameworkId: 'codebuddy',
      providerId: 'provider-a',
      model: { kind: 'provider-default' },
      reasoningEffort: 'high'
    })

    expect(harness.runtime.materializeAgentSkills).toHaveBeenCalledWith(
      expect.any(Object),
      join('/storage', 'codebuddy', 'skill-runtime', '.claude'),
      new Set(),
      { directoryLayout: 'agent-facing' }
    )
    expect(backend.sessionOptions).toHaveProperty(
      OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION,
      expect.objectContaining({ root: join('/storage', 'codebuddy', 'skill-runtime') })
    )
    expect(backend.persistentSystemPrompt).toBeUndefined()
    await backend.providerTransportLease?.release()
  })

  it.each([
    { name: 'OpenCode', frameworkId: 'opencode' as const, target: {} },
    {
      name: 'Codex Responses',
      frameworkId: 'codex' as const,
      target: { provider: { apiEndpoints: ['responses'] as const } }
    },
    {
      name: 'Codex bridge',
      frameworkId: 'codex' as const,
      target: {
        needsChatResponsesBridge: true,
        provider: { apiEndpoints: ['openai'] as const }
      }
    }
  ])(
    'does not advertise a custom Skill whose doc failed to materialize for $name',
    async (testCase) => {
      const harness = makeHarness({
        connectorSkillNames: ['mcp-pubmed', 'mcp-xt'],
        materializedConnectorSkillNames: ['mcp-pubmed'],
        targetOverride: () => testCase.target
      })

      const backend = await harness.resolver.resolveExplicitTarget({
        frameworkId: testCase.frameworkId,
        providerId: 'provider-a',
        model: { kind: 'provider-default' },
        reasoningEffort: 'high'
      })

      expect(backend.persistentSystemPrompt).toContain('`mcp-pubmed`')
      expect(backend.persistentSystemPrompt).not.toContain('`mcp-xt`')
      await backend.anthropicBridgeLease?.release()
      await backend.responsesBridgeLease?.release()
      await backend.providerTransportLease?.release()
    }
  )

  it.each([
    { name: 'direct Responses', chat: false, native: false, apiEndpoints: ['responses'] as const },
    { name: 'Chat bridge', chat: true, native: false, apiEndpoints: ['openai'] as const },
    {
      name: 'Responses compatibility',
      chat: false,
      native: true,
      apiEndpoints: ['responses'] as const
    }
  ])(
    'persists ordered application, Skill, and Connector guidance for Codex $name',
    async (testCase) => {
      const harness = makeHarness({
        connectorIds: ['pubmed'],
        targetOverride: () => ({
          needsChatResponsesBridge: testCase.chat,
          needsNativeResponsesCompatibility: testCase.native,
          provider: { apiEndpoints: [...testCase.apiEndpoints] }
        })
      })

      const applicationGuidance = 'Stable Open Science app guidance.'
      const backend = await harness.resolver.resolveExplicitTarget(
        {
          frameworkId: 'codex',
          providerId: 'provider-a',
          model: { kind: 'provider-default' },
          reasoningEffort: 'high'
        },
        { systemPromptAppends: [applicationGuidance] }
      )
      const developerInstructions = JSON.parse(backend.env.CODEX_CONFIG ?? '{}')
        .developer_instructions as string | undefined

      expect(developerInstructions).toBeDefined()
      const userSkillIndex = developerInstructions?.indexOf('<open_science_user_skill_directories>')
      const connectorIndex = developerInstructions?.indexOf(
        '# Open Science data connector conventions'
      )
      expect(developerInstructions?.indexOf(applicationGuidance)).toBeGreaterThanOrEqual(0)
      expect(userSkillIndex).toBeGreaterThan(
        developerInstructions?.indexOf(applicationGuidance) ?? -1
      )
      expect(connectorIndex).toBeGreaterThan(userSkillIndex ?? -1)
      expect(developerInstructions).toContain(
        'Load the matching `mcp-*` skill before the first `host.mcp` call'
      )
      expect(developerInstructions).toContain('Never guess a connector server or method name')
      expect(developerInstructions).not.toContain('search_articles')
      expect(backend.persistentSystemPrompt).toBe(developerInstructions)
      expect(backend.systemPromptAppends).toBeUndefined()
      await backend.responsesBridgeLease?.release()
    }
  )

  it.each([
    { name: 'direct', chat: false, native: false, responseCalls: 0, nativeCalls: 0 },
    {
      name: 'Chat Completions bridge',
      chat: true,
      native: false,
      responseCalls: 1,
      nativeCalls: 0
    },
    {
      name: 'native Responses compatibility',
      chat: false,
      native: true,
      responseCalls: 0,
      nativeCalls: 1
    }
  ])('honors the provider-owned $name predicate', async (testCase) => {
    const harness = makeHarness({
      targetOverride: () => ({
        needsChatResponsesBridge: testCase.chat,
        needsNativeResponsesCompatibility: testCase.native
      })
    })

    const backend = await harness.resolver.resolveExplicitTarget({
      frameworkId: 'codex',
      providerId: 'provider-a',
      model: { kind: 'provider-default' },
      reasoningEffort: 'high'
    })

    expect(harness.createResponsesBridge).toHaveBeenCalledTimes(testCase.responseCalls)
    expect(harness.createNativeResponsesProxy).toHaveBeenCalledTimes(testCase.nativeCalls)
    expect(backend.responsesBridgeLease === undefined).toBe(
      testCase.responseCalls + testCase.nativeCalls === 0
    )
    await backend.responsesBridgeLease?.release()
  })

  it('bypasses loopback without disabling inherited proxies for native Responses compatibility', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.test:3128')
    vi.stubEnv('NO_PROXY', 'metadata.example.test,existing.internal')
    try {
      const harness = makeHarness({
        targetOverride: () => ({ needsNativeResponsesCompatibility: true })
      })

      const backend = await harness.resolver.resolveExplicitTarget({
        frameworkId: 'codex',
        providerId: 'provider-a',
        model: { kind: 'provider-default' },
        reasoningEffort: 'high'
      })

      expect(backend.proxyEnvironmentMode).toBeUndefined()
      expect(backend.env).not.toHaveProperty('HTTPS_PROXY')
      const loopbackBypass = ['localhost', '127.0.0.1', '127.0.0.0/8', '::1', '[::1]']
      expect(backend.env.NO_PROXY?.split(',')).toEqual(
        expect.arrayContaining(['metadata.example.test', 'existing.internal', ...loopbackBypass])
      )
      expect(backend.env.no_proxy?.split(',')).toEqual(
        expect.arrayContaining(['metadata.example.test', 'existing.internal', ...loopbackBypass])
      )
      await backend.responsesBridgeLease?.release()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('AgentBackendResolver bridge generations', () => {
  it('creates unique generations and releases each lease idempotently', async () => {
    let generation = 0
    const harness = makeHarness({
      targetOverride: () => ({ needsChatResponsesBridge: true }),
      nextGenerationId: () => `generation-${++generation}`
    })
    const target = {
      frameworkId: 'codex' as const,
      providerId: 'provider-a',
      model: { kind: 'provider-default' as const },
      reasoningEffort: 'high' as const
    }

    const first = await harness.resolver.resolveExplicitTarget(target)
    const second = await harness.resolver.resolveExplicitTarget(target)
    first.responsesBridgeLease?.setReasoningEffort?.('low')
    second.responsesBridgeLease?.setReasoningEffort?.('max')
    first.responsesBridgeLease?.registerReviewerSession('first-reviewer')
    second.responsesBridgeLease?.registerReviewerSession('second-reviewer')
    await first.responsesBridgeLease?.release()
    await first.responsesBridgeLease?.release()
    await second.responsesBridgeLease?.release()

    expect(harness.nextGenerationId).toHaveBeenCalledTimes(2)
    expect(harness.nextGenerationId).toHaveNthReturnedWith(1, 'generation-1')
    expect(harness.nextGenerationId).toHaveNthReturnedWith(2, 'generation-2')
    expect(harness.createResponsesBridge).toHaveBeenCalledTimes(2)
    expect(harness.responsesBridges).toHaveLength(2)
    expect(harness.responsesBridges[0]?.close).toHaveBeenCalledTimes(1)
    expect(harness.responsesBridges[1]?.close).toHaveBeenCalledTimes(1)
    expect(harness.responsesBridges[0]?.setReasoningEffort).toHaveBeenCalledWith('low')
    expect(harness.responsesBridges[0]?.setReasoningEffort).not.toHaveBeenCalledWith('max')
    expect(harness.responsesBridges[1]?.setReasoningEffort).toHaveBeenCalledWith('max')
    expect(harness.responsesBridges[1]?.setReasoningEffort).not.toHaveBeenCalledWith('low')
    expect(harness.responsesBridges[0]?.registerReviewerSession).toHaveBeenCalledWith(
      'first-reviewer'
    )
    expect(harness.responsesBridges[0]?.registerReviewerSession).toHaveBeenCalledTimes(1)
    expect(harness.responsesBridges[0]?.registerReviewerSession).not.toHaveBeenCalledWith(
      'second-reviewer'
    )
    expect(harness.responsesBridges[1]?.registerReviewerSession).toHaveBeenCalledWith(
      'second-reviewer'
    )
    expect(harness.responsesBridges[1]?.registerReviewerSession).toHaveBeenCalledTimes(1)
    expect(harness.responsesBridges[1]?.registerReviewerSession).not.toHaveBeenCalledWith(
      'first-reviewer'
    )
  })
})

describe('AgentBackendResolver bridge cleanup', () => {
  it.each(['chat', 'native'] as const)(
    'closes a half-started %s resource and preserves the start error',
    async (protocol) => {
      const startError = new Error(`${protocol} start failed`)
      const closeError = new Error(`${protocol} close failed`)
      const resource =
        protocol === 'chat'
          ? makeResponsesBridgeDouble({ startError, closeError })
          : makeNativeResponsesProxyDouble({ startError, closeError })
      const harness = makeHarness({
        targetOverride: () => ({
          needsChatResponsesBridge: protocol === 'chat',
          needsNativeResponsesCompatibility: protocol === 'native'
        }),
        ...(protocol === 'chat'
          ? { responsesBridgeBuilder: () => resource as ResponsesBridgeDouble }
          : { nativeResponsesProxyBuilder: () => resource as NativeResponsesProxyDouble })
      })

      await expect(
        harness.resolver.resolveExplicitTarget({
          frameworkId: 'codex',
          providerId: 'provider-a',
          model: { kind: 'provider-default' },
          reasoningEffort: 'high'
        })
      ).rejects.toBe(startError)

      expect(resource.close).toHaveBeenCalledTimes(1)
      expect(harness.runtime.materializeAgentConfigFiles).not.toHaveBeenCalled()
    }
  )

  it.each(['chat', 'native'] as const)(
    'releases a started %s resource when later backend preparation fails',
    async (protocol) => {
      const preparationError = new Error(`${protocol} preparation failed`)
      const resource =
        protocol === 'chat' ? makeResponsesBridgeDouble() : makeNativeResponsesProxyDouble()
      const harness = makeHarness({
        targetOverride: () => ({
          needsChatResponsesBridge: protocol === 'chat',
          needsNativeResponsesCompatibility: protocol === 'native'
        }),
        ...(protocol === 'chat'
          ? { responsesBridgeBuilder: () => resource as ResponsesBridgeDouble }
          : { nativeResponsesProxyBuilder: () => resource as NativeResponsesProxyDouble })
      })
      harness.runtime.materializeAgentConfigFiles.mockRejectedValueOnce(preparationError)

      await expect(
        harness.resolver.resolveExplicitTarget({
          frameworkId: 'codex',
          providerId: 'provider-a',
          model: { kind: 'provider-default' },
          reasoningEffort: 'high'
        })
      ).rejects.toBe(preparationError)

      expect(resource.start).toHaveBeenCalledTimes(1)
      expect(resource.close).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['chat', 'native'] as const)(
    'preserves the existing %s cleanup rejection priority after preparation fails',
    async (protocol) => {
      const preparationError = new Error(`${protocol} preparation failed`)
      const closeError = new Error(`${protocol} close failed`)
      const resource =
        protocol === 'chat'
          ? makeResponsesBridgeDouble({ closeError })
          : makeNativeResponsesProxyDouble({ closeError })
      const harness = makeHarness({
        targetOverride: () => ({
          needsChatResponsesBridge: protocol === 'chat',
          needsNativeResponsesCompatibility: protocol === 'native'
        }),
        ...(protocol === 'chat'
          ? { responsesBridgeBuilder: () => resource as ResponsesBridgeDouble }
          : { nativeResponsesProxyBuilder: () => resource as NativeResponsesProxyDouble })
      })
      harness.runtime.materializeAgentConfigFiles.mockRejectedValueOnce(preparationError)

      await expect(
        harness.resolver.resolveExplicitTarget({
          frameworkId: 'codex',
          providerId: 'provider-a',
          model: { kind: 'provider-default' },
          reasoningEffort: 'high'
        })
      ).rejects.toBe(closeError)

      expect(resource.close).toHaveBeenCalledTimes(1)
    }
  )
})
