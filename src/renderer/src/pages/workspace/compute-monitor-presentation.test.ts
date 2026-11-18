import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import { formatComputeUptime, totalKernelUptime } from './compute-monitor-presentation'

const english = createInstance()
await english.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {},
  keySeparator: false,
  nsSeparator: false
})

describe('compact Compute uptime', () => {
  it.each([
    [-5, '0s'],
    [0, '0s'],
    [59.99, '59s'],
    [60, '1m'],
    [119, '1m'],
    [3599, '59m'],
    [3600, '1h'],
    [3661, '1h 1m'],
    [86399, '23h 59m'],
    [86400, '1d'],
    [90061, '1d 1h'],
    [276000, '3d 4h']
  ])('formats %s seconds as %s without rounding up', (seconds, expected) => {
    expect(formatComputeUptime(seconds, english.t)).toBe(expected)
  })
  it('sums simultaneous kernel ages and clamps future start times independently', () => {
    expect(
      totalKernelUptime(
        [{ startedAt: 10_000 }, { startedAt: 70_000 }, { startedAt: 200_000 }],
        190_000
      )
    ).toBe(300)
    expect(totalKernelUptime([], 190_000)).toBe(0)
  })
})
