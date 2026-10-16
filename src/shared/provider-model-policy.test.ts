import { expect, it } from 'vitest'
import {
  defaultVendorModel,
  getOfficialVendorModelIds,
  resolveModelContextWindow,
  resolveCustomModelContextWindow
} from './provider-model-policy'
it.each(['anthropic', 'deepseek', 'minimax'] as const)(
  'excludes context suffix aliases from the refreshed %s catalog without rewriting the cache',
  (vendorId) => {
    const fetched = ['live-model', 'live-model[1m]', 'other-model[1M]']
    const models = getOfficialVendorModelIds(vendorId, undefined, fetched)
    expect(models).toContain('live-model')
    expect(models.some((model) => /\[1m\]$/i.test(model))).toBe(false)
    expect(fetched).toEqual(['live-model', 'live-model[1m]', 'other-model[1M]'])
  }
)
it.each(['anthropic', 'deepseek', 'minimax'] as const)(
  'falls back to the bundled %s catalog when discovery contains only suffix aliases',
  (vendorId) => {
    expect(getOfficialVendorModelIds(vendorId, undefined, ['removed[1m]'])).toEqual(
      getOfficialVendorModelIds(vendorId)
    )
  }
)
it.each(['global', 'china'])('preserves minimax %s initial model', (region) => {
  expect(defaultVendorModel('minimax', region)).toBe('MiniMax-M3')
})
it('does not infer context limits from removed or unknown suffix aliases', () => {
  expect(resolveModelContextWindow('anthropic', 'claude-opus-4-8[1m]')).toBe(200_000)
  expect(resolveModelContextWindow('deepseek', 'deepseek-v4-pro[1m]')).toBe(200_000)
  expect(resolveModelContextWindow('minimax', 'MiniMax-M3[1m]')).toBe(200_000)
  expect(resolveModelContextWindow('anthropic', 'future-claude[1m]')).toBe(200_000)
})
it('uses the conservative fallback for an unknown live-fetched model but not a missing id', () => {
  expect(resolveModelContextWindow('openai', 'totally-unknown-model')).toBe(200_000)
  expect(resolveModelContextWindow('anthropic', undefined)).toBeUndefined()
})
it('uses the configured size and falls back to 200k when the user leaves it blank', () => {
  expect(resolveCustomModelContextWindow(64_000)).toBe(64_000)
  expect(resolveCustomModelContextWindow(undefined)).toBe(200_000)
})
it.each([
  ['openai', undefined, 'gpt-5.6-sol'],
  ['anthropic', undefined, 'claude-opus-5'],
  ['opencode-go', undefined, 'kimi-k2.7-code'],
  ['opencode', undefined, 'kimi-k2.7-code'],
  ['nvidia', undefined, 'nvidia/nemotron-3.5-lightning-30b-a3b'],
  ['deepseek', undefined, 'deepseek-v4-pro'],
  ['glmcodingplan', undefined, 'glm-5.3'],
  ['xai', undefined, 'grok-4.7'],
  ['zhipu', undefined, 'glm-5.3'],
  ['openrouter', undefined, 'anthropic/claude-opus-5'],
  ['requesty', undefined, 'anthropic/claude-sonnet-5'],
  ['xiaomimimo', undefined, 'mimo-v2.6-pro'],
  ['sensenova', 'global', 'sensenova-6.8-flash-lite'],
  ['sensenova', undefined, 'sensenova-6.8-flash-lite'],
  ['volcengine', undefined, 'doubao-seed-2-1-pro-260915'],
  ['tencent', undefined, 'hy4-preview'],
  ['tencentcodingplan', undefined, 'deepseek-v4-flash-202605'],
  ['tencenttokenplan', undefined, 'glm-5.2'],
  ['apodex', undefined, 'apodex-1.1'],
  ['stepfun', undefined, 'step-5-preview'],
  ['bailian', undefined, 'qwen3.8-max'],
  ['bailianplan', undefined, 'qwen3.8-max'],
  ['stepplan', undefined, 'step-5-preview']
] as const)('preserves the initial model for %s/%s', (vendor, region, expected) => {
  expect(defaultVendorModel(vendor, region)).toBe(expected)
})

it('retains DeepSeek compatibility names after discovery without changing other vendors', () => {
  const fetched = ['deepseek-flash', 'deepseek-v4-pro', 'future-model']
  expect(getOfficialVendorModelIds('deepseek', undefined, fetched)).toEqual([
    ...fetched,
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp'
  ])
  expect(fetched).toEqual(['deepseek-flash', 'deepseek-v4-pro', 'future-model'])
  expect(getOfficialVendorModelIds('anthropic', undefined, ['live-model'])).toEqual(['live-model'])
})
it('preserves region discovery policy 1', () => {
  expect(
    getOfficialVendorModelIds('sensenova', 'global', ['deepseek-v4-pro', 'sensenova-u1-fast'])
  ).toEqual(['sensenova-6.8-flash-lite'])
})
it('preserves region discovery policy 2', () => {
  expect(getOfficialVendorModelIds('minimax', 'global', ['discovered-model'])).toEqual([
    'discovered-model'
  ])
})
