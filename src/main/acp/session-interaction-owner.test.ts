import { describe, expect, it, vi } from 'vitest'

import {
  AcpSessionInteractionOwner,
  type AcpPromptSessionInteractionScope
} from './session-interaction-owner'

const createDeferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

describe('AcpSessionInteractionOwner', () => {
  it('publishes cancellation before notify settles and keeps the interaction active', async () => {
    const owner = new AcpSessionInteractionOwner()
    const scope = owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    const releaseNotify = createDeferred<void>()
    const onAccepted = vi.fn()
    const cancelling = owner.cancelPrompt({
      sessionId: 'session-1',
      notify: () => releaseNotify.promise,
      onAccepted,
      onTimeout: vi.fn()
    })
    let checkpointSettled = false
    const checkpoint = owner.cancellationCheckpoint(scope).then((status) => {
      checkpointSettled = true
      return status
    })

    expect(scope.signal.aborted).toBe(true)
    expect(owner.current('session-1')).toBe(scope)
    await Promise.resolve()
    expect(checkpointSettled).toBe(false)
    expect(onAccepted).not.toHaveBeenCalled()

    releaseNotify.resolve()
    await cancelling
    await expect(checkpoint).resolves.toBe('cancelled')
    expect(owner.isCancellationAccepted(scope)).toBe(true)
    expect(onAccepted).toHaveBeenCalledOnce()
    expect(owner.current('session-1')).toBe(scope)
  })

  it('keeps cancellation inactive and clears its timer when notify fails', async () => {
    const clearTimer = vi.fn()
    const owner = new AcpSessionInteractionOwner({
      cancelTimeoutMs: 1,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer
    })
    const scope = owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    const onAccepted = vi.fn()

    await expect(
      owner.cancelPrompt({
        sessionId: 'session-1',
        notify: async () => {
          throw new Error('cancel write failed')
        },
        onAccepted,
        onTimeout: vi.fn()
      })
    ).rejects.toThrow('cancel write failed')

    await expect(owner.cancellationCheckpoint(scope)).resolves.toBe('active')
    expect(owner.isCancellationAccepted(scope)).toBe(false)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(clearTimer).toHaveBeenCalledOnce()
  })

  it('scopes cancellation timeouts to the captured interaction generation', async () => {
    type TestTimer = { active: boolean; fire: () => void }
    const timers: TestTimer[] = []
    const owner = new AcpSessionInteractionOwner({
      cancelTimeoutMs: 1,
      setTimer: (callback) => {
        const timer: TestTimer = {
          active: true,
          fire: () => {
            if (timer.active) callback()
          }
        }
        timers.push(timer)
        return timer as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: (handle) => {
        const timer = handle as unknown as TestTimer
        timer.active = false
      }
    })
    const onTimeout = vi.fn()
    const first = owner.claim({ sessionId: 'session-1', kind: 'prompt' })

    await owner.cancelPrompt({
      sessionId: 'session-1',
      notify: async () => undefined,
      onAccepted: vi.fn(),
      onTimeout
    })
    expect(timers[0].active).toBe(true)
    owner.release(first)
    expect(timers[0].active).toBe(false)

    const replacement = owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    timers[0].fire()
    expect(onTimeout).not.toHaveBeenCalled()

    await owner.cancelPrompt({
      sessionId: 'session-1',
      notify: async () => undefined,
      onAccepted: vi.fn(),
      onTimeout
    })
    timers[1].fire()
    expect(onTimeout).toHaveBeenCalledOnce()
    owner.release(replacement)
  })

  it('does not let a cancellation without an active interaction time out a later turn', async () => {
    let fireTimeout: (() => void) | undefined
    const owner = new AcpSessionInteractionOwner({
      cancelTimeoutMs: 1,
      setTimer: (callback) => {
        fireTimeout = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      }
    })
    const onTimeout = vi.fn()

    await owner.cancelPrompt({
      sessionId: 'session-1',
      notify: async () => undefined,
      onAccepted: vi.fn(),
      onTimeout
    })
    const scope = owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    fireTimeout?.()

    expect(onTimeout).not.toHaveBeenCalled()
    expect(owner.current('session-1')).toBe(scope)
    owner.release(scope)
  })

  it('keeps a synchronous prompt reservation private until activation', () => {
    const owner = new AcpSessionInteractionOwner()
    const active = owner.claim({ sessionId: 'session-1', kind: 'compaction' })

    expect(() => owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })).toThrow(
      /already running/
    )
    owner.release(active)

    const reservation = owner.reservePrompt({
      sessionId: 'session-1',
      kind: 'prompt',
      promptMessageId: 'prompt-message-1'
    })
    expect(reservation.signal.aborted).toBe(false)
    expect(owner.current('session-1')).toBeUndefined()
    expect(owner.snapshot()).toEqual([])

    expect(owner.activatePrompt(reservation)).toBe(reservation)
    expect(owner.current('session-1')).toBe(reservation)
    owner.release(reservation)
  })

  it('lets a newer reservation replace an older pending scope without stale interference', () => {
    const owner = new AcpSessionInteractionOwner()
    const first = owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })
    const replacement = owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })

    expect(first.signal.aborted).toBe(true)
    expect(replacement.signal.aborted).toBe(false)
    expect(() => owner.activatePrompt(first)).toThrow(/superseded/)
    owner.release(first)

    expect(owner.activatePrompt(replacement)).toBe(replacement)
    owner.release(first)
    expect(owner.current('session-1')).toBe(replacement)
    owner.release(replacement)
  })

  it('releases an abandoned preflight reservation without leaking ownership', () => {
    const owner = new AcpSessionInteractionOwner()
    const abandoned = owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })

    owner.release(abandoned)
    expect(() => owner.activatePrompt(abandoned)).toThrow(/superseded/)

    const next = owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })
    expect(owner.activatePrompt(next)).toBe(next)
    owner.release(next)
  })

  it('supersedes pending and active ownership for one session or all sessions', () => {
    const owner = new AcpSessionInteractionOwner()
    const pendingReset = owner.reservePrompt({ sessionId: 'session-1', kind: 'prompt' })
    const activeReset = owner.claim({ sessionId: 'session-1', kind: 'compaction' })

    owner.supersedeCurrent('session-1')
    expect(pendingReset.signal.aborted).toBe(true)
    expect(activeReset.signal.aborted).toBe(true)
    expect(owner.current('session-1')).toBeUndefined()
    expect(() => owner.activatePrompt(pendingReset)).toThrow(/superseded/)

    const pendingAll = owner.reservePrompt({ sessionId: 'session-2', kind: 'prompt' })
    const activeAll = owner.claim({ sessionId: 'session-3', kind: 'compaction' })
    owner.supersedeAll()

    expect(pendingAll.signal.aborted).toBe(true)
    expect(activeAll.signal.aborted).toBe(true)
    expect(owner.snapshot()).toEqual([])
    expect(() => owner.activatePrompt(pendingAll)).toThrow(/superseded/)
  })

  it('supports explicit claim and release while run uses the same lifecycle', async () => {
    const owner = new AcpSessionInteractionOwner()
    const first = owner.claim({ sessionId: 'session-1', kind: 'prompt' })

    expect(owner.current('session-1')).toBe(first)
    expect(() => owner.claim({ sessionId: 'session-1', kind: 'compaction' })).toThrow(
      /already running/
    )

    owner.release(first)
    const replacement = owner.claim({ sessionId: 'session-1', kind: 'compaction' })
    owner.release(first)
    expect(owner.current('session-1')).toBe(replacement)
    owner.release(replacement)

    const claim = vi.spyOn(owner, 'claim')
    const release = vi.spyOn(owner, 'release')
    await expect(
      owner.run({ sessionId: 'session-2', kind: 'prompt' }, async () => 'run-result')
    ).resolves.toBe('run-result')
    expect(claim).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(claim.mock.results[0].value)
  })

  it('claims a session before work reaches its first await and rejects overlapping work', async () => {
    const owner = new AcpSessionInteractionOwner()
    const release = createDeferred<void>()
    const firstWork = vi.fn(async () => {
      await release.promise
      return 'first-result'
    })
    const overlappingWork = vi.fn(async () => 'overlapping-result')

    const first = owner.run({ sessionId: 'session-1', kind: 'prompt' }, firstWork)
    const overlapping = owner.run({ sessionId: 'session-1', kind: 'prompt' }, overlappingWork)

    expect(firstWork).toHaveBeenCalledOnce()
    expect(overlappingWork).not.toHaveBeenCalled()
    await expect(overlapping).rejects.toThrow(/already running/)

    release.resolve()
    await expect(first).resolves.toBe('first-result')
  })

  it('allows interactions for different sessions to run concurrently', async () => {
    const owner = new AcpSessionInteractionOwner()
    const bothStarted = createDeferred<void>()
    let started = 0
    const work = async (result: string): Promise<string> => {
      started += 1
      if (started === 2) {
        bothStarted.resolve()
      }
      await bothStarted.promise
      return result
    }

    await expect(
      Promise.all([
        owner.run({ sessionId: 'session-1', kind: 'prompt' }, () => work('first-result')),
        owner.run({ sessionId: 'session-2', kind: 'compaction' }, () => work('second-result'))
      ])
    ).resolves.toEqual(['first-result', 'second-result'])
  })

  it('passes immutable request facts and a fresh monotonic identity to each run', async () => {
    const owner = new AcpSessionInteractionOwner()
    const scopes: AcpPromptSessionInteractionScope[] = []

    await owner.run(
      {
        sessionId: 'session-1',
        kind: 'prompt',
        promptMessageId: 'prompt-message-1'
      },
      async (scope) => {
        const turnToken = scope.turnToken
        await Promise.resolve()

        expect(scope).toMatchObject({
          sessionId: 'session-1',
          kind: 'prompt',
          promptMessageId: 'prompt-message-1'
        })
        expect(scope.signal).toBeInstanceOf(AbortSignal)
        expect(scope.signal.aborted).toBe(false)
        expect(scope.turnToken).toBe(turnToken)
        expect(Object.isFrozen(scope)).toBe(true)
        scopes.push(scope)
      }
    )
    let compactionSequence = 0
    await owner.run({ sessionId: 'session-1', kind: 'compaction' }, async (scope) => {
      compactionSequence = scope.sequence
      expect('promptMessageId' in scope).toBe(false)
      expect('turnToken' in scope).toBe(false)
    })

    expect(compactionSequence).toBe(scopes[0].sequence + 1)
  })

  it('retains a continuation turn token and exposes only the current scope', async () => {
    const owner = new AcpSessionInteractionOwner()
    const release = createDeferred<void>()
    let scope!: AcpPromptSessionInteractionScope
    const interaction = owner.run(
      {
        sessionId: 'session-1',
        kind: 'prompt',
        turnToken: 'originating-turn-token'
      },
      async (activeScope) => {
        scope = activeScope
        await release.promise
      }
    )

    expect(scope.turnToken).toBe('originating-turn-token')
    expect(owner.current('session-1')).toBe(scope)

    release.resolve()
    await interaction

    expect(owner.current('session-1')).toBeUndefined()
  })

  it('does not let a superseded interaction clear its replacement when it settles', async () => {
    const owner = new AcpSessionInteractionOwner()
    const releaseSuperseded = createDeferred<void>()
    const releaseReplacement = createDeferred<void>()
    let supersededScope!: AcpPromptSessionInteractionScope
    let replacementScope!: AcpPromptSessionInteractionScope
    const superseded = owner.run({ sessionId: 'session-1', kind: 'prompt' }, async (scope) => {
      supersededScope = scope
      await releaseSuperseded.promise
      return 'superseded-result'
    })

    expect(supersededScope.signal.aborted).toBe(false)
    owner.supersede(supersededScope)
    expect(supersededScope.signal.aborted).toBe(true)
    expect(owner.current('session-1')).toBeUndefined()
    const replacement = owner.run({ sessionId: 'session-1', kind: 'prompt' }, async (scope) => {
      replacementScope = scope
      await releaseReplacement.promise
      return 'replacement-result'
    })
    expect(replacementScope.signal.aborted).toBe(false)

    owner.supersede(supersededScope)
    expect(owner.current('session-1')).toBe(replacementScope)
    expect(replacementScope.signal.aborted).toBe(false)

    releaseSuperseded.resolve()
    await expect(superseded).resolves.toBe('superseded-result')

    const overlappingWork = vi.fn(async () => 'overlapping-result')
    await expect(
      owner.run({ sessionId: 'session-1', kind: 'prompt' }, overlappingWork)
    ).rejects.toThrow(/already running/)
    expect(overlappingWork).not.toHaveBeenCalled()

    releaseReplacement.resolve()
    await expect(replacement).resolves.toBe('replacement-result')
    await expect(
      owner.run({ sessionId: 'session-1', kind: 'prompt' }, async () => 'next-result')
    ).resolves.toBe('next-result')
  })

  it('authoritatively supersedes the current session or every active session', () => {
    const owner = new AcpSessionInteractionOwner()
    const first = owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    const other = owner.claim({ sessionId: 'session-2', kind: 'compaction' })

    owner.supersedeCurrent('missing-session')
    expect(first.signal.aborted).toBe(false)
    expect(other.signal.aborted).toBe(false)

    owner.supersedeCurrent('session-1')
    expect(first.signal.aborted).toBe(true)
    expect(owner.current('session-1')).toBeUndefined()

    const replacement = owner.claim({ sessionId: 'session-1', kind: 'prompt' })
    owner.supersede(first)
    expect(owner.current('session-1')).toBe(replacement)
    expect(replacement.signal.aborted).toBe(false)

    owner.supersedeAll()
    expect(replacement.signal.aborted).toBe(true)
    expect(other.signal.aborted).toBe(true)
    expect(owner.snapshot()).toEqual([])
  })

  it.each([
    [
      'synchronous throw',
      () => {
        throw new Error('work failed')
      }
    ],
    [
      'asynchronous rejection',
      async () => {
        await Promise.resolve()
        throw new Error('work failed')
      }
    ]
  ])('releases a session after a work %s', async (_name, work) => {
    const owner = new AcpSessionInteractionOwner()

    await expect(owner.run({ sessionId: 'session-1', kind: 'prompt' }, work)).rejects.toThrow(
      'work failed'
    )
    await expect(
      owner.run({ sessionId: 'session-1', kind: 'prompt' }, async () => 'next-result')
    ).resolves.toBe('next-result')
  })

  it('returns a frozen detached snapshot of active session ids and kinds', async () => {
    const owner = new AcpSessionInteractionOwner()
    const releasePrompt = createDeferred<void>()
    const releaseCompaction = createDeferred<void>()
    const prompt = owner.run({ sessionId: 'session-1', kind: 'prompt' }, async () => {
      await releasePrompt.promise
    })
    const compaction = owner.run({ sessionId: 'session-2', kind: 'compaction' }, async () => {
      await releaseCompaction.promise
    })

    const snapshot = owner.snapshot()
    expect(snapshot).toEqual([
      { sessionId: 'session-1', kind: 'prompt' },
      { sessionId: 'session-2', kind: 'compaction' }
    ])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot.every(Object.isFrozen)).toBe(true)

    releasePrompt.resolve()
    await prompt
    expect(owner.snapshot()).toEqual([{ sessionId: 'session-2', kind: 'compaction' }])
    expect(snapshot).toHaveLength(2)

    releaseCompaction.resolve()
    await compaction
  })
})
