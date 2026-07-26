import { describe, expect, it } from 'vitest'

import {
  resolveProviderReasoningEffortProfile,
  type ProviderReasoningEffortSource
} from './provider-reasoning-effort'

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
