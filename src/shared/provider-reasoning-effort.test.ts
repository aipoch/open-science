import { describe, expect, it } from 'vitest'

import {
  resolveProviderEffectiveModel,
  resolveProviderReasoningEffortProfile,
  type ProviderReasoningEffortSource
} from './provider-reasoning-effort'

describe('resolveProviderEffectiveModel', () => {
  it('uses the catalog default when an official provider has no active override', () => {
    expect(
      resolveProviderEffectiveModel(
        {
          type: 'official',
          vendorId: 'openai',
          models: ['gpt-5.6-sol', 'gpt-5.5']
        },
        undefined
      )
    ).toBe('gpt-5.6-sol')
  })

  it('prefers a saved provider default and rejects a stale active override', () => {
    expect(
      resolveProviderEffectiveModel(
        {
          type: 'claude-isolated',
          model: 'claude-haiku-4-5-20251001',
          models: ['claude-haiku-4-5-20251001']
        },
        'removed-model'
      )
    ).toBe('claude-haiku-4-5-20251001')
  })

  it('keeps an unpinned Codex subscription model unknown', () => {
    expect(
      resolveProviderEffectiveModel(
        {
          type: 'codex-isolated',
          model: 'gpt-5.6-sol',
          models: ['gpt-5.6-sol']
        },
        undefined
      )
    ).toBeUndefined()
  })

  it('keeps an unpinned Claude subscription model unknown instead of using its catalog', () => {
    expect(
      resolveProviderEffectiveModel(
        {
          type: 'claude-shared',
          models: ['claude-opus-5', 'claude-haiku-4-5-20251001']
        },
        undefined
      )
    ).toBeUndefined()
  })
})

describe('resolveProviderReasoningEffortProfile', () => {
  it.each<
    [
      name: string,
      provider: ProviderReasoningEffortSource | undefined,
      model: string | undefined,
      expected: ReturnType<typeof resolveProviderReasoningEffortProfile>
    ]
  >([
    [
      'empty settings default',
      undefined,
      undefined,
      { supported: true, slots: ['low', 'medium', 'high', 'xhigh', 'max'] }
    ],
    [
      'official model override',
      { type: 'official', vendorId: 'anthropic' },
      'claude-haiku-4-5-20251001',
      { supported: false }
    ],
    [
      'pinned Codex subscription',
      { type: 'codex-isolated' },
      'gpt-5.6-sol',
      { supported: true, slots: ['low', 'medium', 'high', 'xhigh', 'ultra'] }
    ],
    ['unpinned Codex subscription', { type: 'codex-shared' }, undefined, { supported: false }],
    [
      'Claude subscription',
      { type: 'claude-isolated' },
      'claude-haiku-4-5-20251001',
      { supported: false }
    ],
    ['unpinned Claude subscription', { type: 'claude-shared' }, undefined, { supported: false }],
    [
      'custom model preset',
      { type: 'custom', reasoningEffortPreset: 'none-high' },
      'custom-model',
      { supported: true, slots: ['none', 'high', 'high', 'high', 'high'] }
    ],
    [
      'legacy custom model default',
      { type: 'custom' },
      'custom-model',
      { supported: true, slots: ['low', 'medium', 'high', 'xhigh', 'max'] }
    ],
    ['malformed official provider', { type: 'official' }, 'model', { supported: false }]
  ])('resolves the %s profile', (_name, provider, model, expected) => {
    expect(resolveProviderReasoningEffortProfile(provider, model)).toEqual(expected)
  })
})
