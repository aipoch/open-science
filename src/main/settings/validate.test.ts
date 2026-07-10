import { describe, expect, it, vi } from 'vitest'

import {
  buildValidationRequest,
  classifyFetchError,
  classifyStatus,
  validateProvider
} from './validate'

describe('validate: request construction', () => {
  it('builds a bearer /v1/messages probe with anthropic-version and a 1-token body', () => {
    const request = buildValidationRequest({
      type: 'custom',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      key: 'test-token'
    })

    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.headers.authorization).toBe('Bearer test-token')
    expect(request.headers['anthropic-version']).toBe('2023-06-01')
    expect(JSON.parse(request.body)).toMatchObject({ model: 'claude-sonnet-4-5', max_tokens: 1 })
  })

  it('normalizes a base URL that already carries /v1 so the probe never doubles it', () => {
    const request = buildValidationRequest({
      type: 'custom',
      baseUrl: 'https://api.anthropic.com/v1',
      key: 'test-token'
    })

    expect(request.headers.authorization).toBe('Bearer test-token')
    // Custom providers never send an x-api-key header.
    expect(request.headers['x-api-key']).toBeUndefined()
    // A user-supplied trailing /v1 (and/or slash) must resolve to a single /v1/messages, not two.
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
  })

  it('throws for a missing or unparseable base URL', () => {
    expect(() => buildValidationRequest({ type: 'custom' })).toThrow(/missing base url/i)
    expect(() => buildValidationRequest({ type: 'custom', baseUrl: 'not a url' })).toThrow(
      /invalid base url/i
    )
  })
})

describe('validate: classification', () => {
  it('maps status codes to categories', () => {
    expect(classifyStatus(200)).toBe('ok')
    expect(classifyStatus(401)).toBe('auth')
    expect(classifyStatus(403)).toBe('auth')
    expect(classifyStatus(404)).toBe('model-not-found')
    expect(classifyStatus(400)).toBe('model-not-found')
    expect(classifyStatus(500)).toBe('unknown')
  })

  it('maps thrown errors to categories', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'

    expect(classifyFetchError(abort)).toBe('timeout')
    expect(classifyFetchError(new Error('Invalid base URL.'))).toBe('bad-url')
    expect(classifyFetchError(new Error('fetch failed'))).toBe('network')
  })
})

describe('validate: provider dispatch', () => {
  it('returns ok for a 200 custom response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 } as Response)

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://g/v1', key: 'k', model: 'm' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({ ok: true, category: 'ok', status: 200 })
  })

  it('classifies a 401 custom response as auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 401 } as Response)

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://g/v1', key: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result).toMatchObject({ ok: false, category: 'auth', status: 401 })
  })

  it('classifies a thrown fetch as network', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'))

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'https://g/v1', key: 'k' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result.category).toBe('network')
  })

  it('reports bad-url before any fetch is attempted', async () => {
    const fetchImpl = vi.fn()

    const result = await validateProvider(
      { type: 'custom', baseUrl: 'nonsense' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )

    expect(result.category).toBe('bad-url')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('runs the claude probe for claude-default providers', async () => {
    const okResult = await validateProvider(
      { type: 'claude-default' },
      { runClaudeProbe: () => Promise.resolve({ ok: true }) }
    )
    const failResult = await validateProvider(
      { type: 'claude-default' },
      { runClaudeProbe: () => Promise.resolve({ ok: false }) }
    )

    expect(okResult).toMatchObject({ ok: true, category: 'ok' })
    expect(failResult).toMatchObject({ ok: false, category: 'auth' })
  })

  it('classifies a claude-default probe timeout as timeout, not auth', async () => {
    const result = await validateProvider(
      { type: 'claude-default' },
      { runClaudeProbe: () => Promise.resolve({ ok: false, timedOut: true }) }
    )

    expect(result).toMatchObject({ ok: false, category: 'timeout' })
  })
})
