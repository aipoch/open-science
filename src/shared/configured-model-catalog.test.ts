import { describe, expect, it } from 'vitest'

import type { ProviderView } from './settings'
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
})
