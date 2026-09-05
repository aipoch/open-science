import { describe, expect, it, vi } from 'vitest'

import {
  DelegationSettlementWakeOwner,
  type DelegationSettlementDispatch,
  type DelegationSettlementSnapshot
} from './delegation-settlement-wake-owner'

const snapshot = (
  attempts: DelegationSettlementSnapshot['attempts'],
  overrides: Partial<DelegationSettlementSnapshot> = {}
): DelegationSettlementSnapshot => ({
  projectId: 'project-1',
  sessionId: 'session-1',
  rootFrameId: 'root-frame',
  activeRootPromptIds: ['root-prompt'],
  attempts,
  ...overrides,
  rootPromptRuntimeSegments:
    overrides.rootPromptRuntimeSegments ??
    Object.fromEntries(
      (overrides.activeRootPromptIds ?? ['root-prompt']).map((promptId) => [
        promptId,
        'root-runtime'
      ])
    )
})

const child = (
  frameId: string,
  status: 'running' | 'completed' | 'error' | 'cancelled',
  overrides: Partial<DelegationSettlementSnapshot['attempts'][number]> = {}
): DelegationSettlementSnapshot['attempts'][number] => ({
  frameId,
  attemptId: `attempt-${frameId}`,
  parentFrameId: 'root-frame',
  originatingPromptId: 'root-prompt',
  name: frameId,
  status,
  ...overrides
})

const acceptDispatch = async (request: DelegationSettlementDispatch): Promise<void> => {
  void request
}

const endRootTurn = async (
  owner: DelegationSettlementWakeOwner,
  input: Readonly<{ sessionId: string; originatingPromptId: string; clean: boolean }>,
  duringTurn: () => void | Promise<void> = () => undefined
): Promise<void> => {
  const leaseId = await owner.onRootTurnStarted({
    sessionId: input.sessionId,
    originatingPromptId: input.originatingPromptId
  })
  await duringTurn()
  await owner.onRootTurnEnded({ ...input, leaseId })
}

describe('DelegationSettlementWakeOwner', () => {
  it('watches running direct Attempts at clean root end and wakes after one settles', async () => {
    vi.useFakeTimers()
    let current = snapshot([])
    const dispatched: DelegationSettlementDispatch[] = []
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch: async (request) => {
        dispatched.push(request)
      },
      createPromptId: () => 'wake-1'
    })

    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        current = snapshot([child('alpha', 'running')])
      }
    )
    current = snapshot([child('alpha', 'completed')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(99)
    expect(dispatched).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      sessionId: 'session-1',
      projectId: 'project-1',
      originatingPromptId: 'root-prompt',
      promptId: 'wake-1'
    })
    expect(dispatched[0].text).toContain('alpha')
    expect(dispatched[0].text).toContain('frame=alpha')
    expect(dispatched[0].text).toContain('attempt=attempt-alpha')
    expect(dispatched[0].text).toContain('status=completed')
    expect(dispatched[0].text).toContain('All watched Subagent Attempts have settled')
    vi.useRealTimers()
  })

  it('wakes for an unobserved detached Attempt that settles before the root turn ends', async () => {
    vi.useFakeTimers()
    let current = snapshot([])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch,
      createPromptId: () => 'wake-early-terminal'
    })
    const leaseId = await owner.onRootTurnStarted({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt'
    })
    owner.trackUnobservedAttempts({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      attempts: [{ frameId: 'fast', attemptId: 'attempt-fast', name: 'fast' }]
    })
    current = snapshot([child('fast', 'completed')])

    await owner.onRootTurnEnded({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      clean: true,
      leaseId
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[0]?.text).toContain('status=completed')
    vi.useRealTimers()
  })

  it('does not wake for a detached Attempt whose terminal result was observed in the root turn', async () => {
    vi.useFakeTimers()
    let current = snapshot([])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch
    })
    const leaseId = await owner.onRootTurnStarted({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt'
    })
    owner.trackUnobservedAttempts({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      attempts: [{ frameId: 'collected', attemptId: 'attempt-collected', name: 'collected' }]
    })
    owner.markAttemptsObserved({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      attempts: [{ frameId: 'collected', attemptId: 'attempt-collected' }]
    })
    current = snapshot([child('collected', 'completed')])

    await owner.onRootTurnEnded({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      clean: true,
      leaseId
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(dispatch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('wakes only for the unobserved sibling after a partial same-turn collect', async () => {
    vi.useFakeTimers()
    let current = snapshot([])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch
    })
    const leaseId = await owner.onRootTurnStarted({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt'
    })
    owner.trackUnobservedAttempts({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      attempts: [
        { frameId: 'collected', attemptId: 'attempt-collected', name: 'collected' },
        { frameId: 'detached', attemptId: 'attempt-detached', name: 'detached' }
      ]
    })
    owner.markAttemptsObserved({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      attempts: [{ frameId: 'collected', attemptId: 'attempt-collected' }]
    })
    current = snapshot([child('collected', 'completed'), child('detached', 'error')])

    await owner.onRootTurnEnded({
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      clean: true,
      leaseId
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[0]?.text).toContain('detached')
    expect(dispatch.mock.calls[0]?.[0]?.text).not.toContain('collected')
    vi.useRealTimers()
  })

  it.each(['throw', 'reject'] as const)(
    'restores a settlement batch when continuation dispatch %s fails before acceptance',
    async (failure) => {
      vi.useFakeTimers()
      let current = snapshot([])
      let dispatchAttempt = 0
      const dispatch = vi.fn((request: DelegationSettlementDispatch): Promise<void> | void => {
        void request
        dispatchAttempt += 1
        if (dispatchAttempt !== 1) return Promise.resolve()
        if (failure === 'throw') throw new Error('runtime unavailable')
        return Promise.reject(new Error('runtime unavailable'))
      })
      const owner = new DelegationSettlementWakeOwner({
        readSnapshot: async () => current,
        dispatch,
        createPromptId: () => `wake-${dispatchAttempt + 1}`
      })
      await endRootTurn(
        owner,
        { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
        () => {
          current = snapshot([child('retry-me', 'running')])
        }
      )
      current = snapshot([child('retry-me', 'completed')])
      await owner.onRecordsChanged('session-1')

      await vi.advanceTimersByTimeAsync(100)
      await Promise.resolve()
      expect(dispatch).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(100)

      expect(dispatch).toHaveBeenCalledTimes(2)
      expect(dispatch.mock.calls[0]?.[0]?.text).toContain('retry-me')
      expect(dispatch.mock.calls[1]?.[0]?.text).toContain('retry-me')
      vi.useRealTimers()
    }
  )

  it('backs off repeated pre-accept failures instead of polling the repository at 10Hz', async () => {
    vi.useFakeTimers()
    let current = snapshot([])
    const dispatch = vi.fn(async () => {
      throw new Error('runtime remains unavailable')
    })
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch
    })
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        current = snapshot([child('retry-with-backoff', 'running')])
      }
    )
    current = snapshot([child('retry-with-backoff', 'completed')])
    await owner.onRecordsChanged('session-1')

    await vi.advanceTimersByTimeAsync(1_600)

    expect(dispatch).toHaveBeenCalledTimes(5)
    vi.useRealTimers()
  })

  it('reconciles the root-end race and ignores terminal, nested, and unrelated Attempts', async () => {
    vi.useFakeTimers()
    const current = snapshot([
      child('raced', 'completed'),
      child('already-terminal', 'completed'),
      child('nested', 'running', { parentFrameId: 'raced' }),
      child('other-turn', 'running', { originatingPromptId: 'other-prompt' })
    ])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: vi
        .fn()
        .mockResolvedValueOnce(snapshot([]))
        .mockResolvedValueOnce(snapshot([child('raced', 'running')]))
        .mockResolvedValue(current),
      dispatch,
      createPromptId: () => 'wake-race'
    })

    await endRootTurn(owner, {
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      clean: true
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledOnce()
    const request = dispatch.mock.calls[0]?.[0]
    expect(request?.text).toContain('raced')
    expect(request?.text).not.toContain('already-terminal')
    expect(request?.text).not.toContain('nested')
    expect(request?.text).not.toContain('other-turn')
    vi.useRealTimers()
  })

  it('uses a fixed leading debounce and freezes stable batches from the final snapshot', async () => {
    vi.useFakeTimers()
    let current = snapshot([])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch,
      createPromptId: () => 'wake-batch'
    })
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        current = snapshot([
          child('alpha', 'running'),
          child('beta', 'running'),
          child('gamma', 'running')
        ])
      }
    )

    current = snapshot([
      child('alpha', 'completed'),
      child('beta', 'running'),
      child('gamma', 'running')
    ])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(70)
    current = snapshot([
      child('alpha', 'completed'),
      child('beta', 'error'),
      child('gamma', 'running')
    ])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(30)

    expect(dispatch).toHaveBeenCalledOnce()
    const text = dispatch.mock.calls[0]?.[0]?.text ?? ''
    expect(text.indexOf('alpha')).toBeLessThan(text.indexOf('beta'))
    expect(text).toContain('status=completed')
    expect(text).toContain('status=error')
    expect(text).toContain('1 watched Subagent Attempt remains running')
    vi.useRealTimers()
  })

  it('keeps one Session flight until the exact wake prompt ends and then dispatches later settlements', async () => {
    vi.useFakeTimers()
    let prompt = 0
    let current = snapshot([])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch,
      createPromptId: () => `wake-${++prompt}`
    })
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        current = snapshot([child('alpha', 'running'), child('beta', 'running')])
      }
    )
    current = snapshot([child('alpha', 'completed'), child('beta', 'running')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledOnce()

    current = snapshot([child('alpha', 'completed'), child('beta', 'cancelled')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(500)
    expect(dispatch).toHaveBeenCalledOnce()
    await owner.onWakePromptEnded('session-1', 'unrelated')
    expect(dispatch).toHaveBeenCalledOnce()
    await owner.onWakePromptEnded('session-1', 'wake-1')
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({ promptId: 'wake-2' })
    expect(dispatch.mock.calls[1]?.[0]?.text).toContain('status=cancelled')
    vi.useRealTimers()
  })

  it('retains an invalidated branch flight until its exact terminal callback releases the Session', async () => {
    vi.useFakeTimers()
    let prompt = 0
    let current = snapshot([], { activeRootPromptIds: ['prompt-a', 'prompt-b'] })
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch,
      createPromptId: () => `wake-${++prompt}`
    })
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'prompt-a', clean: true },
      () => {
        current = snapshot([child('alpha', 'running', { originatingPromptId: 'prompt-a' })], {
          activeRootPromptIds: ['prompt-a', 'prompt-b']
        })
      }
    )
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'prompt-b', clean: true },
      () => {
        current = snapshot(
          [
            child('alpha', 'running', { originatingPromptId: 'prompt-a' }),
            child('beta', 'running', { originatingPromptId: 'prompt-b' })
          ],
          { activeRootPromptIds: ['prompt-a', 'prompt-b'] }
        )
      }
    )

    current = snapshot(
      [
        child('alpha', 'completed', { originatingPromptId: 'prompt-a' }),
        child('beta', 'running', { originatingPromptId: 'prompt-b' })
      ],
      { activeRootPromptIds: ['prompt-a', 'prompt-b'] }
    )
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledOnce()

    current = snapshot(
      [
        child('alpha', 'completed', { originatingPromptId: 'prompt-a' }),
        child('beta', 'error', { originatingPromptId: 'prompt-b' })
      ],
      { activeRootPromptIds: ['prompt-a', 'prompt-b'] }
    )
    await owner.onRecordsChanged('session-1')
    await owner.invalidateBranch('session-1', 'prompt-a')
    await vi.advanceTimersByTimeAsync(500)
    expect(dispatch).toHaveBeenCalledOnce()

    await owner.onWakePromptEnded('session-1', 'wake-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({ originatingPromptId: 'prompt-b' })
    expect(dispatch.mock.calls[1]?.[0]?.text).toContain('beta')
    vi.useRealTimers()
  })

  it('watches only direct Attempts created during the leased root turn', async () => {
    vi.useFakeTimers()
    let current = snapshot([child('older', 'running')])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch,
      createPromptId: () => 'wake-cohort'
    })
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        current = snapshot([child('older', 'running'), child('newer', 'running')])
      }
    )

    current = snapshot([child('older', 'completed'), child('newer', 'running')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(200)
    expect(dispatch).not.toHaveBeenCalled()

    current = snapshot([child('older', 'completed'), child('newer', 'completed')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[0]?.text).toContain('newer')
    expect(dispatch.mock.calls[0]?.[0]?.text).not.toContain('older')
    vi.useRealTimers()
  })

  it('allows different Sessions to debounce and dispatch independently', async () => {
    vi.useFakeTimers()
    const currents = new Map<string, DelegationSettlementSnapshot>([
      ['session-1', snapshot([])],
      ['session-2', snapshot([], { projectId: 'project-2', sessionId: 'session-2' })]
    ])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async (sessionId) => currents.get(sessionId),
      dispatch
    })
    await Promise.all(
      ['session-1', 'session-2'].map((sessionId) =>
        endRootTurn(owner, { sessionId, originatingPromptId: 'root-prompt', clean: true }, () => {
          currents.set(
            sessionId,
            sessionId === 'session-1'
              ? snapshot([child('alpha', 'running')])
              : snapshot([child('beta', 'running')], {
                  projectId: 'project-2',
                  sessionId: 'session-2'
                })
          )
        })
      )
    )

    currents.set('session-1', snapshot([child('alpha', 'completed')]))
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[0].sessionId).toBe('session-1')

    currents.set(
      'session-2',
      snapshot([child('beta', 'error')], { projectId: 'project-2', sessionId: 'session-2' })
    )
    await owner.onRecordsChanged('session-2')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
      projectId: 'project-2',
      sessionId: 'session-2'
    })
    vi.useRealTimers()
  })

  it('merges children started by an app continuation without dropping pending settlements', async () => {
    vi.useFakeTimers()
    let prompt = 0
    let current = snapshot([])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch,
      createPromptId: () => `wake-${++prompt}`
    })
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        current = snapshot([child('alpha', 'running'), child('beta', 'running')])
      }
    )
    current = snapshot([child('alpha', 'completed'), child('beta', 'running')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(100)

    current = snapshot([child('alpha', 'completed'), child('beta', 'error')])
    await owner.onRecordsChanged('session-1')
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        current = snapshot([
          child('alpha', 'completed'),
          child('beta', 'error'),
          child('gamma', 'running')
        ])
      }
    )
    await owner.onWakePromptEnded('session-1', 'wake-1')
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]?.[0]?.text).toContain('beta')
    expect(dispatch.mock.calls[1]?.[0]?.text).toContain('status=error')
    expect(dispatch.mock.calls[1]?.[0]?.text).toContain(
      '1 watched Subagent Attempt remains running'
    )

    current = snapshot([
      child('alpha', 'completed'),
      child('beta', 'error'),
      child('gamma', 'completed')
    ])
    await owner.onRecordsChanged('session-1')
    await owner.onWakePromptEnded('session-1', 'wake-2')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(dispatch.mock.calls[2]?.[0]?.text).toContain('gamma')
    vi.useRealTimers()
  })

  it('cleans unclean turns and Session invalidation without late continuations', async () => {
    vi.useFakeTimers()
    let current = snapshot([])
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch
    })
    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: false },
      () => {
        current = snapshot([child('alpha', 'running')])
      }
    )
    current = snapshot([child('alpha', 'completed')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(200)
    expect(dispatch).not.toHaveBeenCalled()

    await endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        current = snapshot([child('alpha', 'completed'), child('beta', 'running')])
      }
    )
    current = snapshot([child('alpha', 'completed'), child('beta', 'completed')])
    await owner.onRecordsChanged('session-1')
    owner.invalidateSession('session-1')
    await vi.advanceTimersByTimeAsync(200)
    expect(dispatch).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it.each(['shutdown', 'invalidateAll'] as const)(
    'clears a pending settlement timer on %s',
    async (cleanup) => {
      vi.useFakeTimers()
      let current = snapshot([])
      const dispatch = vi.fn(acceptDispatch)
      const owner = new DelegationSettlementWakeOwner({
        readSnapshot: async () => current,
        dispatch
      })
      await endRootTurn(
        owner,
        { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
        () => {
          current = snapshot([child('alpha', 'running')])
        }
      )
      current = snapshot([child('alpha', 'completed')])
      await owner.onRecordsChanged('session-1')

      owner[cleanup]()
      owner[cleanup]()
      await vi.advanceTimersByTimeAsync(200)

      expect(dispatch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      const nextLease = await owner.onRootTurnStarted({
        sessionId: 'session-1',
        originatingPromptId: 'root-prompt'
      })
      if (cleanup === 'shutdown') expect(nextLease).toBeUndefined()
      else expect(nextLease).toEqual(expect.any(String))
      owner.shutdown()
      owner.invalidateAll()
      await expect(
        owner.onRootTurnStarted({
          sessionId: 'session-1',
          originatingPromptId: 'root-prompt'
        })
      ).resolves.toBeUndefined()
      vi.useRealTimers()
    }
  )

  it.each(['session', 'project', 'shutdown', 'branch', 'all'] as const)(
    'rejects a prior root-turn lease whose terminal callback arrives after %s invalidation',
    async (scope) => {
      vi.useFakeTimers()
      let current = snapshot([child('alpha', 'running')])
      const dispatch = vi.fn(acceptDispatch)
      const owner = new DelegationSettlementWakeOwner({
        readSnapshot: async () => current,
        dispatch
      })
      const leaseId = await owner.onRootTurnStarted({
        sessionId: 'session-1',
        originatingPromptId: 'root-prompt'
      })

      if (scope === 'session') owner.invalidateSession('session-1')
      else if (scope === 'project') await owner.invalidateProject('project-1')
      else if (scope === 'shutdown') owner.shutdown()
      else if (scope === 'all') owner.invalidateAll()
      else await owner.invalidateBranch('session-1', 'root-prompt')

      if (scope === 'shutdown') {
        expect(
          await owner.onRootTurnStarted({
            sessionId: 'session-1',
            originatingPromptId: 'later-root-prompt'
          })
        ).toBeUndefined()
      }

      await owner.onRootTurnEnded({
        sessionId: 'session-1',
        originatingPromptId: 'root-prompt',
        clean: true,
        leaseId
      })
      current = snapshot([child('alpha', 'completed')])
      await owner.onRecordsChanged('session-1')
      await vi.advanceTimersByTimeAsync(200)

      expect(dispatch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    }
  )

  it.each(['session', 'all'] as const)(
    'does not let a rejected stale turn-start snapshot delete a replacement Session state after %s invalidation',
    async (scope) => {
      vi.useFakeTimers()
      let rejectOldSnapshot!: (error: Error) => void
      const oldSnapshot = new Promise<DelegationSettlementSnapshot | undefined>(
        (_resolve, reject) => {
          rejectOldSnapshot = reject
        }
      )
      let reads = 0
      let current = snapshot([], { activeRootPromptIds: ['new-prompt'] })
      const dispatch = vi.fn(acceptDispatch)
      const owner = new DelegationSettlementWakeOwner({
        readSnapshot: async () => {
          reads += 1
          return reads === 1 ? oldSnapshot : current
        },
        dispatch,
        createPromptId: () => 'new-wake'
      })

      const oldStart = owner.onRootTurnStarted({
        sessionId: 'session-1',
        originatingPromptId: 'old-prompt'
      })
      if (scope === 'session') owner.invalidateSession('session-1')
      else owner.invalidateAll()
      const newLease = await owner.onRootTurnStarted({
        sessionId: 'session-1',
        originatingPromptId: 'new-prompt'
      })
      current = snapshot([child('new-child', 'running', { originatingPromptId: 'new-prompt' })], {
        activeRootPromptIds: ['new-prompt']
      })
      await owner.onRootTurnEnded({
        sessionId: 'session-1',
        originatingPromptId: 'new-prompt',
        clean: true,
        leaseId: newLease
      })

      rejectOldSnapshot(new Error('stale snapshot failed'))
      await expect(oldStart).rejects.toThrow('stale snapshot failed')
      current = snapshot([child('new-child', 'completed', { originatingPromptId: 'new-prompt' })], {
        activeRootPromptIds: ['new-prompt']
      })
      await owner.onRecordsChanged('session-1')
      await vi.advanceTimersByTimeAsync(100)

      expect(dispatch).toHaveBeenCalledOnce()
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        originatingPromptId: 'new-prompt',
        promptId: 'new-wake'
      })
      vi.useRealTimers()
    }
  )

  it('ignores an old dispatch failure and terminal callback after reusable cleanup', async () => {
    vi.useFakeTimers()
    let current = snapshot([])
    let rejectOldDispatch!: (reason: Error) => void
    const oldDispatch = new Promise<void>((_resolve, reject) => {
      rejectOldDispatch = reject
    })
    let prompt = 0
    const dispatch = vi.fn((request: DelegationSettlementDispatch) =>
      request.promptId === 'wake-1' ? oldDispatch : Promise.resolve()
    )
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => current,
      dispatch,
      createPromptId: () => `wake-${++prompt}`
    })
    const turn = { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true }
    await endRootTurn(owner, turn, () => {
      current = snapshot([child('old', 'running')])
    })
    current = snapshot([child('old', 'completed')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledOnce()

    owner.invalidateAll()
    await endRootTurn(owner, turn, () => {
      current = snapshot([
        child('old', 'completed'),
        child('new', 'running'),
        child('later', 'running')
      ])
    })
    current = snapshot([
      child('old', 'completed'),
      child('new', 'completed'),
      child('later', 'running')
    ])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1][0].text).toContain('attempt-new')
    expect(dispatch.mock.calls[1][0].text).not.toContain('attempt-old')

    current = snapshot([
      child('old', 'completed'),
      child('new', 'completed'),
      child('later', 'completed')
    ])
    await owner.onRecordsChanged('session-1')
    rejectOldDispatch(new Error('late old failure'))
    await owner.onWakePromptEnded('session-1', 'wake-1')
    await vi.advanceTimersByTimeAsync(500)
    // The new flight is still held; the old callbacks cannot release it or retry its old batch.
    expect(dispatch).toHaveBeenCalledTimes(2)
    await owner.onWakePromptEnded('session-1', 'wake-2')
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(dispatch.mock.calls[2][0].text).toContain('attempt-later')
    expect(dispatch.mock.calls[2][0].text).not.toContain('attempt-old')
    expect(dispatch.mock.calls[2][0].text).not.toContain('attempt-new')
    owner.shutdown()
    vi.useRealTimers()
  })

  it('serializes branch invalidation behind an in-progress root-end snapshot', async () => {
    vi.useFakeTimers()
    let releaseSnapshot!: (value: DelegationSettlementSnapshot) => void
    const firstSnapshot = new Promise<DelegationSettlementSnapshot>((resolve) => {
      releaseSnapshot = resolve
    })
    let current = snapshot([child('alpha', 'running')])
    let reads = 0
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async () => {
        reads += 1
        if (reads === 1) return snapshot([])
        return reads === 2 ? firstSnapshot : current
      },
      dispatch
    })

    const rootEnded = endRootTurn(owner, {
      sessionId: 'session-1',
      originatingPromptId: 'root-prompt',
      clean: true
    })
    const invalidated = owner.invalidateBranch('session-1', 'root-prompt')
    releaseSnapshot(current)
    await Promise.all([rootEnded, invalidated])

    current = snapshot([child('alpha', 'completed')])
    await owner.onRecordsChanged('session-1')
    await vi.advanceTimersByTimeAsync(200)
    expect(dispatch).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('serializes Project invalidation behind every known Session root-end snapshot', async () => {
    vi.useFakeTimers()
    let releaseDeletedSnapshot!: (value: DelegationSettlementSnapshot) => void
    const deletedSnapshot = new Promise<DelegationSettlementSnapshot>((resolve) => {
      releaseDeletedSnapshot = resolve
    })
    let deletedCurrent = snapshot([])
    let retainedCurrent = snapshot([], {
      projectId: 'project-2',
      sessionId: 'session-2'
    })
    const dispatch = vi.fn(acceptDispatch)
    const owner = new DelegationSettlementWakeOwner({
      readSnapshot: async (sessionId) => {
        if (sessionId === 'session-1' && deletedCurrent.attempts[0]?.status === 'running') {
          return deletedSnapshot
        }
        return sessionId === 'session-1' ? deletedCurrent : retainedCurrent
      },
      dispatch
    })

    const deletedRootEnded = endRootTurn(
      owner,
      { sessionId: 'session-1', originatingPromptId: 'root-prompt', clean: true },
      () => {
        deletedCurrent = snapshot([child('deleted-child', 'running')])
      }
    )
    const retainedRootEnded = endRootTurn(
      owner,
      { sessionId: 'session-2', originatingPromptId: 'root-prompt', clean: true },
      () => {
        retainedCurrent = snapshot([child('retained-child', 'running')], {
          projectId: 'project-2',
          sessionId: 'session-2'
        })
      }
    )
    await retainedRootEnded
    const invalidated = owner.invalidateProject('project-1')
    releaseDeletedSnapshot(deletedCurrent)
    await Promise.all([deletedRootEnded, invalidated])

    deletedCurrent = snapshot([child('deleted-child', 'completed')])
    retainedCurrent = snapshot([child('retained-child', 'completed')], {
      projectId: 'project-2',
      sessionId: 'session-2'
    })
    await Promise.all([owner.onRecordsChanged('session-1'), owner.onRecordsChanged('session-2')])
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'project-2',
      sessionId: 'session-2'
    })
    vi.useRealTimers()
  })
})
