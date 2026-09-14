import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  BackgroundResultDelivery,
  BackgroundResultSourceRef
} from '../../shared/background-result-delivery'
import { BackgroundResultDeliveryOwner } from './owner'
import { composeApplicationRuntime } from '../application-runtime'

const delivery = (
  sourceId: string,
  overrides: Partial<BackgroundResultDelivery> = {}
): BackgroundResultDelivery => ({
  id: `local-run:${sourceId}`,
  sourceKind: 'local-run',
  sourceId,
  projectId: 'project-1',
  sessionId: 'session-1',
  state: 'claimed',
  attemptCount: 0,
  claimToken: 'claim-1',
  claimExpiresAt: 2_000,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = (resolved: 'terminal' | 'not-ready' | 'missing' = 'terminal') => {
  const rows = [delivery('run-1')]
  const repository = {
    register: vi.fn(),
    enqueue: vi.fn(),
    findBySource: vi.fn<
      (source: BackgroundResultSourceRef) => Promise<BackgroundResultDelivery | undefined>
    >(async () => undefined),
    listContinuation: vi.fn<
      (sessionId: string, continuationMessageId: string) => Promise<BackgroundResultDelivery[]>
    >(async () => []),
    consumeContinuation: vi.fn(async () => 0),
    acknowledgeObserved: vi.fn(async () => ({
      delivery: delivery('run-1', { state: 'consumed', claimToken: undefined }),
      transitioned: true
    })),
    recoverExpiredClaims: vi.fn(async () => 0),
    listPendingSessionIds: vi.fn(async () => []),
    listOwnership: vi.fn(async () => []),
    deleteIds: vi.fn(async () => 0),
    listSessionIdsForProject: vi.fn(async () => []),
    deleteSession: vi.fn(async () => 0),
    deleteProject: vi.fn(async () => 0),
    claimPending: vi.fn(async () => rows),
    prepareContinuation: vi.fn(async () => 1),
    beginDispatch: vi.fn(async () => 1),
    markConsumed: vi.fn(async () => 1),
    areConsumed: vi.fn(async () => false),
    releaseClaim: vi.fn(async () => 1),
    failClaim: vi.fn(async () => 'pending' as const)
  }
  const waitForAuthoritiesReady = vi.fn(async (): Promise<void> => undefined)
  const loadSessionCatalog = vi.fn(async () => ({ complete: false, sessions: [] }))
  const resolveSources = vi.fn(async () =>
    rows.map((row) => ({
      delivery: row,
      availability: resolved,
      activity: { ...row, active: false, needsAttention: false },
      ...(resolved === 'terminal'
        ? { outcome: { sourceKind: 'local-run', runId: row.sourceId, resultSummary: '42' } }
        : {})
    }))
  )
  const continuationResult = {
    stopReason: 'end_turn',
    continuationMessageId: 'continuation-1'
  }
  const sendContinuation = vi.fn(() => ({
    admitted: Promise.resolve(),
    result: Promise.resolve(continuationResult)
  }))
  const isContinuationSaved = vi.fn(async () => true)
  const owner = new BackgroundResultDeliveryOwner({
    repository,
    resolveSources,
    waitForAuthoritiesReady,
    loadSessionCatalog,
    sendContinuation,
    isContinuationSaved,
    canStartSessionTurn: async () => true,
    createId: () => 'claim-1',
    now: () => 1_000
  })
  return {
    owner,
    repository,
    waitForAuthoritiesReady,
    loadSessionCatalog,
    resolveSources,
    sendContinuation,
    isContinuationSaved
  }
}

describe('BackgroundResultDeliveryOwner', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['authority', 'source', 'dispatch'] as const)(
    'does not start a continuation when %s work finishes after disposal',
    async (stage) => {
      const { owner, repository, waitForAuthoritiesReady, resolveSources, sendContinuation } =
        harness()
      const entered = deferred()
      const resume = deferred()
      const pause = async (): Promise<void> => {
        entered.resolve()
        await resume.promise
      }
      if (stage === 'authority') waitForAuthoritiesReady.mockImplementationOnce(pause)
      else if (stage === 'source') {
        const resolve = resolveSources.getMockImplementation()!
        resolveSources.mockImplementationOnce(async () => {
          await pause()
          return resolve()
        })
      } else
        repository.beginDispatch.mockImplementationOnce(async () => {
          await pause()
          return 1
        })
      const drain = owner.drainSession('session-1')
      await entered.promise
      owner.dispose()
      resume.resolve()
      await drain

      expect(sendContinuation).not.toHaveBeenCalled()
      expect(repository.failClaim).not.toHaveBeenCalled()
      if (stage === 'authority') expect(repository.claimPending).not.toHaveBeenCalled()
      else expect(repository.releaseClaim).toHaveBeenCalledWith(['local-run:run-1'], 'claim-1')
    }
  )

  it('does not recreate a delivery timer when an enqueue finishes after disposal', async () => {
    vi.useFakeTimers()
    const { owner, repository, sendContinuation } = harness()
    const entered = deferred()
    const resume = deferred()
    repository.enqueue.mockImplementationOnce(async () => {
      entered.resolve()
      await resume.promise
      return delivery('run-1', { state: 'pending' })
    })
    try {
      const enqueue = owner.enqueue(delivery('run-1'))
      await entered.promise
      owner.dispose()
      resume.resolve()
      await enqueue
      await vi.advanceTimersByTimeAsync(1_000)
      expect(sendContinuation).not.toHaveBeenCalled()
      expect(repository.claimPending).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      owner.dispose()
      vi.useRealTimers()
    }
  })

  it('does not resume delivery after a later-owned module times out during runtime disposal', async () => {
    vi.useFakeTimers()
    const { owner, waitForAuthoritiesReady, sendContinuation } = harness()
    const ready = deferred()
    waitForAuthoritiesReady.mockReturnValueOnce(ready.promise)
    try {
      const runtime = await composeApplicationRuntime(async (modules) => {
        await modules.add(undefined, () => ({ capability: owner, dispose: () => owner.dispose() }))
        await modules.add(undefined, () => ({
          name: 'stalled-backend',
          capability: undefined,
          disposeTimeoutMs: 10,
          dispose: () => new Promise<void>(() => undefined)
        }))
        return {}
      })
      const drain = owner.drainSession('session-1')
      const disposed = expect(runtime.dispose()).rejects.toThrow(
        'Application runtime disposal failed'
      )
      await vi.advanceTimersByTimeAsync(10)
      await disposed
      ready.resolve()
      await drain
      expect(sendContinuation).not.toHaveBeenCalled()
    } finally {
      ready.resolve()
      owner.dispose()
      vi.useRealTimers()
    }
  })

  it('stops recovery after disposal while waiting for authority', async () => {
    const { owner, repository, waitForAuthoritiesReady } = harness()
    const ready = deferred()
    waitForAuthoritiesReady.mockReturnValueOnce(ready.promise)
    const recovery = owner.recover()
    owner.dispose()
    ready.resolve()
    await recovery
    expect(repository.listOwnership).not.toHaveBeenCalled()
    expect(repository.recoverExpiredClaims).not.toHaveBeenCalled()
  })

  it('settles a continuation sent before disposal without starting another turn', async () => {
    const { owner, repository, sendContinuation } = harness()
    const sent = deferred()
    const result = deferred()
    sendContinuation.mockImplementationOnce(() => {
      sent.resolve()
      return {
        admitted: Promise.resolve(),
        result: result.promise.then(() => ({
          stopReason: 'end_turn',
          continuationMessageId: 'claim-1'
        }))
      }
    })
    const drain = owner.drainSession('session-1')
    await sent.promise
    owner.dispose()
    result.resolve()
    await expect(drain).resolves.toBe('consumed')
    expect(repository.markConsumed).toHaveBeenCalledOnce()
    expect(sendContinuation).toHaveBeenCalledOnce()
  })

  it('retains failure accounting for a continuation sent before disposal', async () => {
    const { owner, repository, sendContinuation } = harness()
    const sent = deferred()
    const finish = deferred()
    sendContinuation.mockImplementationOnce(() => {
      sent.resolve()
      return {
        admitted: Promise.resolve(),
        result: finish.promise.then(() => {
          throw new Error('Provider failed after admission.')
        })
      }
    })
    const drain = owner.drainSession('session-1')
    await sent.promise
    owner.dispose()
    finish.resolve()
    await expect(drain).resolves.toBe('queued')
    expect(repository.failClaim).toHaveBeenCalledWith(['local-run:run-1'], 'claim-1', 3)
    expect(repository.releaseClaim).not.toHaveBeenCalled()
    expect(sendContinuation).toHaveBeenCalledOnce()
  })

  it('does not spend an unsent missing result attempt after a mixed batch release finishes during disposal', async () => {
    const { owner, repository, resolveSources, sendContinuation } = harness()
    const rows = [delivery('run-1'), delivery('run-2')]
    repository.claimPending.mockResolvedValueOnce(rows)
    resolveSources.mockResolvedValueOnce(
      rows.map((row, index) => ({
        delivery: row,
        availability: index === 0 ? 'not-ready' : 'missing',
        activity: { ...row, active: false, needsAttention: false }
      }))
    )
    const releasing = deferred()
    const resume = deferred()
    repository.releaseClaim.mockImplementationOnce(async () => {
      releasing.resolve()
      await resume.promise
      return 1
    })
    const drain = owner.drainSession('session-1')
    await releasing.promise
    owner.dispose()
    resume.resolve()
    await drain
    expect(repository.failClaim).not.toHaveBeenCalled()
    expect(repository.releaseClaim).toHaveBeenLastCalledWith(
      ['local-run:run-1', 'local-run:run-2'],
      'claim-1'
    )
    expect(sendContinuation).not.toHaveBeenCalled()
  })

  it('waits for authority recovery before claiming pending rows', async () => {
    const { owner, repository, waitForAuthoritiesReady } = harness()
    let ready!: () => void
    waitForAuthoritiesReady.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve
        })
    )
    const drain = owner.drainSession('session-1')
    await Promise.resolve()
    expect(repository.claimPending).not.toHaveBeenCalled()
    ready()
    await drain
    expect(repository.claimPending).toHaveBeenCalledOnce()
    owner.dispose()
  })

  it('snapshots delivery candidates before the Session catalog to avoid deleting new admissions', async () => {
    const { owner, repository, loadSessionCatalog } = harness()
    const order: string[] = []
    repository.listOwnership.mockImplementationOnce(async () => {
      order.push('ownership')
      return []
    })
    loadSessionCatalog.mockImplementationOnce(async () => {
      order.push('catalog')
      return { complete: true, sessions: [] }
    })

    await owner.recover()

    expect(order).toEqual(['ownership', 'catalog'])
    expect(repository.deleteIds).toHaveBeenCalledWith([])
    owner.dispose()
  })

  it('settles a complete saved batch before direct observation can split its membership', async () => {
    const { owner, repository, isContinuationSaved } = harness()
    const first = delivery('run-1', {
      state: 'pending',
      claimToken: undefined,
      claimExpiresAt: undefined,
      continuationMessageId: 'continuation-existing'
    })
    const second = delivery('run-2', {
      state: 'pending',
      claimToken: undefined,
      claimExpiresAt: undefined,
      continuationMessageId: 'continuation-existing'
    })
    repository.findBySource.mockResolvedValueOnce(first)
    repository.listContinuation.mockResolvedValueOnce([first, second])

    await expect(
      owner.acknowledgeObserved({
        sourceKind: 'local-run',
        sourceId: 'run-1',
        projectId: 'project-1',
        sessionId: 'session-1'
      })
    ).resolves.toBe('committed')

    expect(isContinuationSaved).toHaveBeenCalledWith({
      sessionId: 'session-1',
      continuationMessageId: 'continuation-existing',
      deliveryIds: ['local-run:run-1', 'local-run:run-2']
    })
    expect(repository.consumeContinuation).toHaveBeenCalledWith(
      'session-1',
      'continuation-existing'
    )
    expect(repository.acknowledgeObserved).not.toHaveBeenCalled()
    owner.dispose()
  })

  it('does not spend an attempt when the source authority is not ready', async () => {
    const { owner, repository, sendContinuation } = harness('not-ready')
    await expect(owner.drainSession('session-1')).resolves.toBe('queued')
    expect(repository.releaseClaim).toHaveBeenCalledWith(['local-run:run-1'], 'claim-1')
    expect(repository.failClaim).not.toHaveBeenCalled()
    expect(sendContinuation).not.toHaveBeenCalled()
    owner.dispose()
  })

  it('spends an attempt for a positively missing source', async () => {
    const { owner, repository } = harness('missing')
    await owner.drainSession('session-1')
    expect(repository.failClaim).toHaveBeenCalledWith(['local-run:run-1'], 'claim-1', 3)
    owner.dispose()
  })

  it('checks a recovered continuation before resolving or sending again', async () => {
    const { owner, repository, resolveSources, sendContinuation } = harness()
    repository.claimPending.mockResolvedValueOnce([
      delivery('run-1', { continuationMessageId: 'continuation-existing' })
    ])
    await expect(owner.drainSession('session-1')).resolves.toBe('consumed')
    expect(resolveSources).not.toHaveBeenCalled()
    expect(sendContinuation).not.toHaveBeenCalled()
    expect(repository.markConsumed).toHaveBeenCalledWith(
      ['local-run:run-1'],
      'claim-1',
      'continuation-existing'
    )
    owner.dispose()
  })

  it('builds the continuation only from transient resolved outcomes', async () => {
    const { owner, sendContinuation } = harness()
    await expect(owner.drainSession('session-1')).resolves.toBe('consumed')
    expect(sendContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('"resultSummary":"42"')
      })
    )
    owner.dispose()
  })

  it('keeps Session deletion fenced until provider admission finishes', async () => {
    const { owner, sendContinuation } = harness()
    const admission = deferred()
    const turn = deferred()
    sendContinuation.mockImplementationOnce(() => ({
      admitted: admission.promise,
      result: turn.promise.then(() => ({
        stopReason: 'end_turn',
        continuationMessageId: 'continuation-1'
      }))
    }))

    const drain = owner.drainSession('session-1')
    await vi.waitFor(() => expect(sendContinuation).toHaveBeenCalledOnce())
    let prepared = false
    const prepare = owner.prepareSessionDeletion('project-1', 'session-1').then(() => {
      prepared = true
    })
    await Promise.resolve()
    expect(prepared).toBe(false)

    admission.resolve()
    await prepare
    expect(prepared).toBe(true)
    turn.resolve()
    await drain
    owner.dispose()
  })

  it.each([
    ['register', 'Session'],
    ['enqueue', 'Session'],
    ['register', 'Project'],
    ['enqueue', 'Project']
  ] as const)(
    'waits for an in-flight %s before %s deletion removes rows',
    async (operation, target) => {
      const { owner, repository } = harness()
      const write = deferred()
      const rows = new Set<string>()
      const source = delivery('run-1', { state: 'pending' })
      repository[operation].mockImplementationOnce(async () => {
        await write.promise
        rows.add(source.id)
        return source
      })
      const removeRows = async (): Promise<number> => {
        const count = rows.size
        rows.clear()
        return count
      }
      repository.deleteSession.mockImplementationOnce(removeRows)
      repository.deleteProject.mockImplementationOnce(removeRows)

      const mutation = owner[operation](source)
      await vi.waitFor(() => expect(repository[operation]).toHaveBeenCalledOnce())
      let prepared = false
      const deletion = (async () => {
        if (target === 'Session') {
          await owner.prepareSessionDeletion(source.projectId, source.sessionId)
          prepared = true
          await owner.commitSessionDeletion(source.projectId, source.sessionId)
        } else {
          // The first admission has not written its row, so the repository cannot list this Session.
          await owner.prepareProjectDeletion(source.projectId)
          prepared = true
          await owner.commitProjectDeletion(source.projectId)
        }
      })()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(prepared).toBe(false)

      write.resolve()
      await Promise.all([mutation, deletion])
      expect(prepared).toBe(true)
      expect(rows.size).toBe(0)
      await expect(owner[operation](source)).resolves.toBeUndefined()
      expect(repository[operation]).toHaveBeenCalledOnce()
      owner.dispose()
    }
  )

  it('suppresses queued observations once Session deletion is fenced', async () => {
    const { owner, repository } = harness()
    const write = deferred()
    const source = delivery('run-1')
    repository.register.mockImplementationOnce(async () => {
      await write.promise
      return source
    })
    const registration = owner.register(source)
    await vi.waitFor(() => expect(repository.register).toHaveBeenCalledOnce())
    const observation = owner.acknowledgeObserved(source)
    const deletion = owner.prepareSessionDeletion(source.projectId, source.sessionId)
    write.resolve()

    await Promise.all([registration, deletion])
    await expect(observation).resolves.toBe('suppressed')
    expect(repository.acknowledgeObserved).not.toHaveBeenCalled()
    owner.dispose()
  })

  it('allows a delivery Turn to observe a result after provider admission', async () => {
    const { owner, sendContinuation } = harness()
    sendContinuation.mockImplementationOnce(() => ({
      admitted: Promise.resolve(),
      result: owner
        .acknowledgeObserved({
          sourceKind: 'local-run',
          sourceId: 'run-1',
          projectId: 'project-1',
          sessionId: 'session-1'
        })
        .then(() => ({
          stopReason: 'end_turn',
          continuationMessageId: 'continuation-1'
        }))
    }))

    await expect(owner.drainSession('session-1')).resolves.toBe('consumed')
    owner.dispose()
  })

  it('handles both continuation promises when admission fails', async () => {
    const { owner, sendContinuation, repository } = harness()
    const failure = new Error('Session resume failed')
    sendContinuation.mockImplementationOnce(() => ({
      admitted: Promise.reject(failure),
      result: Promise.reject(failure)
    }))

    await expect(owner.drainSession('session-1')).resolves.toBe('queued')
    expect(repository.failClaim).toHaveBeenCalledWith(['local-run:run-1'], 'claim-1', 3)
    owner.dispose()
  })
})
