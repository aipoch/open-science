import { describe, expect, it } from 'vitest'

import {
  PROVIDER_KINDS,
  createEmptyProviderFormValue,
  defaultProviderKindKey,
  getProviderFormErrors,
  hasProviderFormErrors,
  providerKindPatch,
  selectedKindKey
} from './provider-form-value'

describe('defaultProviderKindKey', () => {
  it('matches the active agent framework to its official vendor', () => {
    expect(defaultProviderKindKey('claude-code')).toBe('official:anthropic')
    expect(defaultProviderKindKey('codex')).toBe('official:openai')
    expect(defaultProviderKindKey('opencode')).toBe('official:deepseek')
  })
})

describe('getProviderFormErrors', () => {
  it('flags every missing required field for a new custom provider', () => {
    const errors = getProviderFormErrors(createEmptyProviderFormValue({ type: 'custom' }))

    expect(errors).toEqual({
      baseUrl: 'Base URL is required.',
      key: 'API key is required.',
      model: 'Model is required.'
    })
    expect(hasProviderFormErrors(errors)).toBe(true)
  })

  it('has no errors once a custom provider is fully filled', () => {
    const errors = getProviderFormErrors(
      createEmptyProviderFormValue({
        type: 'custom',
        baseUrl: 'https://g/v1',
        key: 'sk-key',
        model: 'claude-sonnet-4-5'
      })
    )

    expect(errors).toEqual({})
    expect(hasProviderFormErrors(errors)).toBe(false)
  })

  it('lets an edit keep a stored key by leaving the key blank', () => {
    const errors = getProviderFormErrors(
      createEmptyProviderFormValue({ type: 'custom', baseUrl: 'https://g/v1', model: 'm' }),
      { hasStoredKey: true }
    )

    expect(errors.key).toBeUndefined()
    expect(hasProviderFormErrors(errors)).toBe(false)
  })

  it('never requires fields for a local-claude provider', () => {
    const errors = getProviderFormErrors(createEmptyProviderFormValue({ type: 'claude-default' }))

    expect(errors).toEqual({})
    expect(hasProviderFormErrors(errors)).toBe(false)
  })
})

describe('provider-kind helpers', () => {
  it('lists official vendors under the API group and custom/local under Other', () => {
    const codingKeys = PROVIDER_KINDS.filter((kind) => kind.group === 'coding').map(
      (kind) => kind.key
    )
    const apiKeys = PROVIDER_KINDS.filter((kind) => kind.group === 'api').map((kind) => kind.key)
    const otherKeys = PROVIDER_KINDS.filter((kind) => kind.group === 'other').map(
      (kind) => kind.key
    )

    expect(apiKeys).toContain('official:deepseek')
    expect(apiKeys).toContain('official:openai')
    expect(codingKeys).toEqual(['codex-subscription'])
    expect(otherKeys).toEqual(['custom', 'claude-default'])
  })

  it('uses one provider kind while keeping the auth mode in the form value', () => {
    expect(providerKindPatch('codex-subscription')).toMatchObject({
      type: 'codex-shared',
      name: 'Codex subscription',
      apiEndpoint: 'responses'
    })
    expect(selectedKindKey(createEmptyProviderFormValue({ type: 'codex-shared' }))).toBe(
      'codex-subscription'
    )
    expect(selectedKindKey(createEmptyProviderFormValue({ type: 'codex-isolated' }))).toBe(
      'codex-subscription'
    )
  })

  it('seeds region (no per-provider model) when picking an official vendor', () => {
    expect(providerKindPatch('official:minimax')).toEqual({
      type: 'official',
      name: 'MiniMax',
      vendorId: 'minimax',
      region: 'global',
      model: ''
    })
  })

  it('seeds the official OpenAI Responses provider without a model input', () => {
    expect(providerKindPatch('official:openai')).toEqual({
      type: 'official',
      name: 'OpenAI',
      vendorId: 'openai',
      region: undefined,
      model: ''
    })
    expect(
      selectedKindKey(createEmptyProviderFormValue({ type: 'official', vendorId: 'openai' }))
    ).toBe('official:openai')
  })

  it('clears vendor-only fields when picking custom or local', () => {
    expect(providerKindPatch('custom')).toEqual({
      type: 'custom',
      vendorId: undefined,
      region: undefined,
      model: ''
    })
    expect(providerKindPatch('claude-default')).toEqual({
      type: 'claude-default',
      vendorId: undefined,
      region: undefined,
      model: ''
    })
  })

  it('round-trips a value back to its picker key', () => {
    expect(selectedKindKey(createEmptyProviderFormValue({ type: 'custom' }))).toBe('custom')
    expect(selectedKindKey(createEmptyProviderFormValue({ type: 'claude-default' }))).toBe(
      'claude-default'
    )
    expect(
      selectedKindKey(createEmptyProviderFormValue({ type: 'official', vendorId: 'zhipu' }))
    ).toBe('official:zhipu')
  })
})
