import { describe, expect, it } from 'vitest'

import { SpeedMeter } from './download-speed'

describe('SpeedMeter', () => {
  const clock = (start = 0): { now: () => number; advance: (ms: number) => number } => {
    let t = start
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it('returns 0 before two samples', () => {
    const c = clock()
    const m = new SpeedMeter({ now: c.now })
    m.record(0)
    expect(m.bytesPerSecond()).toBe(0)
  })

  it('averages bytes over the sliding window', () => {
    const c = clock()
    const m = new SpeedMeter({ windowMs: 3000, now: c.now })
    m.record(0)
    c.advance(1000)
    m.record(1_000_000) // 1 MB in 1s
    expect(m.bytesPerSecond()).toBeCloseTo(1_000_000, -3)
  })

  it('drops samples older than the window', () => {
    const c = clock()
    const m = new SpeedMeter({ windowMs: 2000, now: c.now })
    m.record(0)
    c.advance(5000)
    m.record(5_000_000) // old sample evicted — only this one remains
    c.advance(1000)
    m.record(6_000_000) // 1 MB in last 1s
    expect(m.bytesPerSecond()).toBeCloseTo(1_000_000, -3)
  })

  it('computes ETA from remaining bytes and speed', () => {
    const c = clock()
    const m = new SpeedMeter({ now: c.now })
    m.record(0)
    c.advance(1000)
    m.record(1_000_000) // 1 MB/s
    expect(m.etaSeconds(5_000_000)).toBe(4) // 4 MB remaining
  })

  it('returns undefined ETA when total unknown or speed zero', () => {
    const c = clock()
    const m = new SpeedMeter({ now: c.now })
    m.record(0)
    expect(m.etaSeconds(5_000_000)).toBeUndefined() // speed 0
    c.advance(1000)
    m.record(1_000_000)
    expect(m.etaSeconds(undefined)).toBeUndefined()
  })
})
