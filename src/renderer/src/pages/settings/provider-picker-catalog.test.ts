import { describe, expect, it } from 'vitest'
import { OFFICIAL_VENDORS } from '@aipoch/providers'

import { LOCAL_MODEL_PRESETS, providerKindPatch } from './provider-form-value'
import { matchesProviderPickerQuery, providerPickerEntries } from './provider-picker-catalog'

const keysMatching = (query: string, entries = providerPickerEntries({})): string[] =>
  entries
    .filter((entry) =>
      matchesProviderPickerQuery(entry, query, entry.label ?? entry.kind?.label ?? '')
    )
    .map((entry) => entry.key)

describe('providerPickerEntries', () => {
  it('lists every official vendor, the custom gateway and the local presets once', () => {
    const keys = providerPickerEntries({}).map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(
      expect.arrayContaining([
        ...OFFICIAL_VENDORS.map((vendor) => `official:${vendor.id}`),
        'custom',
        ...LOCAL_MODEL_PRESETS.map((preset) => `local:${preset.id}`)
      ])
    )
  })

  it('files vendors under sections and shows their console host and region count', () => {
    const entries = new Map(providerPickerEntries({}).map((entry) => [entry.key, entry]))
    expect(entries.get('official:deepseek')).toMatchObject({ category: 'vendor' })
    expect(entries.get('official:glmcodingplan')?.category).toBe('coding-plan')
    expect(entries.get('official:volcengine')?.category).toBe('cloud')
    expect(entries.get('official:openrouter')).toMatchObject({
      category: 'gateway',
      host: 'openrouter.ai'
    })
    expect(entries.get('custom')?.category).toBe('custom')
    expect(entries.get('local:ollama')).toMatchObject({
      category: 'local',
      label: 'Ollama',
      host: 'localhost:11434'
    })
    for (const entry of entries.values()) {
      if (entry.regionCount !== undefined) expect(entry.regionCount).toBeGreaterThan(1)
    }
  })

  it('lists coding plans in picker order', () => {
    const plans = providerPickerEntries({}).filter((entry) => entry.category === 'coding-plan')
    expect(plans.map((entry) => entry.key)).toEqual([
      'official:opencode-go',
      'official:glmcodingplan',
      'official:kimiforcode',
      'official:bailianplan',
      'official:stepplan',
      'official:tencentcodingplan',
      'official:tencenttokenplan'
    ])
  })

  it('offers subscriptions only for the frameworks that support them', () => {
    const keys = (availability: Parameters<typeof providerPickerEntries>[0]): string[] =>
      providerPickerEntries(availability)
        .filter((entry) => entry.category === 'sign-in')
        .map((entry) => entry.key)

    expect(keys({})).toEqual(['xai-subscription'])
    expect(keys({ showCodexSubscriptions: true })).toEqual([
      'codex-subscription',
      'xai-subscription'
    ])
    expect(keys({ showClaudeIsolated: true })).toEqual(['claude-subscription', 'xai-subscription'])
    const codeBuddy = providerPickerEntries({ codeBuddyProviders: ['builtin-codebuddy-china'] })
    expect(codeBuddy.find((entry) => entry.key === 'builtin-codebuddy-china')?.disabled).toBe(true)
    expect(
      codeBuddy.find((entry) => entry.key === 'builtin-codebuddy-international')?.disabled
    ).toBe(false)
  })
})

describe('matchesProviderPickerQuery', () => {
  it('matches names, hosts and local-language aliases ignoring case and spaces', () => {
    expect(keysMatching('DeepSeek')).toContain('official:deepseek')
    expect(keysMatching('openrouter.ai')).toEqual(['official:openrouter'])
    expect(keysMatching('智谱')).toEqual(
      expect.arrayContaining(['official:zhipu', 'official:glmcodingplan'])
    )
    expect(keysMatching('月之暗面')).toEqual(
      expect.arrayContaining(['official:kimi', 'official:kimiforcode'])
    )
    expect(keysMatching('lm studio')).toEqual(['local:lmstudio'])
    expect(keysMatching('no-such-provider')).toEqual([])
  })

  it('matches the translated label the user sees', () => {
    const custom = providerPickerEntries({}).find((entry) => entry.key === 'custom')!
    expect(matchesProviderPickerQuery(custom, '自定义', '自定义网关')).toBe(true)
  })

  it('matches everything for a blank query', () => {
    expect(keysMatching('  ')).toHaveLength(providerPickerEntries({}).length)
  })
})

describe('providerKindPatch for local presets', () => {
  it('seeds a custom chat-completions provider pointed at the local server', () => {
    expect(providerKindPatch('local:vllm', 'messages')).toMatchObject({
      type: 'custom',
      name: 'vLLM',
      baseUrl: 'http://localhost:8000',
      apiEndpoint: 'chat-completions'
    })
  })
})
