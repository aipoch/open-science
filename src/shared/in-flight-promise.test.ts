import { describe, expect, it } from 'vitest'

import { isCurrentInFlight } from './in-flight-promise'

describe('isCurrentInFlight', () => {
  it('matches the same promise object and rejects a later replacement', async () => {
    const first = Promise.resolve('first')
    const second = Promise.resolve('second')
    expect(isCurrentInFlight(first, first)).toBe(true)
    expect(isCurrentInFlight(second, first)).toBe(false)
    expect(isCurrentInFlight(undefined, first)).toBe(false)
    await expect(first).resolves.toBe('first')
  })
})
