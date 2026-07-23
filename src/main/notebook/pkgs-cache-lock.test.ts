import { describe, expect, it } from 'vitest'

import {
  withExclusiveCacheLock,
  withExclusiveCacheLocks,
  withSharedCacheLock,
  withSharedCacheLocks
} from './pkgs-cache-lock'

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

  it('serializes the same physical cache key while different cache keys proceed independently', async () => {
    const key = `physical-cache-${Math.random()}`
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    let sameKeyEntered = false
    let otherKeyEntered = false

    const first = withExclusiveCacheLock(key, async () => {
      firstEntered()
      await release
    })
    await entered
    const same = withExclusiveCacheLock(key, async () => {
      sameKeyEntered = true
    })
    const other = withExclusiveCacheLock(`${key}-other`, async () => {
      otherKeyEntered = true
    })

    await other
    expect(otherKeyEntered).toBe(true)
    expect(sameKeyEntered).toBe(false)
    releaseFirst()
    await Promise.all([first, same])
    expect(sameKeyEntered).toBe(true)
  })

  it('deduplicates and stably orders multi-cache locks without blocking unrelated caches', async () => {
    const prefix = `multi-${Math.random()}`
    const a = `${prefix}-a`
    const b = `${prefix}-b`
    let releaseFirst!: () => void
    let firstEntered!: () => void
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    let oppositeEntered = false

    const first = withExclusiveCacheLocks([b, a, b], async () => {
      firstEntered()
      await release
    })
    await entered
    const opposite = withExclusiveCacheLocks([a, b], async () => {
      oppositeEntered = true
    })
    await withSharedCacheLocks([`${prefix}-other`], async () => undefined)
    expect(oppositeEntered).toBe(false)

    releaseFirst()
    await Promise.all([first, opposite])
    expect(oppositeEntered).toBe(true)
  })

  it('holds every requested physical cache identity for a shared operation', async () => {
    const prefix = `shared-multi-${Math.random()}`
    const a = `${prefix}-a`
    const b = `${prefix}-b`
    let releaseWriter!: () => void
    let writerEntered!: () => void
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    const entered = new Promise<void>((resolve) => {
      writerEntered = resolve
    })
    let sharedEntered = false

    const writer = withExclusiveCacheLock(b, async () => {
      writerEntered()
      await release
    })
    await entered
    const shared = withSharedCacheLocks([b, a, b], async () => {
      sharedEntered = true
    })
    await tick()
    expect(sharedEntered).toBe(false)

    releaseWriter()
    await Promise.all([writer, shared])
    expect(sharedEntered).toBe(true)
  })
})
