import { describe, expect, it } from 'vitest'

import { formatRelativeTime } from './format-relative-time'

const NOW = 1_800_000_000_000
const day = 24 * 60 * 60 * 1000

describe('formatRelativeTime', () => {
  it('formats sub-minute, minute, hour, and day ranges', () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe('now')
    expect(formatRelativeTime(NOW - 5 * 60 * 1000, NOW)).toBe('5m')
    expect(formatRelativeTime(NOW - 3 * 60 * 60 * 1000, NOW)).toBe('3h')
    expect(formatRelativeTime(NOW - 3 * day, NOW)).toBe('3d')
    expect(formatRelativeTime(NOW - 21 * day, NOW)).toBe('3w')
  })

  it('does not render "0y" for the 360-364 day gap between the month and year buckets', () => {
    // Regression: with `months < 12` the /30 approximation made 360-364 days fall through to days/365 = 0.
    expect(formatRelativeTime(NOW - 360 * day, NOW)).toBe('12mo')
    expect(formatRelativeTime(NOW - 364 * day, NOW)).toBe('12mo')
    expect(formatRelativeTime(NOW - 365 * day, NOW)).toBe('1y')
    expect(formatRelativeTime(NOW - 400 * day, NOW)).toBe('1y')
  })
})
