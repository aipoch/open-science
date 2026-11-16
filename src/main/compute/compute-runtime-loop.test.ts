import { describe, expect, it, vi } from 'vitest'
import { createComputeRuntimeLoop } from './compute-runtime-loop'

describe('createComputeRuntimeLoop', () => {
  it('stops the active timer when idle and wakes immediately', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(false)
    const loop = createComputeRuntimeLoop({
      run,
      activeIntervalMs: 5_000,
      onError: vi.fn()
    })
    try {
      loop.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(run).toHaveBeenCalledOnce()
      await loop.wake()
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      await loop.stop()
      vi.useRealTimers()
    }
  })

  it('keeps the 5 second cadence while a pass reports work', async () => {
    vi.useFakeTimers()
    let hasWork = true
    const run = vi.fn().mockImplementation(async () => {
      const result = hasWork
      hasWork = false
      return result
    })
    const loop = createComputeRuntimeLoop({
      run,
      activeIntervalMs: 5_000,
      onError: vi.fn()
    })
    try {
      loop.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(4_999)
      expect(run).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(run).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      await loop.stop()
      vi.useRealTimers()
    }
  })

  it('schedules the next retry wake without keeping the active cadence alive', async () => {
    vi.useFakeTimers()
    const run = vi
      .fn()
      .mockResolvedValueOnce({ hasWork: false, nextWakeAfterMs: 1_000 })
      .mockResolvedValue(false)
    const loop = createComputeRuntimeLoop({
      run,
      activeIntervalMs: 5_000,
      onError: vi.fn()
    })
    try {
      loop.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(999)
      expect(run).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      await loop.stop()
      vi.useRealTimers()
    }
  })

  it('keeps an existing retry wake when a fallback tick runs first', async () => {
    vi.useFakeTimers()
    const run = vi
      .fn()
      .mockResolvedValueOnce({ hasWork: false, nextWakeAfterMs: 300_000 })
      .mockResolvedValueOnce({ hasWork: false, nextWakeAfterMs: 240_000 })
      .mockResolvedValue(false)
    const loop = createComputeRuntimeLoop({
      run,
      activeIntervalMs: 5_000,
      onError: vi.fn()
    })
    try {
      loop.start()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)
      await loop.tick()
      expect(run).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(239_999)
      expect(run).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(run).toHaveBeenCalledTimes(3)
    } finally {
      await loop.stop()
      vi.useRealTimers()
    }
  })

  it('does not replay a pending wake after stop wins the race', async () => {
    let release!: () => void
    const run = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(false)
        })
    )
    const loop = createComputeRuntimeLoop({
      run,
      activeIntervalMs: 5_000,
      onError: vi.fn()
    })
    loop.start()
    await Promise.resolve()
    const wake = loop.wake()
    const stopping = loop.stop()
    release()
    await Promise.all([wake, stopping])
    expect(run).toHaveBeenCalledOnce()
  })

  it('resolves a wake after the queued pass completes', async () => {
    let release!: () => void
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(false)
          })
      )
      .mockResolvedValue(false)
    const loop = createComputeRuntimeLoop({
      run,
      activeIntervalMs: 5_000,
      onError: vi.fn()
    })
    loop.start()
    await Promise.resolve()
    const wake = loop.wake()
    release()
    await wake
    expect(run).toHaveBeenCalledTimes(2)
    await loop.stop()
  })

  it('runs the queued-pass callback after the active pass drains', async () => {
    let release!: () => void
    let retryReady = false
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(false)
          })
      )
      .mockImplementation(async () => retryReady)
    const loop = createComputeRuntimeLoop({
      run,
      activeIntervalMs: 5_000,
      onError: vi.fn()
    })
    loop.start()
    await Promise.resolve()
    const wake = loop.wake(() => {
      retryReady = true
    })
    release()
    await wake
    expect(run).toHaveBeenCalledTimes(2)
    await loop.stop()
  })
})
