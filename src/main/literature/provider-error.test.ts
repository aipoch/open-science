import { expect, it } from 'vitest'
import { literatureFailure, LiteratureProviderError } from './provider-error'

it.each([
  [new LiteratureProviderError(401), 'authentication', false],
  [new LiteratureProviderError(429), 'rate-limit', true],
  [new LiteratureProviderError(503), 'network', true],
  [new LiteratureProviderError(404), 'no-result', false],
  [new DOMException('secret response', 'TimeoutError'), 'timeout', true],
  [Object.assign(new Error('secret host'), { code: 'ENOTFOUND' }), 'network', true],
  [new Error('Reference unavailable'), 'unavailable', false],
  [new Error('Reference changed'), 'conflict', true],
  [new Error('https://private/?api_key=secret'), 'unknown', true],
  [null, 'unknown', true]
] as const)(
  'classifies failures without exposing provider content: %s',
  (error, code, retryable) => {
    const failure = literatureFailure(error, 'search', 'openalex')
    expect(failure).toEqual({
      code,
      retryable,
      phase: 'search',
      source: ['unavailable', 'conflict'].includes(code) ? 'catalog' : 'openalex'
    })
    expect(JSON.stringify(failure)).not.toMatch(/secret|https/)
  }
)
