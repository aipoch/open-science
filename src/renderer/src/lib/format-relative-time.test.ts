import { describe, expect, it } from 'vitest'

import { relativeTimeParts } from './format-relative-time'

const NOW = 1_800_000_000_000
const day = 24 * 60 * 60 * 1000

describe('relativeTimeParts', () => {
  it('picks the right bucket for sub-minute, minute, hour, day, and week ranges', () => {
    expect(relativeTimeParts(NOW - 10_000, NOW)).toEqual({ unit: 'now', count: 0 })
    expect(relativeTimeParts(NOW - 5 * 60 * 1000, NOW)).toEqual({ unit: 'minute', count: 5 })
    expect(relativeTimeParts(NOW - 3 * 60 * 60 * 1000, NOW)).toEqual({ unit: 'hour', count: 3 })
    expect(relativeTimeParts(NOW - 3 * day, NOW)).toEqual({ unit: 'day', count: 3 })
    expect(relativeTimeParts(NOW - 21 * day, NOW)).toEqual({ unit: 'week', count: 3 })
  })

  it('does not report a zero year for the 360-364 day gap between the month and year buckets', () => {
    // Regression: with `months < 12` the /30 approximation made 360-364 days fall through to days/365 = 0.
    expect(relativeTimeParts(NOW - 360 * day, NOW)).toEqual({ unit: 'month', count: 12 })
    expect(relativeTimeParts(NOW - 364 * day, NOW)).toEqual({ unit: 'month', count: 12 })
    expect(relativeTimeParts(NOW - 365 * day, NOW)).toEqual({ unit: 'year', count: 1 })
    expect(relativeTimeParts(NOW - 400 * day, NOW)).toEqual({ unit: 'year', count: 1 })
  })

  it('never reports a zero count for a just-crossed minute boundary', () => {
    // 45-59s is past the 'now' cutoff but floors to 0 minutes; the bucket clamps it to 1.
    expect(relativeTimeParts(NOW - 50_000, NOW)).toEqual({ unit: 'minute', count: 1 })
  })

  it('treats a future timestamp as now rather than counting backwards', () => {
    expect(relativeTimeParts(NOW + 10 * day, NOW)).toEqual({ unit: 'now', count: 0 })
  })
})
