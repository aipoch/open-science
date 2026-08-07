import { afterEach, describe, expect, it, vi } from 'vitest'

import { closeElectronApplicationForCleanup } from '../e2e/fixtures/electron-app'

const deferred = (): {
  promise: Promise<void>
  resolve: () => void
} => {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('Electron E2E cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a graceful close on the normal path', async () => {
    const forceClose = vi.fn(async () => undefined)

    await closeElectronApplicationForCleanup(
      { close: () => Promise.resolve(), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    )

    expect(forceClose).not.toHaveBeenCalled()
  })

  it('force-closes a fixture-owned process after the graceful budget', async () => {
    vi.useFakeTimers()
    const closing = deferred()
    const forceClose = vi.fn(async () => closing.resolve())
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => closing.promise, forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    )

    await vi.advanceTimersByTimeAsync(100)
    await cleanup

    expect(forceClose).toHaveBeenCalledOnce()
  })

  it('awaits forced reaping before propagating a graceful close error', async () => {
    const reaping = deferred()
    const forceClose = vi.fn(() => reaping.promise)
    let cleanupError: unknown
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => Promise.reject(new Error('close failed')), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }
    ).catch((error: unknown) => {
      cleanupError = error
    })

    await vi.waitFor(() => expect(forceClose).toHaveBeenCalledOnce())
    expect(cleanupError).toBeUndefined()

    reaping.resolve()
    await cleanup
    expect(cleanupError).toEqual(new Error('close failed'))
  })

  it('fails within a second bound when forced cleanup cannot reap the process', async () => {
    vi.useFakeTimers()
    const forceClose = vi.fn(() => new Promise<void>(() => undefined))
    const cleanup = closeElectronApplicationForCleanup(
      { close: () => new Promise<void>(() => undefined), forceClose },
      { gracefulTimeoutMs: 100, forcedTimeoutMs: 50 }
    )
    const rejection = expect(cleanup).rejects.toThrow('forced close did not finish within 50ms')

    await vi.advanceTimersByTimeAsync(150)
    await rejection
    expect(forceClose).toHaveBeenCalledOnce()
  })
})
