import { afterEach, describe, expect, it, vi } from 'vitest'

import { flushDiagnosticsWithTimeout } from './flush'

afterEach(() => {
  vi.useRealTimers()
})

describe('flushDiagnosticsWithTimeout', () => {
  it('reports a completed flush', async () => {
    await expect(flushDiagnosticsWithTimeout(async () => undefined, 50)).resolves.toBe('flushed')
  })

  it('contains a rejected diagnostic sink', async () => {
    await expect(
      flushDiagnosticsWithTimeout(async () => {
        throw new Error('sink failed')
      }, 50)
    ).resolves.toBe('failed')
  })

  it('bounds a stalled diagnostic sink', async () => {
    vi.useFakeTimers()
    const result = flushDiagnosticsWithTimeout(() => new Promise<void>(() => undefined), 50)

    await vi.advanceTimersByTimeAsync(50)

    await expect(result).resolves.toBe('timeout')
  })
})
