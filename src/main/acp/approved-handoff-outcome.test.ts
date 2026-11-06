import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  CompletionDisposition,
  CompletionGateRuntime,
  TrustedToolCompletionContext
} from '../agents/completion-gate'
import { withApprovedHandoffOutcome } from './approved-handoff-outcome'
import { withApprovedSpecialistBinding } from '../agents/production-completion-handoff'
import { CompletionGateCoordinator, CompletionGateRuntimeRegistry } from '../agents/completion-gate'
import {
  CompletionHandoffLifecycle,
  InMemoryCompletionHandoffRepository
} from '../agents/completion-handoff-lifecycle'
import { AcpGenerationActivityOwner } from './generation-activity-owner'
import {
  ACP_IDLE_RELEASE_DELAY_MS,
  AcpConnectionTransitionOwner
} from './connection-transition-owner'

const context = (sessionId = 'session-1', generation = 1): TrustedToolCompletionContext => ({
  sessionId,
  turnId: `turn-${generation}`,
  toolInvocationId: `tool-${generation}`,
  controlInvocationGeneration: generation
})
const handoff: Extract<CompletionDisposition, { kind: 'capture-for-handoff' }> = {
  kind: 'capture-for-handoff',
  targetName: 'Specialist',
  generation: 1,
  envelope: { kind: 'returned', value: { status: 'approved' } }
}
const adapter = (): CompletionGateRuntime => ({
  stopOldPrompt: vi.fn(async () => undefined),
  waitForOwnershipRelease: vi.fn(async () => undefined),
  reconfigure: vi.fn(async () => undefined),
  continueAsApproved: vi.fn(async () => undefined),
  reportHandoffFailure: vi.fn(async () => undefined)
})

const createProcess = (): {
  hold: Mock<() => Mock>
  restoreSession: Mock<() => Promise<void>>
} => ({
  hold: vi.fn(() => vi.fn()),
  restoreSession: vi.fn(async (): Promise<void> => undefined)
})
let process = createProcess()
beforeEach(() => {
  process = createProcess()
})

describe('approved Handoff outcome boundary', () => {
  it.each([
    'ownership-release',
    'reconfigure',
    'failure',
    'non-durable',
    'reconfigure-transition',
    'continuation-transition'
  ] as const)(
    'releases the provider idle hold when a handoff is superseded during %s',
    async (stage) => {
      vi.useFakeTimers()
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const leases: Array<() => void> = []
      const disconnect = vi.fn(async () => undefined)
      const activity = new AcpGenerationActivityOwner({
        activityChanged: () => transitions.activityChanged(),
        hasActivePrompts: () => false,
        hasActiveReviewerSessions: () => false
      })
      const transitions = new AcpConnectionTransitionOwner({
        blockers: () => activity.blockers(),
        connectionGeneration: () => 1,
        cleanupConfirmed: () => true,
        disconnect,
        onRetired: () => undefined,
        publishIdle: () => undefined,
        recoverFailedDeferredDisconnect: () => undefined,
        reportFailure: () => undefined
      })
      const pause = async (): Promise<void> => {
        entered.resolve()
        await resume.promise
        if (stage === 'failure') throw new Error('ownership release failed')
      }
      const inner = {
        ...adapter(),
        stopOldPrompt: async () => transitions.requestIdleRelease(),
        waitForOwnershipRelease:
          stage === 'reconfigure' || stage.endsWith('-transition') ? async () => undefined : pause,
        reconfigure: stage === 'reconfigure' ? pause : vi.fn(async () => undefined)
      }
      const wrapped = withApprovedSpecialistBinding(
        withApprovedHandoffOutcome(
          {
            captureApprovedHandoffFailure: () => undefined,
            captureHandoffProcess: () => ({
              hold: () => {
                const held = Promise.withResolvers<void>()
                void activity.withOperation(() => held.promise)
                const release = (): void => {
                  transitions.requestIdleRelease()
                  held.resolve()
                }
                leases.push(release)
                return release
              },
              restoreSession: async () => undefined
            })
          },
          inner
        ),
        {
          getSpecialistBinding: () => 'approved',
          getSpecialist: () => ({ name: 'Specialist', revision: 1, enabled: true })
        }
      )
      const invocation = context()
      const repository = new InMemoryCompletionHandoffRepository()
      const lifecycle = new CompletionHandoffLifecycle(
        repository,
        wrapped,
        Date.now,
        undefined,
        async () => ({ specialistId: 'approved', revision: 1 })
      )
      try {
        let running: Promise<unknown>
        let supersede: () => Promise<unknown>
        if (stage === 'non-durable') {
          const gate = new CompletionGateCoordinator(wrapped)
          await gate.arm(invocation, 'Specialist')
          running = gate.complete(gate.claimCompletion(invocation, handoff.envelope), invocation)
          supersede = async () => gate.arm(context('session-1', 2), 'Specialist')
        } else {
          await lifecycle.approve({ context: invocation, targetName: 'Specialist', generation: 1 })
          await lifecycle.capture(invocation, handoff.envelope)
          if (stage.endsWith('-transition')) {
            const update = repository.update.bind(repository)
            let transitions = 0
            vi.spyOn(repository, 'update').mockImplementation(async (context, mutate) => {
              if (++transitions === (stage === 'reconfigure-transition' ? 2 : 3)) await pause()
              return update(context, mutate)
            })
          }
          running = lifecycle.run(invocation)
          supersede = async () => {
            await lifecycle.approve({
              context: invocation,
              targetName: 'Specialist',
              generation: 2
            })
            await lifecycle.capture(invocation, handoff.envelope)
          }
        }
        await entered.promise
        expect(activity.blockers().retirement).toBe(true)
        expect(disconnect).not.toHaveBeenCalled()
        await supersede()
        resume.resolve()
        await running
        expect(activity.blockers().retirement).toBe(false)
        await vi.advanceTimersByTimeAsync(ACP_IDLE_RELEASE_DELAY_MS)
        await transitions.barrier
        expect(disconnect).toHaveBeenCalledOnce()
        expect(inner.continueAsApproved).not.toHaveBeenCalled()
        expect(inner.reportHandoffFailure).not.toHaveBeenCalled()
        if (stage !== 'non-durable')
          expect((await repository.get(invocation))?.stage).toBe('switching')
      } finally {
        resume.resolve()
        for (const release of leases) release()
        transitions.resetReconnect()
        vi.useRealTimers()
      }
    }
  )

  it('releases failed handoffs and rejects a retry cancelled during provider restore', async () => {
    let finishRestore!: () => void
    process.restoreSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRestore = resolve
        })
    )
    const inner = { ...adapter(), canHandle: () => false }
    const wrapped = withApprovedHandoffOutcome(
      {
        captureHandoffProcess: () => process,
        captureApprovedHandoffFailure: () => undefined
      },
      inner
    )
    await wrapped.stopOldPrompt(context())
    await wrapped.reportHandoffFailure(new Error('configuration failed'), handoff, context())
    expect(process.hold.mock.results[0].value).toHaveBeenCalledOnce()
    const registry = new CompletionGateRuntimeRegistry()
    registry.register(wrapped)
    const retry = registry.continueAsApproved(handoff, context())
    const rejected = expect(retry).rejects.toThrow('superseded')
    await registry.cleanupCancelledHandoff(context())
    finishRestore()
    await rejected
    expect(process.hold.mock.results[1].value).toHaveBeenCalledOnce()
    expect(inner.continueAsApproved).not.toHaveBeenCalled()
    expect(wrapped.canHandle!(context())).toBe(false)
  })

  it('forwards cancellation cleanup through production wrappers without publishing failure', async () => {
    const cleanupCancelledHandoff = vi.fn(async () => undefined)
    const report = vi.fn(async () => undefined)
    const inner = { ...adapter(), cleanupCancelledHandoff }
    const registry = new CompletionGateRuntimeRegistry()
    registry.register(
      withApprovedHandoffOutcome(
        {
          captureHandoffProcess: () => process,
          captureApprovedHandoffFailure: () => report
        },
        withApprovedSpecialistBinding(inner, {
          getSpecialistBinding: () => undefined,
          getSpecialist: () => undefined
        })
      )
    )
    await registry.stopOldPrompt(context())
    await registry.cleanupCancelledHandoff(context())
    expect(cleanupCancelledHandoff).toHaveBeenCalledWith(context())
    expect(report).not.toHaveBeenCalled()
    expect(inner.reportHandoffFailure).not.toHaveBeenCalled()
    expect(process.hold.mock.results[0].value).toHaveBeenCalledOnce()
  })
  it('captures admitted ownership before stopping and reports even if adapter cleanup fails', async () => {
    const order: string[] = []
    const report = vi.fn(async () => {
      order.push('persist-failure')
    })
    const inner = adapter()
    inner.stopOldPrompt = async () => {
      order.push('stop')
    }
    inner.reportHandoffFailure = async () => {
      throw new Error('cleanup failed')
    }
    const wrapped = withApprovedHandoffOutcome(
      {
        captureHandoffProcess: () => process,
        captureApprovedHandoffFailure: () => {
          order.push('capture')
          return report
        }
      },
      inner
    )
    await wrapped.stopOldPrompt(context())
    await expect(
      wrapped.reportHandoffFailure(new Error('switch failed'), handoff, context())
    ).rejects.toThrow('cleanup failed')
    expect(order).toEqual(['capture', 'stop', 'persist-failure'])
    await expect(
      wrapped.reportHandoffFailure(new Error('duplicate'), handoff, context())
    ).rejects.toThrow('cleanup failed')
    expect(report).toHaveBeenCalledOnce()
    expect(process.hold.mock.results[0].value).toHaveBeenCalledOnce()
  })

  it('does not reuse a cancelled or superseded invocation capture for the next handoff', async () => {
    const previous = vi.fn(async () => undefined)
    const current = vi.fn(async () => undefined)
    const capture = vi.fn().mockReturnValueOnce(previous).mockReturnValueOnce(current)
    const wrapped = withApprovedHandoffOutcome(
      { captureHandoffProcess: () => process, captureApprovedHandoffFailure: capture },
      adapter()
    )
    // Cancellation may leave the first lifecycle before it calls either continuation or failure.
    await wrapped.stopOldPrompt(context())
    await wrapped.stopOldPrompt(context('session-1', 2))
    await wrapped.reportHandoffFailure(new Error('late previous failure'), handoff, context())
    expect(previous).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
    expect(process.hold.mock.results[0].value).toHaveBeenCalledOnce()
    expect(process.hold.mock.results[1].value).not.toHaveBeenCalled()
    await wrapped.reportHandoffFailure(
      new Error('current failure'),
      handoff,
      context('session-1', 2)
    )
    expect(current).toHaveBeenCalledOnce()
    expect(process.hold.mock.results[1].value).toHaveBeenCalledOnce()
  })

  it('does not let a superseded generation clear the same context’s new capture', async () => {
    const previous = vi.fn(async () => undefined)
    const current = vi.fn(async () => undefined)
    const inner = adapter()
    let release!: () => void
    inner.continueAsApproved = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const wrapped = withApprovedHandoffOutcome(
      {
        captureHandoffProcess: () => process,
        captureApprovedHandoffFailure: vi
          .fn()
          .mockReturnValueOnce(previous)
          .mockReturnValueOnce(current)
      },
      inner
    )
    await wrapped.stopOldPrompt(context(), 1)
    const continuing = wrapped.continueAsApproved(handoff, context())
    await wrapped.stopOldPrompt(context(), 2)
    wrapped.releaseSupersededHandoff!(context(), 1)
    release()
    await continuing
    await wrapped.reportHandoffFailure(new Error('late previous failure'), handoff, context())
    expect(process.hold.mock.results[1].value).not.toHaveBeenCalled()
    await wrapped.reportHandoffFailure(
      new Error('current failure'),
      { ...handoff, generation: 2 },
      context()
    )
    expect(previous).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledOnce()
    expect(process.hold.mock.results[1].value).toHaveBeenCalledOnce()
  })

  it('retains a failed continuation capture but never invents an unadmitted failure', async () => {
    const report = vi.fn(async () => undefined)
    const inner = adapter()
    inner.continueAsApproved = async () => {
      throw new Error('continuation rejected')
    }
    const wrapped = withApprovedHandoffOutcome(
      {
        captureHandoffProcess: () => process,
        captureApprovedHandoffFailure: (id) => (id === 'session-1' ? report : undefined)
      },
      inner
    )
    await wrapped.stopOldPrompt(context())
    await expect(wrapped.continueAsApproved(handoff, context())).rejects.toThrow(
      'continuation rejected'
    )
    await wrapped.reportHandoffFailure(new Error('continuation rejected'), handoff, context())
    await wrapped.stopOldPrompt(context('unadmitted'))
    await wrapped.reportHandoffFailure(
      new Error('operation failed'),
      handoff,
      context('unadmitted')
    )
    expect(report).toHaveBeenCalledOnce()
    expect(inner.reportHandoffFailure).toHaveBeenCalledTimes(2)
  })

  it('does not silently evict another Session’s live failure authority', async () => {
    const reports = Array.from({ length: 101 }, () => vi.fn(async () => undefined))
    const wrapped = withApprovedHandoffOutcome(
      {
        captureHandoffProcess: () => process,
        captureApprovedHandoffFailure: (id) => reports[Number(id)]
      },
      adapter()
    )
    for (let index = 0; index < reports.length; index++)
      await wrapped.stopOldPrompt(context(String(index)))
    for (let index = 0; index < reports.length; index++) {
      await wrapped.reportHandoffFailure(
        new Error('configuration failed'),
        handoff,
        context(String(index))
      )
      expect(reports[index]).toHaveBeenCalledOnce()
    }
  })
})
