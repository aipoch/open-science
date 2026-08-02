import { describe, expect, it, vi } from 'vitest'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import type { AgentFrameworkId } from '../agent-framework'
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
type ResolveRuntimeTarget = AgentBackendProviderPort['resolveRuntimeTarget']
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
  setReasoningEffort: vi.fn()
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
  unregisterReviewerSession: vi.fn(() => false)
})

type HarnessOptions = {
  settings?: StoredSettings
  frameworkOverride?: string
  connectorIds?: string[]
  rejectRequiredModels?: ReadonlySet<string>
  targetOverride?: (
    provider: StoredProvider,
    selection: RuntimeProviderModelSelection,
    frameworkId: AgentFrameworkId
  ) => TargetOverride
  responsesBridgeBuilder?: (index: number) => ResponsesBridgeDouble
  nativeResponsesProxyBuilder?: (index: number) => NativeResponsesProxyDouble
  nextGenerationId?: () => string
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
  const providers: AgentBackendProviderPort = {
    resolveRuntimeTarget,
    resolveRuntimeReasoningEffortProfile
  }

  const runtime = {
    resolveClaudeExecutable: vi.fn(async () => '/runtime/claude'),
    resolveOpencodeExecutable: vi.fn(async () => '/runtime/opencode'),
    resolveCodexExecutable: vi.fn(async () => '/runtime/codex-acp'),
    probeCodexNativeVersion: vi.fn(async () => '0.144.6'),
    provisionClaudeRuntimeConfig: vi.fn(async () => '/storage/claude-config'),
    materializeAgentSkills: vi.fn(async () => undefined),
    materializeAgentConfigFiles: vi.fn(async () => undefined),
    reserveOpenCodeUsagePort: vi.fn(async () => 42_424),
    resolveCodexProxyEnvironment: vi.fn(async () => undefined)
  } satisfies AgentBackendRuntimePort
  const connectors = {
    enabledConnectorIds: vi.fn(() => options.connectorIds ?? [])
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

  const resolver = new AgentBackendResolver({
    readSettings,
    providers,
    runtime,
    connectors,
    storageRoot: '/storage',
    userClaudeDir: '/user/.claude',
    readFrameworkOverride,
    createResponsesBridge,
    createNativeResponsesProxy,
    ensureCodexSubscriptionHome,
    nextGenerationId
  })

  return {
    resolver,
    readSettings,
    readFrameworkOverride,
    ensureCodexSubscriptionHome,
    nextGenerationId,
    resolveRuntimeTarget,
    resolveRuntimeReasoningEffortProfile,
    runtime,
    connectors,
    createResponsesBridge,
    createNativeResponsesProxy,
    responsesBridges,
    nativeResponsesProxies,
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
    expect(harness.connectors.enabledConnectorIds).not.toHaveBeenCalled()
    expect(harness.createResponsesBridge).not.toHaveBeenCalled()
    expect(harness.createNativeResponsesProxy).not.toHaveBeenCalled()
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

    expect(explicit).toEqual(configured)
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
      authentication: { methodId: 'api-key', _meta: { 'api-key': { apiKey: 'plain:key-b' } } }
    })
    expect(fixed).toMatchObject({
      backendId: 'codex:provider-a',
      sessionModel: 'model-a-fixed',
      sessionEffort: 'max',
      authentication: {
        methodId: 'api-key',
        _meta: { 'api-key': { apiKey: 'plain:key-a-rotated' } }
      }
    })
    expect(harness.resolveRuntimeTarget).toHaveBeenNthCalledWith(
      1,
      providerB,
      { kind: 'configured', requestedModel: 'model-b-current' },
      expect.objectContaining({ id: 'codex' })
    )
    expect(harness.resolveRuntimeTarget).toHaveBeenNthCalledWith(
      2,
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
        new Set(['forced-skill'])
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
    { name: 'direct Responses', chat: false, native: false, apiEndpoints: ['responses'] as const },
    { name: 'Chat bridge', chat: true, native: false, apiEndpoints: ['openai'] as const },
    {
      name: 'Responses compatibility',
      chat: false,
      native: true,
      apiEndpoints: ['responses'] as const
    }
  ])('persists skill-first connector guidance for Codex $name', async (testCase) => {
    const harness = makeHarness({
      connectorIds: ['pubmed'],
      targetOverride: () => ({
        needsChatResponsesBridge: testCase.chat,
        needsNativeResponsesCompatibility: testCase.native,
        provider: { apiEndpoints: [...testCase.apiEndpoints] }
      })
    })

    const backend = await harness.resolver.resolveExplicitTarget({
      frameworkId: 'codex',
      providerId: 'provider-a',
      model: { kind: 'provider-default' },
      reasoningEffort: 'high'
    })
    const developerInstructions = JSON.parse(backend.env.CODEX_CONFIG ?? '{}')
      .developer_instructions as string | undefined

    expect(developerInstructions).toContain(
      'Load the matching `mcp-*` skill before the first `host.mcp` call'
    )
    expect(developerInstructions).toContain('Never guess a connector server or method name')
    expect(developerInstructions).not.toContain('search_articles')
    expect(backend.persistentSystemPrompt).toBe(developerInstructions)
    expect(backend.systemPromptAppends).toBeUndefined()
    await backend.responsesBridgeLease?.release()
  })

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
