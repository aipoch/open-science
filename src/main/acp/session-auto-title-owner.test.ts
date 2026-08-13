import { describe, expect, it, vi } from 'vitest'

import { SessionAutoTitleOwner } from './session-auto-title-owner'

describe('SessionAutoTitleOwner', () => {
  it('retains the first prompt identity for a framework title that arrives after later turns', () => {
    const owner = new SessionAutoTitleOwner({
      generate: async () => ({ title: 'Unused' })
    })

    owner.registerPrompt('session-1', 'first-prompt')
    owner.registerPrompt('session-1', 'second-prompt')

    expect(owner.observeFrameworkTitle('session-1')).toBe('first-prompt')
  })

  it('bounds a generator that ignores abort', async () => {
    vi.useFakeTimers()
    try {
      const owner = new SessionAutoTitleOwner({
        graceMs: 0,
        deadlineMs: 15_000,
        generate: () => new Promise(() => undefined)
      })

      const outcome = owner.complete({
        sessionId: 'session-1',
        prompt: 'Name this',
        signal: new AbortController().signal,
        isCurrent: () => true
      })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(outcome).resolves.toEqual({ kind: 'unavailable', attempted: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks timed-out generation until bounded shutdown reports unfinished cleanup', async () => {
    vi.useFakeTimers()
    try {
      const onCleanupTimeout = vi.fn()
      const owner = new SessionAutoTitleOwner({
        graceMs: 0,
        deadlineMs: 100,
        shutdownDeadlineMs: 50,
        onCleanupTimeout,
        generate: () => new Promise(() => undefined)
      })
      const outcome = owner.complete({
        sessionId: 'session-1',
        prompt: 'Name this',
        signal: new AbortController().signal,
        isCurrent: () => true
      })

      await vi.advanceTimersByTimeAsync(100)
      await expect(outcome).resolves.toEqual({ kind: 'unavailable', attempted: true })

      let shutdownSettled = false
      const shutdown = owner.shutdown().then(() => {
        shutdownSettled = true
      })
      await vi.advanceTimersByTimeAsync(49)
      expect(shutdownSettled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await shutdown
      expect(onCleanupTimeout).toHaveBeenCalledWith({ activeAttempts: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles promptly when the owning turn is cancelled', async () => {
    const turn = new AbortController()
    const generate = vi.fn(() => new Promise<never>(() => undefined))
    const owner = new SessionAutoTitleOwner({
      graceMs: 0,
      generate
    })

    const outcome = owner.complete({
      sessionId: 'session-1',
      prompt: 'Name this',
      signal: turn.signal,
      isCurrent: () => true
    })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    turn.abort()

    await expect(outcome).resolves.toEqual({ kind: 'unavailable', attempted: true })
  })

  it('settles active generation on shutdown', async () => {
    const generate = vi.fn(() => new Promise<never>(() => undefined))
    const owner = new SessionAutoTitleOwner({
      graceMs: 0,
      generate
    })
    const outcome = owner.complete({
      sessionId: 'session-1',
      prompt: 'Name this',
      signal: new AbortController().signal,
      isCurrent: () => true
    })

    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    owner.shutdown()

    await expect(outcome).resolves.toEqual({ kind: 'unavailable', attempted: true })
  })

  it('propagates a disposer rejection that settles before the shutdown deadline', async () => {
    const disposeError = new Error('restricted inference disposal failed')
    const owner = new SessionAutoTitleOwner({
      generate: async () => ({ title: 'Unused' }),
      dispose: async () => Promise.reject(disposeError)
    })

    await expect(owner.shutdown()).rejects.toBe(disposeError)
  })

  it('cancels active app inference as soon as a framework title arrives', async () => {
    let observedSignal: AbortSignal | undefined
    const generate = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          observedSignal = signal
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const owner = new SessionAutoTitleOwner({
      graceMs: 0,
      generate
    })
    const outcome = owner.complete({
      sessionId: 'session-1',
      prompt: 'Name this',
      signal: new AbortController().signal,
      isCurrent: () => true
    })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())

    owner.observeFrameworkTitle('session-1')

    expect(observedSignal?.aborted).toBe(true)
    await expect(outcome).resolves.toEqual({ kind: 'framework', attempted: true })
  })

  it('does not start inference for an empty naming prompt', async () => {
    const generate = vi.fn(async () => ({ title: 'Empty' }))
    const owner = new SessionAutoTitleOwner({ graceMs: 0, generate })

    await expect(
      owner.complete({
        sessionId: 'session-1',
        prompt: '  ',
        signal: new AbortController().signal,
        isCurrent: () => true
      })
    ).resolves.toEqual({ kind: 'unavailable', attempted: false })
    expect(generate).not.toHaveBeenCalled()
  })

  it('contains a synchronous generator failure', async () => {
    const owner = new SessionAutoTitleOwner({
      graceMs: 0,
      generate: () => {
        throw new Error('failed before returning a Promise')
      }
    })

    await expect(
      owner.complete({
        sessionId: 'session-1',
        prompt: 'Name this',
        signal: new AbortController().signal,
        isCurrent: () => true
      })
    ).resolves.toEqual({ kind: 'unavailable', attempted: true })
  })
})
