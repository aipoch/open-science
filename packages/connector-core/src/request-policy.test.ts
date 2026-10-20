import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CONNECTOR_RETRYABLE_STATUS,
  boundedExponentialBackoff,
  connectorRetryDelay,
  withTimeoutSignal
} from './request-policy'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Connector request policy', () => {
  it('shares the bounded transient-status and exponential-backoff policy', () => {
    expect([...CONNECTOR_RETRYABLE_STATUS]).toEqual([429, 500, 502, 503, 504])
    expect(boundedExponentialBackoff(0)).toBe(400)
    expect(boundedExponentialBackoff(4)).toBe(4_000)
  })

  it('honors numeric Retry-After before falling back to jittered backoff', () => {
    expect(connectorRetryDelay(0, '2')).toBe(2_000)
    expect(connectorRetryDelay(0, '30')).toBe(30_000)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(connectorRetryDelay(2, null, 200)).toBe(900)
  })

  it('owns and clears the timeout around a request signal', async () => {
    vi.useFakeTimers()
    await expect(
      withTimeoutSignal(1_000, undefined, async (signal) => {
        expect(signal.aborted).toBe(false)
        return 'done'
      })
    ).resolves.toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a pending request at the owned deadline', async () => {
    vi.useFakeTimers()
    const pending = withTimeoutSignal(
      1_000,
      undefined,
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1_000)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
})
