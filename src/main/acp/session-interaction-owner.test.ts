import { describe, expect, it, vi } from 'vitest'

import {
  AcpSessionInteractionOwner,
  type AcpPromptSessionInteractionScope
} from './session-interaction-owner'

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

describe('AcpSessionInteractionOwner', () => {
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
    const work = async (result: string) => {
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

    await expect(
      owner.run({ sessionId: 'session-1', kind: 'prompt' }, work)
    ).rejects.toThrow('work failed')
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
