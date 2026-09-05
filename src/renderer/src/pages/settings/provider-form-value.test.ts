import { describe, expect, it } from 'vitest'

import {
  PROVIDER_KINDS,
  createEmptyProviderFormValue,
  defaultCustomApiEndpoint,
  defaultProviderKindKey,
  getProviderFormErrors,
  hasProviderFormErrors,
  providerFormApiEndpoints,
  providerFormModelForFramework,
  providerKindPatch,
  selectedKindKey
} from './provider-form-value'

describe('defaultProviderKindKey', () => {
  it('matches the active agent framework to its official vendor', () => {
    expect(defaultProviderKindKey('claude-code')).toBe('official:anthropic')
    expect(defaultProviderKindKey('codex')).toBe('official:openai')
    expect(defaultProviderKindKey('opencode')).toBe('official:deepseek')
    expect(defaultProviderKindKey('codebuddy')).toBe('official:minimax')
  })
})

describe('defaultCustomApiEndpoint', () => {
  it('uses each framework capability set to choose its preferred custom API format', () => {
    expect(defaultCustomApiEndpoint(['anthropic'])).toBe('anthropic')
    expect(defaultCustomApiEndpoint(['anthropic', 'openai'])).toBe('openai')
    expect(defaultCustomApiEndpoint(['responses'])).toBe('responses')
  })

  it('falls back to the legacy Messages API while framework capabilities are unavailable', () => {
    expect(defaultCustomApiEndpoint([])).toBe('anthropic')
  })
})

describe('getProviderFormErrors', () => {
  it('leaves optional thinking controls off for a new custom provider', () => {
    expect(createEmptyProviderFormValue({ type: 'custom' }).reasoningEffortPreset).toBe(
      'unsupported'
    )
  })

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

  it.each([
    ['gateway.example/v1', 'Base URL must be a valid HTTP or HTTPS URL.'],
    ['ftp://gateway.example/v1', 'Base URL must be a valid HTTP or HTTPS URL.'],
    [
      'https://user:password@gateway.example/v1',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?api_key=secret-key',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?token=secret-token',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?secret=secret-value',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?password=secret-password',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?key=secret-key',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?access_key=secret-key',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?auth=secret-token',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?username=researcher',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?secret_key=secret-key',
      'Remove credentials from the Base URL and use the API key field.'
    ],
    [
      'https://gateway.example/v1?signature=signed-credential',
      'Remove credentials from the Base URL and use the API key field.'
    ]
  ])('flags an unsafe custom provider Base URL: %s', (baseUrl, error) => {
    const errors = getProviderFormErrors(
      createEmptyProviderFormValue({
        type: 'custom',
        baseUrl,
        key: 'secret-key',
        model: 'lab-model'
      })
    )

    expect(errors.baseUrl).toBe(error)
    expect(hasProviderFormErrors(errors)).toBe(true)
  })

  it('rejects non-credential query parameters because provider endpoints append paths', () => {
    const errors = getProviderFormErrors(
      createEmptyProviderFormValue({
        type: 'custom',
        baseUrl: 'https://gateway.example/v1?tenant=lab&token_limit=1000',
        key: 'secret-key',
        model: 'lab-model'
      })
    )

    expect(errors.baseUrl).toBe('Base URL must not include query parameters or fragments.')
    expect(hasProviderFormErrors(errors)).toBe(true)
  })

  it('rejects URL fragments because provider endpoints append paths', () => {
    const errors = getProviderFormErrors(
      createEmptyProviderFormValue({
        type: 'custom',
        baseUrl: 'https://gateway.example/v1#fragment',
        key: 'secret-key',
        model: 'lab-model'
      })
    )

    expect(errors.baseUrl).toBe('Base URL must not include query parameters or fragments.')
    expect(hasProviderFormErrors(errors)).toBe(true)
  })

  it('lets an edit keep a stored key by leaving the key blank', () => {
    const errors = getProviderFormErrors(
      createEmptyProviderFormValue({ type: 'custom', baseUrl: 'https://g/v1', model: 'm' }),
      { hasStoredKey: true }
    )

    expect(errors.key).toBeUndefined()
    expect(hasProviderFormErrors(errors)).toBe(false)
  })

  it('never requires fields for a complete custom provider', () => {
    const errors = getProviderFormErrors(
      createEmptyProviderFormValue({
        type: 'custom',
        baseUrl: 'https://g/v1',
        model: 'm',
        key: 'k'
      })
    )

    expect(errors).toEqual({})
    expect(hasProviderFormErrors(errors)).toBe(false)
  })

  it('allows blank model limits and rejects non-positive or fractional values', () => {
    const complete = {
      type: 'custom' as const,
      baseUrl: 'https://g',
      model: 'm',
      key: 'k'
    }

    const fields = [
      ['contextWindow', 'Context window must be a positive whole number of tokens.'],
      ['maxInputTokens', 'Maximum input tokens must be a positive whole number of tokens.'],
      ['maxOutputTokens', 'Maximum output tokens must be a positive whole number of tokens.']
    ] as const

    for (const [field, message] of fields) {
      expect(
        getProviderFormErrors(createEmptyProviderFormValue({ ...complete, [field]: '' }))[field]
      ).toBeUndefined()
      expect(
        getProviderFormErrors(createEmptyProviderFormValue({ ...complete, [field]: '0' }))[field]
      ).toBe(message)
      expect(
        getProviderFormErrors(createEmptyProviderFormValue({ ...complete, [field]: '1.5' }))[field]
      ).toBe(message)
    }
  })
})

describe('provider-kind helpers', () => {
  it('uses owned endpoints for built-in providers and the selected endpoint for custom gateways', () => {
    expect(
      providerFormApiEndpoints(
        createEmptyProviderFormValue({
          type: 'official',
          vendorId: 'kimiforcode',
          apiEndpoint: 'anthropic'
        })
      )
    ).toEqual(['anthropic', 'openai'])
    expect(
      providerFormApiEndpoints(
        createEmptyProviderFormValue({ type: 'custom', apiEndpoint: 'responses' })
      )
    ).toEqual(['responses'])
    expect(
      providerFormApiEndpoints(createEmptyProviderFormValue({ type: 'xai-subscription' }))
    ).toEqual(['anthropic', 'openai', 'responses'])
    expect(
      providerFormApiEndpoints(
        createEmptyProviderFormValue({ type: 'official', vendorId: 'opencode' })
      )
    ).toEqual(['openai'])
    expect(
      providerFormApiEndpoints(
        createEmptyProviderFormValue({
          type: 'official',
          vendorId: 'opencode',
          model: 'claude-opus-5'
        })
      )
    ).toEqual(['anthropic'])
  })

  it('chooses a directly compatible official model before onboarding validation', () => {
    const zen = createEmptyProviderFormValue({ type: 'official', vendorId: 'opencode' })

    expect(providerFormModelForFramework(zen, ['anthropic'])).toBe('claude-fable-5')
    expect(providerFormModelForFramework(zen, ['responses'])).toBe('gpt-5.6-sol')
    expect(providerFormModelForFramework(zen, ['anthropic', 'openai'])).toBe('kimi-k2.7-code')

    const minimax = createEmptyProviderFormValue({
      type: 'official',
      vendorId: 'minimax',
      region: 'global'
    })
    expect(providerFormModelForFramework(minimax, ['openai'])).toBe('MiniMax-M3')
  })

  it('groups each subscription on its own, official vendors under API, and custom under Other', () => {
    const groupKeys = (group: string): string[] =>
      PROVIDER_KINDS.filter((kind) => kind.group === group).map((kind) => kind.key)

    const apiKeys = groupKeys('api')

    expect(apiKeys).toContain('official:deepseek')
    expect(apiKeys).toContain('official:apodex')
    expect(apiKeys).toContain('official:openai')
    expect(apiKeys).toContain('official:tencent')
    expect(apiKeys).toContain('official:tencentcodingplan')
    expect(apiKeys).toContain('official:tencenttokenplan')
    expect(apiKeys).toContain('official:nvidia')
    // The two subscription sign-ins each get their own group, parallel to one another, rather than
    // the Claude one hiding under Official API.
    expect(groupKeys('codex')).toEqual(['codex-subscription'])
    expect(groupKeys('claude')).toEqual(['claude-subscription'])
    expect(apiKeys).not.toContain('claude-subscription')
    expect(groupKeys('other')).toEqual(['custom'])
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
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: ''
    })
    expect(providerKindPatch('official:tencent')).toEqual({
      type: 'official',
      name: 'Tencent TokenHub',
      vendorId: 'tencent',
      region: 'international',
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: ''
    })
    expect(providerKindPatch('official:tencentcodingplan')).toEqual({
      type: 'official',
      name: 'Tencent Coding Plan',
      vendorId: 'tencentcodingplan',
      region: undefined,
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: ''
    })
    expect(providerKindPatch('official:tencenttokenplan')).toEqual({
      type: 'official',
      name: 'Tencent Token Plan',
      vendorId: 'tencenttokenplan',
      region: undefined,
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: ''
    })
  })

  it('seeds the official OpenAI Responses provider without a model input', () => {
    expect(providerKindPatch('official:openai')).toEqual({
      type: 'official',
      name: 'OpenAI',
      vendorId: 'openai',
      region: undefined,
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: ''
    })
    expect(
      selectedKindKey(createEmptyProviderFormValue({ type: 'official', vendorId: 'openai' }))
    ).toBe('official:openai')
  })

  it('clears vendor-only fields when picking custom', () => {
    expect(providerKindPatch('custom')).toEqual({
      type: 'custom',
      apiEndpoint: 'anthropic',
      vendorId: undefined,
      region: undefined,
      model: '',
      contextWindow: '',
      maxInputTokens: '',
      maxOutputTokens: ''
    })
  })

  it('seeds a custom provider with the active framework API format', () => {
    expect(providerKindPatch('custom', 'openai')).toMatchObject({
      type: 'custom',
      apiEndpoint: 'openai'
    })
  })

  it('round-trips a value back to its picker key', () => {
    expect(selectedKindKey(createEmptyProviderFormValue({ type: 'custom' }))).toBe('custom')
    expect(
      selectedKindKey(createEmptyProviderFormValue({ type: 'official', vendorId: 'zhipu' }))
    ).toBe('official:zhipu')
  })
})
