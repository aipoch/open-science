import { describe, expect, it } from 'vitest'

import {
  getLabServerUrlError,
  joinLabBaseUrl,
  labModelIdFromBootstrap,
  labModelLabel,
  labModelSummaries,
  labModelWireId,
  labProtocolsToEndpoints,
  mapLabGatewayError,
  readLabModelCapabilities,
  readLabUsage
} from './lab'

describe('Lab shared contract', () => {
  it('requires https for a non-loopback server and allows loopback http for development', () => {
    expect(getLabServerUrlError('')).toBe('server-url-missing')
    expect(getLabServerUrlError('lab.example.com')).toBe('server-url-invalid')
    expect(getLabServerUrlError('http://lab.example.com')).toBe('server-url-insecure')
    expect(getLabServerUrlError('https://lab.example.com')).toBeUndefined()
    expect(getLabServerUrlError('HTTPS://lab.example.com')).toBeUndefined()
    expect(getLabServerUrlError('HTTP://lab.example.com')).toBe('server-url-insecure')
    expect(getLabServerUrlError('http://127.0.0.1:8080')).toBeUndefined()
    expect(getLabServerUrlError('http://127.0.0.2:8080')).toBe('server-url-insecure')
  })

  it('rejects query strings, fragments and embedded credentials', () => {
    expect(getLabServerUrlError('https://lab.example.com/?foo=1')).toBe('server-url-query')
    expect(getLabServerUrlError('https://lab.example.com/#x')).toBe('server-url-query')
    expect(getLabServerUrlError('https://user:pass@lab.example.com')).toBe('server-url-credentials')
    expect(getLabServerUrlError('https://lab.example.com/?token=1')).toBe('server-url-credentials')
  })

  it('namespaces model ids without changing the wire id', () => {
    expect(labModelIdFromBootstrap('research-default')).toBe('lab:research-default')
    expect(labModelIdFromBootstrap('lab:research-default')).toBe('lab:lab:research-default')
    expect(labModelWireId('lab:research-default')).toBe('research-default')
    expect(labModelWireId('lab:lab:research-default')).toBe('lab:research-default')
    expect(labModelWireId('research-default')).toBe('research-default')
    expect(labModelLabel('lab:research-default')).toBe('research-default')
  })

  it('maps bootstrap protocols to desktop routes', () => {
    expect(labProtocolsToEndpoints({ id: 'a', protocol: 'openai' })).toEqual(['chat-completions'])
    expect(labProtocolsToEndpoints({ id: 'a', protocols: ['openai', 'openai-response'] })).toEqual([
      'chat-completions',
      'responses'
    ])
    expect(labProtocolsToEndpoints({ id: 'a', protocols: ['anthropic'] })).toEqual(['messages'])
    expect(labProtocolsToEndpoints({ id: 'a', protocols: ['gemini'] })).toEqual([])
    expect(labProtocolsToEndpoints({ id: 'a', protocols: [] })).toEqual([])
    expect(labProtocolsToEndpoints({ id: 'a', protocol: '' })).toEqual([])
    expect(labProtocolsToEndpoints({ id: 'a' })).toEqual(['chat-completions'])
  })

  it('joins the server address and the bootstrap model base url', () => {
    expect(joinLabBaseUrl('https://lab.example.com/', '/v1')).toBe('https://lab.example.com/v1')
    expect(joinLabBaseUrl('https://lab.example.com', 'v1')).toBe('https://lab.example.com/v1')
    expect(joinLabBaseUrl('https://lab.example.com', 'https://lab.example.com/v1')).toBe(
      'https://lab.example.com/v1'
    )
    expect(() => joinLabBaseUrl('https://lab.example.com', 'https://gw.example.com/v1')).toThrow(
      'must stay on the configured deployment'
    )
  })

  it('keeps available models and their advertised protocols in the status summary', () => {
    const models = labModelSummaries([
      {
        id: 'a',
        name: 'A',
        protocol: 'openai',
        available: true,
        pricing: { multiplier: 1.09, free: false }
      },
      { id: 'lab:a' },
      { id: 'b', name: 'B', protocol: 'openai', enabled: false },
      { id: 'c', name: 'C', protocol: 'openai-response', available: false },
      { id: 'haiku', protocol: 'anthropic' },
      { id: 'gemini', protocol: 'gemini', protocols: ['gemini'] }
    ])
    expect(models.map((model) => model.id)).toEqual([
      'lab:a',
      'lab:lab:a',
      'lab:haiku',
      'lab:gemini'
    ])
    expect(models[0]?.protocols).toEqual(['openai'])
    expect(models[2]?.protocols).toEqual(['anthropic'])
    expect(models[3]?.protocols).toEqual(['gemini'])
    expect(models[0]?.pricing).toEqual({ multiplier: 1.09, free: false })
    expect(models[1]).not.toHaveProperty('pricing')
    expect(models[1]?.protocols).toEqual(['chat-completions'])
  })
})

describe('readLabModelCapabilities', () => {
  it('keeps known effort values, modalities and limits', () => {
    expect(
      readLabModelCapabilities({
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        modalities: { input: ['text', ' image ', 'text'] },
        limit: { context: 1_000_000, output: 64_000 }
      })
    ).toEqual({
      reasoningValues: ['low', 'high', 'max'],
      inputModalities: ['text', 'image'],
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000
    })
  })

  it('supports a toggle-only reasoning profile', () => {
    expect(readLabModelCapabilities({ reasoning_options: [{ type: 'toggle' }] })).toEqual({
      reasoningToggle: true,
      inputModalities: []
    })
  })

  it('returns an empty profile for an empty capability object', () => {
    expect(readLabModelCapabilities({})).toEqual({ inputModalities: [] })
  })

  it('drops malformed values and unknown effort levels', () => {
    expect(
      readLabModelCapabilities({
        reasoning_options: [{ type: 'effort', values: ['low', 'turbo', 3, 'max'] }],
        modalities: { input: ['image', 4, ''] },
        limit: { context: '1000', output: -1 }
      })
    ).toEqual({
      reasoningValues: ['low', 'max'],
      inputModalities: ['image']
    })
    expect(readLabModelCapabilities('not-an-object')).toBeUndefined()
    expect(readLabModelCapabilities(undefined)).toBeUndefined()
  })
})

describe('readLabUsage', () => {
  const snapshot = {
    scale: 1000,
    org_wallet: { balance_mp: 850_000 },
    member_allowance: { unlimited: false, limit_mp: 200_000, remaining_mp: 155_125 },
    effective: { remaining_mp: 155_125, limited_by: 'member' }
  }

  it('converts milli-points using the scale in the snapshot', () => {
    expect(readLabUsage(snapshot)).toEqual({
      organizationBalance: 850,
      memberAllowance: { limit: 200, remaining: 155.125 },
      availablePoints: 155.125
    })
    expect(readLabUsage({ ...snapshot, scale: 100 })?.availablePoints).toBe(1551.25)
  })

  it('preserves a negative wallet balance and an unlimited member allowance', () => {
    expect(
      readLabUsage({
        ...snapshot,
        org_wallet: { balance_mp: -5 },
        member_allowance: { unlimited: true, limit_mp: null, remaining_mp: null },
        effective: { remaining_mp: 0, limited_by: 'org' }
      })
    ).toEqual({ organizationBalance: -0.005, memberAllowance: null, availablePoints: 0 })
  })

  it.each([
    { ...snapshot, scale: 0 },
    { ...snapshot, scale: 1.5 },
    { ...snapshot, org_wallet: { balance_mp: '850000' } },
    { ...snapshot, effective: { remaining_mp: -1 } },
    { ...snapshot, member_allowance: { unlimited: false, limit_mp: null, remaining_mp: null } },
    { available: true, token: { available: true } }
  ])('rejects an invalid or legacy points snapshot %#', (body) => {
    expect(readLabUsage(body)).toBeUndefined()
  })
})

describe('mapLabGatewayError', () => {
  it.each([
    [
      404,
      'model_not_found',
      'The model has no available upstream channel right now (it may not be published or its channel may be disabled).'
    ],
    [402, 'insufficient_quota', 'The upstream subscription or quota is exhausted.'],
    [402, 'INSUFFICIENT_POINTS', 'Your organization has insufficient Lab points.'],
    [402, 'MEMBER_LIMIT_REACHED', 'You have reached your Lab points allowance for this period.'],
    [403, 'MODEL_NOT_PRICED', 'This Lab model does not have pricing configured.'],
    [400, 'context_length_exceeded', 'The context exceeds the model context window.'],
    [
      402,
      'UPSTREAM_TOKEN_INVALID',
      'This model key is invalid or out of quota. Ask an admin to top it up, then enable it.'
    ],
    [
      401,
      'authentication_error',
      'The upstream credential is invalid. Check the Lab channel configuration.'
    ],
    [
      403,
      'invalid_api_key',
      'The upstream credential is invalid. Check the Lab channel configuration.'
    ],
    [429, 'UPSTREAM_RATE_LIMITED', 'Too many Lab requests. Try again in a moment.'],
    [
      502,
      'UPSTREAM_ERROR',
      'The Lab server could not reach the model provider. Check the Lab channel status.'
    ]
  ] as const)('maps Lab gateway code %s to an actionable error', (status, code, message) => {
    expect(mapLabGatewayError(status, { error: { code } })).toEqual({ code, message })
  })

  it('keeps the Lab sign-in fallback and leaves unknown codes unmapped', () => {
    expect(mapLabGatewayError(401, { error: { message: 'expired' } })).toEqual({
      code: 'unauthorized',
      message: 'Your Lab sign-in expired. Sign in again.'
    })
    expect(mapLabGatewayError(502, { error: { code: 'UNKNOWN_CODE' } })).toBeUndefined()
    expect(mapLabGatewayError(502, 'not-an-object')).toBeUndefined()
  })
})
