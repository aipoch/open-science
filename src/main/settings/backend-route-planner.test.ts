import { describe, expect, it, vi } from 'vitest'

import { SETTINGS_FILE_VERSION } from '../../shared/settings'
import type { AgentFrameworkId } from '../agent-framework'
import { opencodeTransportProviderId } from '../agent-framework/opencode'
import type { ProviderRuntimeTarget } from './provider-accounts'
import type { ResolvedProvider } from './provider-env'
import type { StoredProvider, StoredSettings } from './types'
import { BackendRoutePlanner, type BackendRouteProviderPort } from './backend-route-planner'

const makeStoredProvider = (overrides: Partial<StoredProvider> = {}): StoredProvider => ({
  id: 'provider-a',
  type: 'custom',
  name: 'Provider A',
  apiEndpoints: ['anthropic', 'openai', 'responses'],
  baseUrl: 'https://provider-a.example/v1',
  model: 'model-a',
  keyRef: 'provider-a-key-ref',
  ...overrides
})

const makeSettings = (provider = makeStoredProvider()): StoredSettings => ({
  version: SETTINGS_FILE_VERSION,
  providers: [provider],
  activeProviderId: provider.id,
  activeModel: provider.model,
  agentFrameworkId: 'codex',
  reasoningEffort: 'high'
})

const makeTarget = (
  provider: StoredProvider,
  overrides: Omit<Partial<ProviderRuntimeTarget>, 'provider'> & {
    provider?: Partial<ResolvedProvider>
  } = {}
): ProviderRuntimeTarget => {
  const { provider: providerOverrides, ...targetOverrides } = overrides
  return {
    providerId: provider.id,
    providerType: provider.type,
    effectiveModel: provider.model,
    apiEndpoints: provider.apiEndpoints ?? ['anthropic'],
    provider: {
      type: provider.type,
      baseUrl: provider.baseUrl,
      openaiBaseUrl: provider.baseUrl,
      model: provider.model,
      key: 'plain-provider-key',
      apiEndpoints: provider.apiEndpoints,
      ...providerOverrides
    },
    reasoningEffortProfile: {
      supported: true,
      slots: ['low', 'medium', 'high', 'xhigh', 'max']
    },
    frameworkCompatible: true,
    modelBridgeSupported: true,
    needsChatResponsesBridge: false,
    needsNativeResponsesCompatibility: false,
    ...targetOverrides
  }
}

const makePlanner = (): BackendRoutePlanner => {
  const providers: BackendRouteProviderPort = {
    resolveRuntimeTarget: vi.fn(),
    resolveRuntimeModelCatalog: vi.fn(() => [])
  }
  return new BackendRoutePlanner({ providers })
}

describe('BackendRoutePlanner route matrix', () => {
  it.each<{
    name: string
    frameworkId: AgentFrameworkId
    target: Omit<Partial<ProviderRuntimeTarget>, 'provider'> & {
      provider?: Partial<ResolvedProvider>
    }
    forceCompatibility?: boolean
    route: string
  }>([
    { name: 'Claude', frameworkId: 'claude-code', target: {}, route: 'claude-anthropic' },
    {
      name: 'OpenCode OpenAI',
      frameworkId: 'opencode',
      target: { apiEndpoints: ['openai'] },
      route: 'opencode-openai'
    },
    {
      name: 'OpenCode Anthropic',
      frameworkId: 'opencode',
      target: { apiEndpoints: ['anthropic'] },
      route: 'opencode-anthropic'
    },
    {
      name: 'CodeBuddy Responses compatibility',
      frameworkId: 'codebuddy',
      target: { apiEndpoints: ['responses'], needsChatResponsesBridge: true },
      route: 'codebuddy-openai'
    },
    {
      name: 'Codex Chat bridge',
      frameworkId: 'codex',
      target: { needsChatResponsesBridge: true },
      route: 'codex-bridge'
    },
    {
      name: 'Codex native compatibility',
      frameworkId: 'codex',
      target: { needsNativeResponsesCompatibility: true },
      route: 'codex-responses-compatibility'
    },
    { name: 'Codex direct Responses', frameworkId: 'codex', target: {}, route: 'codex-responses' },
    {
      name: 'forced Codex compatibility',
      frameworkId: 'codex',
      target: {},
      forceCompatibility: true,
      route: 'codex-responses-compatibility'
    }
  ])('plans $name without starting a live resource', (testCase) => {
    const provider = makeStoredProvider()
    const target = makeTarget(provider, testCase.target)

    const plan = makePlanner().planBackend({
      settings: makeSettings(provider),
      frameworkId: testCase.frameworkId,
      target,
      effortIntent: 'high',
      conversationSkillImportEnabled: true,
      forceNativeResponsesCompatibility: testCase.forceCompatibility
    })

    expect(plan.modelRoute).toBe(testCase.route)
  })

  it('rejects forced native compatibility for Codex subscription before planning resources', () => {
    const provider = makeStoredProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexAuthMode: 'isolated',
      keyRef: undefined
    })

    expect(() =>
      makePlanner().planBackend({
        settings: makeSettings(provider),
        frameworkId: 'codex',
        target: makeTarget(provider),
        effortIntent: 'high',
        conversationSkillImportEnabled: true,
        forceNativeResponsesCompatibility: true
      })
    ).toThrow('unavailable with Codex subscription authentication')
  })

  it.each([
    ['claude-code', 'claude-anthropic'],
    ['opencode', 'opencode-openai'],
    ['codex', 'codex-native-responses']
  ] as const)('keeps a single custom %s provider behind the %s loopback', (frameworkId, kind) => {
    const provider = makeStoredProvider()
    const target = makeTarget(provider)

    const plan = makePlanner().planBackend({
      settings: makeSettings(provider),
      frameworkId,
      target,
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.transport.kind).toBe(kind)
  })

  it('keeps Codex subscription authentication on its direct transport', () => {
    const provider = makeStoredProvider({
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      codexAuthMode: 'isolated',
      keyRef: undefined
    })

    const plan = makePlanner().planBackend({
      settings: makeSettings(provider),
      frameworkId: 'codex',
      target: makeTarget(provider),
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.transport).toEqual({ kind: 'direct' })
  })

  it.each([
    { apiEndpoints: ['responses'] as const, wire: 'responses' as const },
    { apiEndpoints: ['anthropic'] as const, wire: 'anthropic' as const }
  ])('adapts a $wire-only provider to CodeBuddy Chat Completions', ({ apiEndpoints, wire }) => {
    const provider = makeStoredProvider({ apiEndpoints: [...apiEndpoints] })
    const plan = makePlanner().planBackend({
      settings: { ...makeSettings(provider), agentFrameworkId: 'codebuddy' },
      frameworkId: 'codebuddy',
      target: makeTarget(provider, {
        apiEndpoints: [...apiEndpoints],
        needsChatResponsesBridge: true
      }),
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.transport).toEqual({ kind: 'codebuddy-provider-compatibility', wire })
  })

  it.each([
    ['claude-code', false, 'claude-anthropic'],
    ['opencode', false, 'opencode-openai'],
    ['codex', true, 'codex-responses-compatibility']
  ] as const)(
    'routes xAI OAuth through the app-owned %s transport without a stored API key',
    (frameworkId, needsNativeResponsesCompatibility, kind) => {
      const provider = makeStoredProvider({
        id: 'builtin-xai-subscription',
        type: 'xai-subscription',
        name: 'xAI (Grok) OAuth',
        baseUrl: 'https://api.x.ai/v1',
        model: 'grok-4.6',
        keyRef: undefined
      })
      const target = makeTarget(provider, {
        needsNativeResponsesCompatibility,
        provider: {
          type: 'xai-subscription',
          vendorId: 'xai',
          baseUrl: 'https://api.x.ai/v1',
          openaiBaseUrl: 'https://api.x.ai/v1',
          model: 'grok-4.6',
          key: undefined
        }
      })

      const plan = makePlanner().planBackend({
        settings: { ...makeSettings(provider), agentFrameworkId: frameworkId },
        frameworkId,
        target,
        effortIntent: 'high',
        conversationSkillImportEnabled: true
      })

      expect(plan.transport.kind).toBe(kind)
      expect(JSON.stringify(plan.transport)).not.toContain('plain-provider-key')
    }
  )

  it('does not register xAI OAuth grok ids as Claude Code availableModels', () => {
    const provider = makeStoredProvider({
      id: 'builtin-xai-subscription',
      type: 'xai-subscription',
      name: 'xAI (Grok) OAuth',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.6',
      keyRef: undefined
    })
    const target = makeTarget(provider, {
      provider: {
        type: 'xai-subscription',
        vendorId: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        openaiBaseUrl: 'https://api.x.ai/v1',
        model: 'grok-4.6',
        key: undefined
      }
    })

    const plan = makePlanner().planBackend({
      settings: { ...makeSettings(provider), agentFrameworkId: 'claude-code' },
      frameworkId: 'claude-code',
      target,
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.claudeModelConfig).toBeUndefined()
  })
})

describe('BackendRoutePlanner provider candidates', () => {
  it('deduplicates valid Claude bridge targets and ignores stale sibling providers', () => {
    const providerA = makeStoredProvider({ id: 'provider-a', model: 'model-a' })
    const providerB = makeStoredProvider({
      id: 'provider-b',
      model: 'model-b',
      baseUrl: 'https://provider-b.example/anthropic'
    })
    const stale = makeStoredProvider({ id: 'stale', model: 'stale-model' })
    const targetA = makeTarget(providerA, {
      apiEndpoints: ['anthropic'],
      provider: { apiEndpoints: ['anthropic'] }
    })
    const targetB = makeTarget(providerB, {
      apiEndpoints: ['anthropic'],
      provider: { apiEndpoints: ['anthropic'], vendorId: 'tencent' }
    })
    const providers: BackendRouteProviderPort = {
      resolveRuntimeTarget: vi.fn((provider) => {
        if (provider.id === stale.id) throw new Error('stale credential')
        return provider.id === providerA.id ? targetA : targetB
      }),
      resolveRuntimeModelCatalog: vi.fn((provider) =>
        provider.id === providerB.id ? [targetB, targetB] : []
      )
    }
    const settings = makeSettings(providerA)
    settings.providers = [providerA, providerB, stale]

    const plan = new BackendRoutePlanner({ providers }).planBackend({
      settings,
      frameworkId: 'claude-code',
      target: targetA,
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.transport).toEqual({
      kind: 'claude-anthropic',
      targets: [
        {
          id: JSON.stringify(['provider-a', 'model-a']),
          baseUrl: 'https://provider-a.example',
          key: 'plain-provider-key',
          model: 'model-a'
        },
        {
          id: JSON.stringify(['provider-b', 'model-b']),
          baseUrl: 'https://provider-b.example/anthropic',
          key: 'plain-provider-key',
          model: 'model-b',
          useApiKeyHeader: true
        }
      ],
      initialTargetId: JSON.stringify(['provider-a', 'model-a'])
    })
    expect(providers.resolveRuntimeTarget).toHaveBeenCalledWith(
      stale,
      { kind: 'configured', requestedModel: stale.model },
      expect.objectContaining({ id: 'claude-code' })
    )
  })

  it.each([
    [
      'Tencent Coding Plan',
      'tencentcodingplan' as const,
      'https://api.lkeap.cloud.tencent.com/coding/anthropic'
    ],
    [
      'Tencent Token Plan',
      'tencenttokenplan' as const,
      'https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic'
    ]
  ])('keeps %s Claude bridge targets on bearer authentication', (_, vendorId, baseUrl) => {
    const provider = makeStoredProvider({
      type: 'official',
      vendorId,
      apiEndpoints: ['anthropic'],
      baseUrl,
      model: 'deepseek-v4-pro-202606'
    })
    const target = makeTarget(provider, {
      apiEndpoints: ['anthropic'],
      // Official providers project to the custom credential transport while retaining vendorId.
      provider: { type: 'custom', vendorId, apiEndpoints: ['anthropic'] }
    })

    const plan = makePlanner().planBackend({
      settings: { ...makeSettings(provider), agentFrameworkId: 'claude-code' },
      frameworkId: 'claude-code',
      target,
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.transport).toEqual({
      kind: 'claude-anthropic',
      targets: [
        {
          id: JSON.stringify([provider.id, provider.model]),
          baseUrl,
          key: 'plain-provider-key',
          model: provider.model
        }
      ],
      initialTargetId: JSON.stringify([provider.id, provider.model])
    })
  })

  it('registers the Apodex Mini model for Claude background requests', () => {
    const provider = makeStoredProvider({
      type: 'official',
      vendorId: 'apodex',
      apiEndpoints: ['anthropic', 'openai'],
      baseUrl: 'https://api.apodex.ai',
      model: 'apodex-1.1'
    })
    const target = makeTarget(provider, {
      apiEndpoints: ['anthropic', 'openai'],
      provider: {
        type: 'custom',
        vendorId: 'apodex',
        apiEndpoints: ['anthropic', 'openai']
      }
    })

    const plan = makePlanner().planBackend({
      settings: { ...makeSettings(provider), agentFrameworkId: 'claude-code' },
      frameworkId: 'claude-code',
      target,
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.transport).toEqual({
      kind: 'claude-anthropic',
      targets: [
        {
          id: JSON.stringify([provider.id, provider.model]),
          baseUrl: 'https://api.apodex.ai',
          key: 'plain-provider-key',
          model: 'apodex-1.1',
          backgroundModel: 'apodex-1.1-mini',
          useApiKeyHeader: true
        }
      ],
      initialTargetId: JSON.stringify([provider.id, provider.model])
    })
  })

  it('filters model catalogs by route and preserves deduplicated effort slots', () => {
    const provider = makeStoredProvider()
    const active = makeTarget(provider, {
      apiEndpoints: ['openai'],
      provider: { apiEndpoints: ['openai'] }
    })
    const catalogTarget = makeTarget(provider, {
      effectiveModel: 'catalog-model',
      apiEndpoints: ['openai'],
      provider: { model: 'catalog-model', apiEndpoints: ['openai'] },
      reasoningEffortProfile: {
        supported: true,
        slots: ['low', 'high', 'high', 'xhigh', 'max']
      }
    })
    const wrongRoute = makeTarget(provider, {
      effectiveModel: 'anthropic-model',
      apiEndpoints: ['anthropic'],
      provider: { model: 'anthropic-model', apiEndpoints: ['anthropic'] }
    })
    const providers: BackendRouteProviderPort = {
      resolveRuntimeTarget: vi.fn(() => active),
      resolveRuntimeModelCatalog: vi.fn(() => [catalogTarget, wrongRoute])
    }

    const plan = new BackendRoutePlanner({ providers }).planBackend({
      settings: makeSettings(provider),
      frameworkId: 'opencode',
      target: active,
      effortIntent: 'max',
      conversationSkillImportEnabled: true
    })

    expect(plan.providerModelCatalog).toEqual([
      {
        provider: catalogTarget.provider,
        reasoningEffort: 'max',
        reasoningEfforts: ['low', 'high', 'xhigh', 'max']
      }
    ])
  })

  it('registers opaque third-party Claude model ids through identity overrides', () => {
    const provider = makeStoredProvider({ model: 'third-party/model-a' })
    const targetA = makeTarget(provider, {
      effectiveModel: 'third-party/model-a',
      apiEndpoints: ['anthropic'],
      provider: { model: 'third-party/model-a', apiEndpoints: ['anthropic'] }
    })
    const targetB = makeTarget(provider, {
      effectiveModel: 'third-party/model-b',
      apiEndpoints: ['anthropic'],
      provider: { model: 'third-party/model-b', apiEndpoints: ['anthropic'] }
    })
    const providers: BackendRouteProviderPort = {
      resolveRuntimeTarget: vi.fn(() => targetA),
      resolveRuntimeModelCatalog: vi.fn(() => [targetA, targetB, targetB])
    }

    const plan = new BackendRoutePlanner({ providers }).planBackend({
      settings: makeSettings(provider),
      frameworkId: 'claude-code',
      target: targetA,
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.claudeModelConfig).toEqual({
      availableModels: ['third-party/model-a', 'third-party/model-b'],
      modelOverrides: {
        'third-party/model-a': 'third-party/model-a',
        'third-party/model-b': 'third-party/model-b'
      }
    })
    expect(JSON.stringify(plan.claudeModelConfig)).not.toContain('plain-provider-key')
  })

  it('keeps OpenAI-only and incomplete providers out of the Claude model configuration', () => {
    const providersById = [
      makeStoredProvider({ id: 'provider-a', model: 'model-a' }),
      makeStoredProvider({ id: 'provider-b', model: 'model-b' }),
      makeStoredProvider({ id: 'openai-only', model: 'openai-model' }),
      makeStoredProvider({ id: 'missing-key', model: 'missing-key-model' }),
      makeStoredProvider({ id: 'missing-base', model: 'missing-base-model' })
    ]
    const targets = new Map(
      providersById.map((provider) => {
        const invalidOverrides: Parameters<typeof makeTarget>[1] =
          provider.id === 'openai-only'
            ? { apiEndpoints: ['openai'], provider: { apiEndpoints: ['openai'] } }
            : provider.id === 'missing-key'
              ? { provider: { key: undefined } }
              : provider.id === 'missing-base'
                ? { provider: { baseUrl: undefined } }
                : {}
        return [provider.id, makeTarget(provider, invalidOverrides)] as const
      })
    )
    const settings = makeSettings(providersById[0])
    settings.providers = providersById
    const planner = new BackendRoutePlanner({
      providers: {
        resolveRuntimeTarget: vi.fn((provider) => targets.get(provider.id)!),
        resolveRuntimeModelCatalog: vi.fn(() => [])
      }
    })

    const plan = planner.planBackend({
      settings,
      frameworkId: 'claude-code',
      target: targets.get('provider-a')!,
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.claudeModelConfig).toEqual({
      availableModels: ['model-a', 'model-b'],
      modelOverrides: { 'model-a': 'model-a', 'model-b': 'model-b' }
    })
  })

  it.each(['claude-shared', 'claude-isolated'] as const)(
    'does not expose custom sibling model overrides to an active %s subscription',
    (subscriptionType) => {
      const subscription = makeStoredProvider({
        id: `builtin-${subscriptionType}`,
        type: subscriptionType,
        apiEndpoints: [],
        baseUrl: undefined,
        model: 'subscription-model',
        keyRef: undefined
      })
      const customA = makeStoredProvider({ id: 'custom-a', model: 'custom-model-a' })
      const customB = makeStoredProvider({ id: 'custom-b', model: 'custom-model-b' })
      const targets = new Map([
        [
          subscription.id,
          makeTarget(subscription, {
            apiEndpoints: [],
            provider: { apiEndpoints: [], baseUrl: undefined, key: undefined }
          })
        ],
        [customA.id, makeTarget(customA)],
        [customB.id, makeTarget(customB)]
      ])
      const settings = makeSettings(subscription)
      settings.providers = [subscription, customA, customB]
      const planner = new BackendRoutePlanner({
        providers: {
          resolveRuntimeTarget: vi.fn((provider) => targets.get(provider.id)!),
          resolveRuntimeModelCatalog: vi.fn(() => [])
        }
      })

      const plan = planner.planBackend({
        settings,
        frameworkId: 'claude-code',
        target: targets.get(subscription.id)!,
        effortIntent: 'high',
        conversationSkillImportEnabled: true
      })

      expect(plan.claudeModelConfig).toBeUndefined()
      expect(plan.transport).toEqual({ kind: 'direct' })
    }
  )

  it('keeps a configured sibling when its model catalog projection fails', () => {
    const providerA = makeStoredProvider({ id: 'provider-a', model: 'model-a' })
    const providerB = makeStoredProvider({ id: 'provider-b', model: 'model-b' })
    const targetA = makeTarget(providerA, {
      apiEndpoints: ['openai'],
      provider: { apiEndpoints: ['openai'] }
    })
    const targetB = makeTarget(providerB, {
      apiEndpoints: ['openai'],
      provider: { apiEndpoints: ['openai'] }
    })
    const settings = makeSettings(providerA)
    settings.providers = [providerA, providerB]
    const planner = new BackendRoutePlanner({
      providers: {
        resolveRuntimeTarget: vi.fn((provider) =>
          provider.id === providerA.id ? targetA : targetB
        ),
        resolveRuntimeModelCatalog: vi.fn((provider) => {
          if (provider.id === providerB.id) throw new Error('catalog projection failed')
          return []
        })
      }
    })

    const plan = planner.planBackend({
      settings,
      frameworkId: 'opencode',
      target: targetA,
      effortIntent: 'high',
      conversationSkillImportEnabled: true
    })

    expect(plan.transport).toMatchObject({
      kind: 'opencode-openai',
      targets: [{ target: { providerId: providerA.id } }, { target: { providerId: providerB.id } }]
    })
  })

  it('plans deduplicated OpenCode targets within the active endpoint route', () => {
    const providerA = makeStoredProvider({ id: 'provider-a', model: 'model-a' })
    const providerB = makeStoredProvider({ id: 'provider-b', model: 'model-b' })
    const providerC = makeStoredProvider({ id: 'provider-c', model: 'model-c' })
    const targetA = makeTarget(providerA, {
      apiEndpoints: ['openai'],
      provider: { apiEndpoints: ['openai'] }
    })
    const targetB = makeTarget(providerB, {
      apiEndpoints: ['openai'],
      provider: { apiEndpoints: ['openai'] }
    })
    const targetC = makeTarget(providerC, {
      apiEndpoints: ['anthropic'],
      provider: { apiEndpoints: ['anthropic'] }
    })
    const targets = new Map([
      [providerA.id, targetA],
      [providerB.id, targetB],
      [providerC.id, targetC]
    ])
    const providers: BackendRouteProviderPort = {
      resolveRuntimeTarget: vi.fn((provider) => targets.get(provider.id)!),
      resolveRuntimeModelCatalog: vi.fn((provider) =>
        provider.id === providerB.id ? [targetB, targetB] : []
      )
    }
    const settings = makeSettings(providerA)
    settings.providers = [providerA, providerB, providerC]

    const plan = new BackendRoutePlanner({ providers }).planBackend({
      settings,
      frameworkId: 'opencode',
      target: targetA,
      effortIntent: 'max',
      conversationSkillImportEnabled: true
    })

    expect(plan.transport).toMatchObject({
      kind: 'opencode-openai',
      targets: [
        {
          id: JSON.stringify(['opencode', 'provider-a', 'model-a']),
          target: { providerId: 'provider-a', effectiveModel: 'model-a' }
        },
        {
          id: JSON.stringify(['opencode', 'provider-b', 'model-b']),
          target: { providerId: 'provider-b', effectiveModel: 'model-b' }
        }
      ]
    })
    expect((plan.transport as { targets: readonly unknown[] }).targets).toHaveLength(2)
  })

  it('declares canonical Codex Chat tools and keeps Reviewer tools scoped to reviewers', () => {
    const providerA = makeStoredProvider({ id: 'provider-a', model: 'model-a' })
    const providerB = makeStoredProvider({ id: 'provider-b', model: 'model-b' })
    const targetA = makeTarget(providerA, {
      apiEndpoints: ['openai'],
      needsChatResponsesBridge: true,
      provider: { apiEndpoints: ['openai'] }
    })
    const targetB = makeTarget(providerB, {
      apiEndpoints: ['openai'],
      needsChatResponsesBridge: true,
      provider: { apiEndpoints: ['openai'] }
    })
    const providers: BackendRouteProviderPort = {
      resolveRuntimeTarget: vi.fn((provider) => (provider.id === providerA.id ? targetA : targetB)),
      resolveRuntimeModelCatalog: vi.fn(() => [])
    }
    const settings = makeSettings(providerA)
    settings.providers = [providerA, providerB]

    const plan = new BackendRoutePlanner({ providers }).planBackend({
      settings,
      frameworkId: 'codex',
      target: targetA,
      effortIntent: 'max',
      conversationSkillImportEnabled: true
    })
    const transport = plan.transport as {
      kind: string
      targets: { id: string }[]
    }

    expect(transport.kind).toBe('codex-chat')
    expect(transport.targets.map(({ id }) => id)).toEqual([
      JSON.stringify(['codex', 'provider-a', 'model-a']),
      JSON.stringify(['codex', 'provider-b', 'model-b'])
    ])
    expect(plan.codexBridgeTools?.map(({ namespace, name }) => `${namespace}/${name}`)).toEqual(
      expect.arrayContaining([
        'mcp__open_science_notebook/notebook_execute',
        'mcp__open_science_artifacts/write_artifact_file',
        'mcp__open_science_skills/request_skill_import'
      ])
    )
    expect(plan.reviewerBridgeTools?.map(({ namespace, name }) => `${namespace}/${name}`)).toEqual(
      expect.arrayContaining([
        'mcp__open_science_reviewer/read_turn',
        'mcp__open_science_reviewer/submit_findings'
      ])
    )
    expect(plan.codexBridgeTools).not.toEqual(
      expect.arrayContaining([...(plan.reviewerBridgeTools ?? [])])
    )
    const withoutSkillImport = new BackendRoutePlanner({ providers }).planBackend({
      settings,
      frameworkId: 'codex',
      target: targetA,
      effortIntent: 'max',
      conversationSkillImportEnabled: false
    })
    expect(withoutSkillImport.codexBridgeTools?.map(({ name }) => name)).not.toContain(
      'request_skill_import'
    )
  })
})

describe('BackendRoutePlanner model-change projection', () => {
  it('projects a target for a single-provider Claude bridge model change', () => {
    const provider = makeStoredProvider({ model: 'model-a' })
    const target = makeTarget(provider, {
      effectiveModel: 'model-b',
      provider: { model: 'model-b' }
    })

    const change = makePlanner().projectModelChange({
      settings: makeSettings(provider),
      frameworkId: 'claude-code',
      target,
      effortIntent: 'high'
    })

    expect(change).toMatchObject({
      sessionModel: 'model-b',
      anthropicBridgeTargetId: JSON.stringify(['provider-a', 'model-b'])
    })
  })

  it('projects the generated provider and target for a single-provider OpenCode model change', () => {
    const provider = makeStoredProvider({ model: 'model-a', apiEndpoints: ['openai'] })
    const target = makeTarget(provider, {
      effectiveModel: 'model-b',
      apiEndpoints: ['openai'],
      provider: { model: 'model-b', apiEndpoints: ['openai'] }
    })
    const agentProviderId = opencodeTransportProviderId(provider.id, 'model-b')

    const change = makePlanner().projectModelChange({
      settings: makeSettings(provider),
      frameworkId: 'opencode',
      target,
      effortIntent: 'high'
    })

    expect(change).toMatchObject({
      sessionModel: `${agentProviderId}/model-b`,
      providerTransportTargetId: JSON.stringify(['opencode', 'provider-a', 'model-b'])
    })
  })

  it('projects a target for a single-provider native Responses model change', () => {
    const provider = makeStoredProvider({ model: 'model-a', apiEndpoints: ['responses'] })
    const target = makeTarget(provider, {
      effectiveModel: 'model-b',
      apiEndpoints: ['responses'],
      provider: { model: 'model-b', apiEndpoints: ['responses'] }
    })

    const change = makePlanner().projectModelChange({
      settings: makeSettings(provider),
      frameworkId: 'codex',
      target,
      effortIntent: 'high'
    })

    expect(change).toMatchObject({
      sessionModel: 'model-b',
      providerTransportTargetId: JSON.stringify(['codex', 'provider-a', 'model-b'])
    })
  })

  it('projects a secret-free retargetable Codex model identity', () => {
    const providerA = makeStoredProvider({ id: 'provider-a', model: 'model-a' })
    const providerB = makeStoredProvider({ id: 'provider-b', model: 'model-b' })
    const targetA = makeTarget(providerA, {
      apiEndpoints: ['openai'],
      needsChatResponsesBridge: true,
      provider: {
        apiEndpoints: ['openai'],
        vendorId: 'deepseek',
        contextWindow: 128_000,
        reasoningEffortTransport: 'deepseek'
      }
    })
    const targetB = makeTarget(providerB, {
      apiEndpoints: ['openai'],
      needsChatResponsesBridge: true,
      provider: { apiEndpoints: ['openai'] }
    })
    const providers: BackendRouteProviderPort = {
      resolveRuntimeTarget: vi.fn((provider) => (provider.id === providerA.id ? targetA : targetB)),
      resolveRuntimeModelCatalog: vi.fn(() => [])
    }
    const settings = makeSettings(providerA)
    settings.providers = [providerA, providerB]

    const target = new BackendRoutePlanner({ providers }).projectModelChange({
      settings,
      frameworkId: 'codex',
      target: targetA,
      effortIntent: 'max'
    })

    expect(target).toEqual({
      frameworkId: 'codex',
      providerId: 'provider-a',
      backendId: 'codex:provider-a',
      route: 'codex-bridge',
      model: 'model-a',
      sessionModel: 'gpt-5.4',
      sessionModelRequired: false,
      supportsImageInput: false,
      reasoningEffort: 'max',
      contextWindow: 128_000,
      providerTransportTargetId: JSON.stringify(['codex', 'provider-a', 'model-a']),
      bridge: {
        model: 'model-a',
        vendorId: 'deepseek',
        reasoningEffortTransport: 'deepseek'
      }
    })
    expect(JSON.stringify(target)).not.toContain('plain-provider-key')
  })
})
