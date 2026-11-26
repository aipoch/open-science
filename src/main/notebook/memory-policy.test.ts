import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MemoryPolicyService,
  type MemoryPolicyAdapter,
  type MemoryPolicySample
} from './memory-policy'

const sample = (overrides: Partial<MemoryPolicySample> = {}): MemoryPolicySample => ({
  platform: 'linux',
  source: 'test',
  executionScope: 'linux:host',
  facts: { availableBytes: 800, totalBytes: 1000, overcommitMode: 0 },
  ...overrides
})

const adapter = (observe: MemoryPolicyAdapter['sample']): MemoryPolicyAdapter => ({
  platform: 'linux',
  sample: observe
})

afterEach(() => vi.useRealTimers())

describe('MemoryPolicyService', () => {
  it('returns a healthy, bounded snapshot and shares a fresh sample per execution domain', async () => {
    let now = 1000
    const observe = vi.fn(async () => sample())
    const service = new MemoryPolicyService({
      adapter: adapter(observe),
      now: () => now,
      maxAgeMs: 2000
    })

    const first = await service.getState({ executionScope: 'linux:host' })
    now = 1500
    const second = await service.getState({ executionScope: 'linux:host' })

    expect(first.status).toBe('healthy')
    expect(first.reason.code).toBe('healthy')
    expect(first.sampleAgeMs).toBe(0)
    expect(second.sampleAgeMs).toBe(500)
    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('counts sampling time against execution freshness while preserving the reclamation budget', async () => {
    let now = 1000
    let wall = 10_000
    const deferred = Promise.withResolvers<MemoryPolicySample>()
    const service = new MemoryPolicyService({
      adapter: adapter(async () => deferred.promise),
      now: () => now,
      wallNow: () => wall
    })
    const listener = vi.fn()
    service.subscribe(listener)
    const execution = service.getState()
    const reclamation = service.getState({ maxAgeMs: 10_000 })

    now += 3000
    wall += 3000
    deferred.resolve(sample())

    await expect(execution).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'sample-expired' },
      sampledAt: 1000,
      sampleAgeMs: 3000
    })
    expect(service.currentState().status).toBe('unavailable')
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'unavailable', sampleAgeMs: 3000 })
    )
    await expect(reclamation).resolves.toMatchObject({ status: 'healthy', sampleAgeMs: 3000 })
    service.dispose()
  })

  it.each([
    ['suspend', 60_000],
    ['wall-clock rollback', -1]
  ])('refuses a sample collected across %s', async (_reason, wallElapsed) => {
    let now = 1000
    let wall = 10_000
    const deferred = Promise.withResolvers<MemoryPolicySample>()
    const service = new MemoryPolicyService({
      adapter: adapter(async () => deferred.promise),
      now: () => now,
      wallNow: () => wall
    })
    const listener = vi.fn()
    service.subscribe(listener)
    const waiting = service.getState()

    now += 100
    wall += wallElapsed
    deferred.resolve(sample())

    await expect(waiting).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'sample-expired' }
    })
    expect(service.currentState({ maxAgeMs: 10_000 }).status).toBe('unavailable')
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable' }))
    service.dispose()
  })

  it('coalesces concurrent sampling but keeps domains independent', async () => {
    const deferred = Promise.withResolvers<MemoryPolicySample>()
    const observe = vi.fn(async (_signal: AbortSignal, scope?: string) => {
      if (scope === 'linux:container-b') return sample({ executionScope: scope })
      return deferred.promise
    })
    const service = new MemoryPolicyService({ adapter: adapter(observe), now: () => 1000 })

    const first = service.getState({ executionScope: 'linux:container-a' })
    const second = service.getState({ executionScope: 'linux:container-a' })
    const independent = await service.getState({ executionScope: 'linux:container-b' })

    expect(observe).toHaveBeenCalledTimes(2)
    expect(independent.executionScope).toBe('linux:container-b')
    deferred.resolve(sample({ executionScope: 'linux:container-a' }))
    await expect(first).resolves.toMatchObject({ executionScope: 'linux:container-a' })
    await expect(second).resolves.toMatchObject({ executionScope: 'linux:container-a' })
  })

  it('turns adapter failures and stale samples into unavailable without reviving late results', async () => {
    let now = 1000
    const deferred = Promise.withResolvers<MemoryPolicySample>()
    const observe = vi.fn(async () => deferred.promise)
    const service = new MemoryPolicyService({
      adapter: adapter(observe),
      now: () => now,
      sampleTimeoutMs: 10
    })

    const unavailable = await service.getState()
    expect(unavailable.status).toBe('unavailable')
    expect(unavailable.reason.code).toBe('sample-timeout')

    deferred.resolve(sample({ facts: { availableBytes: 1000, totalBytes: 1000 } }))
    await Promise.resolve()
    now = 2000
    const next = await service.getState({ force: true })
    expect(next.status).toBe('unavailable')
    expect(next.reason.code).toBe('sample-timeout')
    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('rejects only the cancelled caller while preserving the shared sample', async () => {
    const deferred = Promise.withResolvers<MemoryPolicySample>()
    const service = new MemoryPolicyService({
      adapter: adapter(async () => deferred.promise),
      now: () => 1000
    })
    const controller = new AbortController()
    const cancelled = service.getState({ signal: controller.signal })
    const shared = service.getState()
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    deferred.resolve(sample())
    await expect(shared).resolves.toMatchObject({ status: 'healthy' })
  })

  it('resamples after a failure only for an explicit forced check', async () => {
    const observe = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary native failure'))
      .mockResolvedValueOnce(sample())
    const service = new MemoryPolicyService({ adapter: adapter(observe), now: () => 1000 })

    await expect(service.getState()).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'sample-failed' }
    })
    await expect(service.getState()).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'sample-failed', retryAfterMs: 30_000 }
    })
    expect(observe).toHaveBeenCalledOnce()
    await expect(service.getState({ force: true })).resolves.toMatchObject({
      status: 'healthy'
    })
    expect(observe).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('preserves policy truth and later observers when a notification subscriber throws', async () => {
    let current = sample()
    const service = new MemoryPolicyService({
      adapter: adapter(async () => current),
      now: () => 1000
    })
    service.subscribe(() => {
      throw new Error('Notification transport closed')
    })
    const listener = vi.fn()
    service.subscribe(listener)

    await expect(service.getState()).resolves.toMatchObject({ status: 'healthy' })
    expect(service.currentState().status).toBe('healthy')
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'healthy' }))

    current = sample({ facts: { availableBytes: 25, totalBytes: 1000, overcommitMode: 0 } })
    await expect(service.getState({ force: true })).resolves.toMatchObject({
      status: 'pressured',
      reason: { code: 'linux-memory-low' }
    })
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'pressured' }))
    service.dispose()
  })

  it('preserves pressure hysteresis through healthy-looking samples', async () => {
    let current = sample({ facts: { availableBytes: 25, totalBytes: 1000, overcommitMode: 0 } })
    const service = new MemoryPolicyService({
      adapter: adapter(async () => current),
      now: () => 1000,
      wallNow: () => 1000,
      maxAgeMs: 0
    })

    await expect(service.getState()).resolves.toMatchObject({
      status: 'pressured',
      reason: { code: 'linux-memory-low' }
    })
    current = sample({ facts: { availableBytes: 35, totalBytes: 1000, overcommitMode: 0 } })
    await expect(service.getState({ force: true })).resolves.toMatchObject({ status: 'pressured' })
    current = sample({ facts: { availableBytes: 55, totalBytes: 1000, overcommitMode: 0 } })
    await expect(service.getState({ force: true })).resolves.toMatchObject({ status: 'healthy' })
  })

  it('caps default Linux physical entry and recovery thresholds on large hosts', async () => {
    const MiB = 1024 ** 2
    const total = 64 * 1024 * MiB
    let current = sample({
      facts: {
        totalBytes: total,
        availableBytes: 400 * MiB + 1,
        overcommitMode: 0
      }
    })
    const service = new MemoryPolicyService({
      adapter: adapter(async () => current)
    })
    const fresh = { force: true }
    await expect(service.getState(fresh)).resolves.toMatchObject({ status: 'healthy' })
    current = sample({
      facts: { totalBytes: total, availableBytes: 400 * MiB, overcommitMode: 0 }
    })
    await expect(service.getState(fresh)).resolves.toMatchObject({
      status: 'pressured',
      reason: { code: 'linux-memory-low', remainingThresholdRatio: (400 * MiB) / total }
    })
    current = sample({
      facts: { totalBytes: total, availableBytes: 800 * MiB, overcommitMode: 0 }
    })
    await expect(service.getState(fresh)).resolves.toMatchObject({
      status: 'pressured',
      reason: { code: 'linux-memory-low', remainingThresholdRatio: (800 * MiB) / total }
    })
    current = sample({
      facts: { totalBytes: total, availableBytes: 800 * MiB + 1, overcommitMode: 0 }
    })
    await expect(service.getState(fresh)).resolves.toMatchObject({ status: 'healthy' })
  })

  it('expires dispatch authority after two seconds and after suspend or wall-clock rollback', async () => {
    let now = 1000
    let wall = 10_000
    const service = new MemoryPolicyService({
      adapter: adapter(async () => sample()),
      now: () => now,
      wallNow: () => wall
    })
    await service.getState()
    now += 2001
    expect(service.currentState()).toMatchObject({
      status: 'unavailable',
      reason: { code: 'sample-expired' }
    })
    await service.getState()
    wall += 60_000
    expect(service.currentState().status).toBe('unavailable')
    await service.getState()
    wall--
    expect(service.currentState().status).toBe('unavailable')
  })

  it('ends a waiting check promptly on disposal and ignores its late native result', async () => {
    const deferred = Promise.withResolvers<MemoryPolicySample>()
    const service = new MemoryPolicyService({ adapter: adapter(async () => deferred.promise) })
    const listener = vi.fn()
    service.subscribe(listener)
    const waiting = service.getState()
    service.dispose()
    await expect(waiting).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'disposed' }
    })
    deferred.resolve(sample())
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    expect(service.currentState().status).toBe('unavailable')
  })

  it('does not overlap a timed-out underlying read and enforces fault backoff', async () => {
    vi.useFakeTimers()
    const deferred = Promise.withResolvers<MemoryPolicySample>()
    const observe = vi.fn(async () => deferred.promise)
    const service = new MemoryPolicyService({ adapter: adapter(observe), now: Date.now })
    const waiting = service.getState()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(waiting).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'sample-timeout' }
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await service.getState({ force: true })
    expect(observe).toHaveBeenCalledTimes(1)
    deferred.resolve(sample())
    await vi.advanceTimersByTimeAsync(0)
    await expect(service.getState({ force: true })).resolves.toMatchObject({ status: 'healthy' })
    expect(observe).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('starts no periodic sampling without demand and uses pressure cadence after activation', async () => {
    vi.useFakeTimers()
    const observe = vi.fn(async () =>
      sample({ facts: { availableBytes: 25, totalBytes: 1000, overcommitMode: 0 } })
    )
    const service = new MemoryPolicyService({ adapter: adapter(observe), now: Date.now })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(observe).not.toHaveBeenCalled()
    service.setActive(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(observe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(observe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(observe).toHaveBeenCalledTimes(2)
    service.setActive(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(observe).toHaveBeenCalledTimes(2)
    service.dispose()
  })
})

describe('MemoryPolicyService invalidation', () => {
  it('invalidates cached decisions when an adapter reports a platform event', async () => {
    let current = sample()
    let notify: (() => void) | undefined
    const adapterWithEvents: MemoryPolicyAdapter = {
      platform: 'linux',
      sample: async () => current,
      subscribe: (listener) => {
        notify = listener
        return () => {
          notify = undefined
        }
      }
    }
    const service = new MemoryPolicyService({ adapter: adapterWithEvents, now: () => 1000 })
    await service.getState()
    current = sample({ facts: { availableBytes: 25, totalBytes: 1000, overcommitMode: 0 } })
    notify?.()
    await expect(service.getState()).resolves.toMatchObject({ status: 'pressured' })
  })
})
