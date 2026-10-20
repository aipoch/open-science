import { describe, expect, it, vi } from 'vitest'
import type {
  CompletionDisposition,
  CompletionGateRuntime,
  TrustedToolCompletionContext
} from '../agents/completion-gate'
import { withApprovedHandoffOutcome } from './approved-handoff-outcome'
import { withApprovedSpecialistBinding } from '../agents/production-completion-handoff'
import { CompletionGateRuntimeRegistry } from '../agents/completion-gate'

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

describe('approved Handoff outcome boundary', () => {
  it('forwards cancellation cleanup through production wrappers without publishing failure', async () => {
    const cleanupCancelledHandoff = vi.fn(async () => undefined)
    const report = vi.fn(async () => undefined)
    const inner = { ...adapter(), cleanupCancelledHandoff }
    const registry = new CompletionGateRuntimeRegistry()
    registry.register(
      withApprovedHandoffOutcome(
        { captureApprovedHandoffFailure: () => report },
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
  })

  it('does not reuse a cancelled or superseded invocation capture for the next handoff', async () => {
    const previous = vi.fn(async () => undefined)
    const current = vi.fn(async () => undefined)
    const capture = vi.fn().mockReturnValueOnce(previous).mockReturnValueOnce(current)
    const wrapped = withApprovedHandoffOutcome(
      { captureApprovedHandoffFailure: capture },
      adapter()
    )
    // Cancellation may leave the first lifecycle before it calls either continuation or failure.
    await wrapped.stopOldPrompt(context())
    await wrapped.stopOldPrompt(context('session-1', 2))
    await wrapped.reportHandoffFailure(new Error('late previous failure'), handoff, context())
    expect(previous).not.toHaveBeenCalled()
    expect(current).not.toHaveBeenCalled()
    await wrapped.reportHandoffFailure(
      new Error('current failure'),
      handoff,
      context('session-1', 2)
    )
    expect(current).toHaveBeenCalledOnce()
  })

  it('clears successful continuation ownership without clearing a newer invocation', async () => {
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
        captureApprovedHandoffFailure: vi
          .fn()
          .mockReturnValueOnce(previous)
          .mockReturnValueOnce(current)
      },
      inner
    )
    await wrapped.stopOldPrompt(context())
    const continuing = wrapped.continueAsApproved(handoff, context())
    await wrapped.stopOldPrompt(context('session-1', 2))
    release()
    await continuing
    await wrapped.reportHandoffFailure(new Error('late previous failure'), handoff, context())
    await wrapped.reportHandoffFailure(
      new Error('current failure'),
      handoff,
      context('session-1', 2)
    )
    expect(previous).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledOnce()
  })

  it('retains a failed continuation capture but never invents an unadmitted failure', async () => {
    const report = vi.fn(async () => undefined)
    const inner = adapter()
    inner.continueAsApproved = async () => {
      throw new Error('continuation rejected')
    }
    const wrapped = withApprovedHandoffOutcome(
      {
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
