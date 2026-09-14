import { describe, expect, it } from 'vitest'

import {
  CLAUDE_ISOLATED_PROVIDER_ID,
  CLAUDE_SHARED_PROVIDER_ID,
  type ProviderView
} from './settings'
import {
  buildConfiguredModelCatalog,
  configuredModelKey,
  parseConfiguredModelKey
} from './configured-model-catalog'

const provider = (
  id: string,
  models: string[],
  overrides: Partial<ProviderView> = {}
): ProviderView => ({
  id,
  type: 'custom',
  name: id,
  apiEndpoints: ['openai'],
  baseUrl: 'https://example.test/v1',
  model: models[0],
  models,
  supportsImageInput: false,
  hasKey: true,
  needsKey: false,
  lastValidatedAt: 10,
  ...overrides
})

describe('configured model catalog', () => {
  it('keeps same-named models distinct by compound provider identity', () => {
    const entries = buildConfiguredModelCatalog({
      providers: [provider('first', ['shared']), provider('second', ['shared'])],
      frameworkId: 'opencode',
      frameworkEndpoints: ['openai']
    })

    expect(entries.map((entry) => entry.key)).toEqual([
      configuredModelKey('first', 'shared'),
      configuredModelKey('second', 'shared')
    ])
    expect(parseConfiguredModelKey(entries[1].key)).toEqual({
      providerId: 'second',
      model: 'shared'
    })
  })

  it('owns validation and framework compatibility for every model selector', () => {
    const entries = buildConfiguredModelCatalog({
      providers: [
        provider('failed', ['a'], { lastValidationFailure: { at: 11, category: 'auth' } }),
        provider('incompatible', ['b'], { apiEndpoints: ['anthropic'] }),
        provider('ready', ['c'])
      ],
      frameworkId: 'opencode',
      frameworkEndpoints: ['openai']
    })

    expect(
      entries.map((entry) => [entry.providerId, entry.selectable, entry.unavailableReason])
    ).toEqual([
      ['incompatible', false, 'framework-incompatible'],
      ['ready', true, undefined]
    ])
  })

  it('grays out a verified local model instead of hiding it when the framework cannot drive it', () => {
    // The framework-agnostic probe records its target against the provider's own route, so a
    // verified-but-incompatible entry must stay in the catalog (grayed, with its reason) rather
    // than being filtered out as unvalidated.
    const entries = buildConfiguredModelCatalog({
      providers: [
        provider('ollama', ['qwen3:14b'], {
          lastValidatedAt: 20,
          lastValidatedTarget: { model: 'qwen3:14b', endpoint: 'openai' }
        })
      ],
      frameworkId: 'claude-code',
      frameworkEndpoints: ['anthropic']
    })

    expect(
      entries.map((entry) => [
        entry.providerId,
        entry.model,
        entry.selectable,
        entry.unavailableReason
      ])
    ).toEqual([['ollama', 'qwen3:14b', false, 'framework-incompatible']])
  })

  it('excludes only the model target whose validation reported it missing', () => {
    const failedTargetProvider = provider('multi-model', ['model-a', 'model-b'], {
      lastValidationFailure: {
        at: 11,
        category: 'model-not-found',
        target: { model: 'model-b', endpoint: 'openai' }
      }
    } as Partial<ProviderView>)

    const entries = buildConfiguredModelCatalog({
      providers: [failedTargetProvider],
      frameworkId: 'opencode',
      frameworkEndpoints: ['openai']
    })

    expect(entries.map((entry) => entry.model)).toEqual(['model-a'])
  })

  it('checks each official model against its documented protocol', () => {
    const entries = buildConfiguredModelCatalog({
      providers: [
        provider('opencode-zen', ['kimi-k2.7-code', 'gpt-5.6-sol', 'claude-opus-5'], {
          type: 'official',
          vendorId: 'opencode'
        })
      ],
      frameworkId: 'opencode',
      frameworkEndpoints: ['anthropic', 'openai']
    })

    expect(
      entries.map(({ model, selectable, unavailableReason }) => [
        model,
        selectable,
        unavailableReason
      ])
    ).toEqual([
      ['kimi-k2.7-code', true, undefined],
      ['gpt-5.6-sol', false, 'framework-incompatible'],
      ['claude-opus-5', true, undefined]
    ])
  })

  it('projects xAI subscription models as image-capable', () => {
    const [entry] = buildConfiguredModelCatalog({
      providers: [
        provider('builtin-xai-subscription', ['grok-4.6'], {
          type: 'xai-subscription',
          apiEndpoints: ['anthropic', 'openai', 'responses'],
          supportsImageInput: true
        })
      ],
      frameworkId: 'opencode',
      frameworkEndpoints: ['openai']
    })

    expect(entry.supportsImageInput).toBe(true)
  })

  it('uses a custom provider singular model when its catalog array is empty', () => {
    const entries = buildConfiguredModelCatalog({
      providers: [provider('custom', [], { model: 'custom-model' })],
      activeProviderId: 'custom',
      frameworkId: 'opencode',
      frameworkEndpoints: ['openai']
    })

    expect(entries).toMatchObject([
      { providerId: 'custom', model: 'custom-model', label: 'custom-model', selectable: true }
    ])
  })

  it('includes every Claude subscription only for Session catalogs', () => {
    const providers = [
      provider(CLAUDE_SHARED_PROVIDER_ID, ['shared-model'], {
        type: 'claude-shared',
        apiEndpoints: ['anthropic']
      }),
      provider(CLAUDE_ISOLATED_PROVIDER_ID, ['isolated-model'], {
        type: 'claude-isolated',
        apiEndpoints: ['anthropic']
      })
    ]
    const input = {
      providers,
      activeProviderId: CLAUDE_SHARED_PROVIDER_ID,
      frameworkId: 'claude-code' as const,
      frameworkEndpoints: ['anthropic' as const]
    }

    expect(buildConfiguredModelCatalog(input).map((entry) => entry.providerId)).toEqual([
      CLAUDE_SHARED_PROVIDER_ID
    ])
    expect(
      buildConfiguredModelCatalog({
        ...input,
        includeAllClaudeSubscriptions: true
      }).map((entry) => entry.providerId)
    ).toEqual([CLAUDE_SHARED_PROVIDER_ID, CLAUDE_ISOLATED_PROVIDER_ID])
  })
})
