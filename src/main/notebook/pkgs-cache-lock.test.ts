import { describe, expect, it } from 'vitest'

import { withExclusiveCacheLock, withSharedCacheLock } from './pkgs-cache-lock'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('pkgs cache lock', () => {
  it('runs shared holders concurrently', async () => {
    const key = `k-${Math.random()}`
    let concurrent = 0
    let maxConcurrent = 0
    const shared = (): Promise<void> =>
      withSharedCacheLock(key, async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await tick()
        concurrent -= 1
      })
    await Promise.all([shared(), shared(), shared()])
    expect(maxConcurrent).toBeGreaterThan(1) // shared readers overlap
  })

  it('an exclusive holder excludes shared holders (no overlap in either direction)', async () => {
    const key = `k-${Math.random()}`
    const order: string[] = []
    let exclusiveActive = false
    let sharedActive = 0

    // Start a shared holder first, then request exclusive, then another shared.
    const s1 = withSharedCacheLock(key, async () => {
      sharedActive += 1
      order.push('s1-start')
      await tick()
      expect(exclusiveActive).toBe(false) // the exclusive must not run while a shared holder is active
      order.push('s1-end')
      sharedActive -= 1
    })
    const ex = withExclusiveCacheLock(key, async () => {
      expect(sharedActive).toBe(0) // waited for the in-flight shared holder to drain
      exclusiveActive = true
      order.push('ex-start')
      await tick()
      order.push('ex-end')
      exclusiveActive = false
    })
    const s2 = withSharedCacheLock(key, async () => {
      expect(exclusiveActive).toBe(false) // s2 waited behind the exclusive holder
      order.push('s2')
    })

    await Promise.all([s1, ex, s2])
    // s1 runs first (already held), then the exclusive drains it, then s2.
    expect(order.indexOf('ex-start')).toBeGreaterThan(order.indexOf('s1-end'))
    expect(order.indexOf('s2')).toBeGreaterThan(order.indexOf('ex-end'))
  })
})
