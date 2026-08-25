import { describe, expect, it, vi } from 'vitest'

import { bindComputeApprovalSessionLifecycle } from './approval-session-lifecycle'

describe('compute approval Session lifecycle', () => {
  it('cancels approvals with the current turn and reopens them for the next turn', () => {
    const onSessionCancellationRequested = vi.fn()
    const onSessionTurnStarted = vi.fn()
    const compute = {
      approvalCancelSession: vi.fn(),
      approvalCompleteSessionCancellation: vi.fn(),
      approvalCancelAll: vi.fn()
    }
    const lifecycle = bindComputeApprovalSessionLifecycle(
      { onSessionCancellationRequested, onSessionTurnStarted },
      compute
    )

    lifecycle.onSessionCancellationRequested?.('session-1')
    lifecycle.onSessionTurnStarted?.('session-1', 'turn-2')

    expect(compute.approvalCancelSession).toHaveBeenCalledWith('session-1')
    expect(compute.approvalCompleteSessionCancellation).toHaveBeenCalledWith('session-1')
    expect(onSessionCancellationRequested).toHaveBeenCalledWith('session-1')
    expect(onSessionTurnStarted).toHaveBeenCalledWith('session-1', 'turn-2')
  })

  it('cancels approvals when a Session becomes unavailable or all Sessions stop', () => {
    const onSessionUnavailable = vi.fn()
    const onAllSessionsCancellationRequested = vi.fn()
    const compute = {
      approvalCancelSession: vi.fn(),
      approvalCompleteSessionCancellation: vi.fn(),
      approvalCancelAll: vi.fn()
    }
    const lifecycle = bindComputeApprovalSessionLifecycle(
      { onSessionUnavailable, onAllSessionsCancellationRequested },
      compute
    )

    lifecycle.onSessionUnavailable?.('session-1')
    lifecycle.onAllSessionsCancellationRequested?.()

    expect(compute.approvalCancelSession).toHaveBeenCalledWith('session-1')
    expect(compute.approvalCancelAll).toHaveBeenCalledOnce()
    expect(onSessionUnavailable).toHaveBeenCalledWith('session-1')
    expect(onAllSessionsCancellationRequested).toHaveBeenCalledOnce()
  })
})
