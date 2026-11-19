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

  it('maps bootstrap protocols to the two gateway routes only', () => {
    expect(labProtocolsToEndpoints({ id: 'a', protocol: 'openai' })).toEqual(['chat-completions'])
    expect(labProtocolsToEndpoints({ id: 'a', protocols: ['openai', 'openai-response'] })).toEqual([
      'chat-completions',
      'responses'
    ])
    expect(labProtocolsToEndpoints({ id: 'a', protocols: ['anthropic'] })).toEqual([])
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

  it('limits the status summary to available models with a usable gateway route', () => {
    const models = labModelSummaries([
      { id: 'a', name: 'A', protocol: 'openai', available: true },
      { id: 'lab:a' },
      { id: 'b', name: 'B', protocol: 'openai', enabled: false },
      { id: 'c', name: 'C', protocol: 'openai-response', available: false },
      { id: 'unsupported', protocol: 'anthropic' }
    ])
    expect(models.map((model) => model.id)).toEqual(['lab:a', 'lab:lab:a'])
    expect(models[0]?.protocols).toEqual(['chat-completions'])
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
  it('narrows token, organization, effective and display amounts', () => {
    const usage = readLabUsage({
      available: true,
      token: {
        available: true,
        name: 'osl:usr_1:1',
        status: 'active',
        quota: { limit: 500_000, used: 165_900, remaining: 334_100, unlimited: false }
      },
      org: {
        available: true,
        unlimited: false,
        quota: { limit: 69_349_151, used: 166_271, remaining: 69_268_880, unlimited: false },
        stale: true,
        synced_at: '2026-11-16T08:40:00Z'
      },
      effective: { remaining: 334_100, limited_by: 'token' },
      display: {
        per_unit: 500_000,
        exchange_rate: 7.3,
        currency: 'CNY',
        cny: {
          token: { limit: 7.3, used: 2.42, remaining: 4.88 },
          org: { limit: 1_012.3, used: 2.43, remaining: 1_009.87 }
        },
        usd: {
          token: { limit: 1, used: 0.3318, remaining: 0.6682 },
          org: { limit: 138.7, used: 0.33, remaining: 138.37 }
        }
      },
      fetched_at: '2026-11-16T08:40:00Z',
      stale: false
    })
    expect(usage).toMatchObject({
      available: true,
      token: { available: true, status: 'active', quota: { remaining: 334_100 } },
      org: { unlimited: false, stale: true, syncedAt: '2026-11-16T08:40:00Z' },
      effective: { remaining: 334_100, limitedBy: 'token' },
      display: { currency: 'CNY', cny: { token: { remaining: 4.88 } } },
      fetchedAt: '2026-11-16T08:40:00Z',
      stale: false
    })
  })

  it.each([
    [
      404,
      'model_not_found',
      'The model has no available upstream channel right now (it may not be published or its channel may be disabled).'
    ],
    [402, 'insufficient_quota', 'The upstream subscription or quota is exhausted.'],
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

  it('preserves unavailable responses and drops malformed nested values', () => {
    expect(readLabUsage({ available: false, reason: '额度查询未启用' })).toMatchObject({
      available: false,
      reason: '额度查询未启用',
      token: { available: false },
      org: { available: false, unlimited: false, stale: false }
    })
    expect(readLabUsage('invalid')).toBeUndefined()
  })
})
