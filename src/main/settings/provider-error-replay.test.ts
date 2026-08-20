import { describe, expect, it } from 'vitest'

import {
  DeterministicProviderErrorReplay,
  isDeterministicProviderErrorStatus,
  providerErrorClientStatus,
  providerRequestFingerprint,
  providerRequestHeadersFingerprint,
  readBoundedProviderErrorBody
} from './provider-error-replay'

describe('provider error replay policy', () => {
  it.each([
    400, 401, 402, 403, 404, 405, 406, 407, 410, 411, 413, 414, 415, 416, 417, 421, 422, 426, 428,
    431, 451
  ])('classifies explicit status %i as deterministic', (status) => {
    expect(isDeterministicProviderErrorStatus(status)).toBe(true)
    expect(providerErrorClientStatus(status)).toBe(400)
  })

  it.each([200, 301, 408, 409, 418, 423, 424, 425, 429, 500, 503])(
    'preserves retry semantics for status %i',
    (status) => {
      expect(isDeterministicProviderErrorStatus(status)).toBe(false)
      expect(providerErrorClientStatus(status)).toBe(status)
    }
  )

  it('replays only a matching, unexpired deterministic error', () => {
    let now = 100
    const cache = new DeterministicProviderErrorReplay<string>(50, 2, () => now)
    const key = providerRequestFingerprint('provider-a', '{"input":"same"}')

    expect(cache.remember(key, 401, 'cached')).toBe(true)
    expect(cache.get(key)).toBe('cached')
    expect(cache.get(providerRequestFingerprint('provider-a', '{"input":"different"}'))).toBe(
      undefined
    )
    expect(cache.remember('transient', 429, 'not-cached')).toBe(false)
    expect(cache.get('transient')).toBe(undefined)

    now = 150
    expect(cache.get(key)).toBe(undefined)
  })

  it('keeps the replay cache bounded and clearable', () => {
    const cache = new DeterministicProviderErrorReplay<string>(1_000, 2)
    cache.remember('first', 401, 'first')
    cache.remember('second', 403, 'second')
    cache.get('first')
    cache.remember('third', 404, 'third')

    expect(cache.get('second')).toBe(undefined)
    expect(cache.get('first')).toBe('first')
    expect(cache.get('third')).toBe('third')
    cache.clear()
    expect(cache.get('first')).toBe(undefined)
  })

  it('fingerprints forwarded headers independently of name casing and insertion order', () => {
    const first = new Headers([
      ['Anthropic-Version', '2023-06-01'],
      ['Anthropic-Beta', 'feature-a']
    ])
    const reordered = {
      'anthropic-beta': 'feature-a',
      'anthropic-version': '2023-06-01'
    }

    expect(providerRequestHeadersFingerprint(first)).toBe(
      providerRequestHeadersFingerprint(reordered)
    )
    expect(
      providerRequestHeadersFingerprint({ ...reordered, 'anthropic-beta': 'feature-b' })
    ).not.toBe(providerRequestHeadersFingerprint(first))
  })

  it('cancels a deterministic error body as soon as it exceeds the byte limit', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(8))
        },
        cancel() {
          cancelled = true
        }
      }),
      { status: 401 }
    )

    await expect(
      readBoundedProviderErrorBody(response, { maxBytes: 10, timeoutMs: 1_000 })
    ).resolves.toEqual({ body: Buffer.alloc(0), complete: false })
    expect(cancelled).toBe(true)
  })

  it('cancels a deterministic error body that does not finish', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        }
      }),
      { status: 401 }
    )

    await expect(
      readBoundedProviderErrorBody(response, { maxBytes: 10, timeoutMs: 5 })
    ).resolves.toEqual({ body: Buffer.alloc(0), complete: false })
    expect(cancelled).toBe(true)
  })
})
