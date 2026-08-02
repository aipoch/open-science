import { describe, expect, it, vi } from 'vitest'

import { CompletionGateCoordinator } from './completion-gate'
import { installCompletionGateDiagnostics } from './completion-gate-diagnostics'

describe('completion gate production diagnostics', () => {
  it('publishes only sanitized lifecycle fields and stops publishing after disposal', async () => {
    const debug = vi.fn()
    const warn = vi.fn()
    const broadcast = vi.fn()
    const coordinator = new CompletionGateCoordinator({
      stopOldPrompt: async () => undefined,
      waitForOwnershipRelease: async () => undefined,
      reconfigure: async () => undefined,
      continueAsApproved: async () => undefined,
      reportHandoffFailure: async () => undefined
    })
    const dispose = installCompletionGateDiagnostics(coordinator, {
      log: { debug, warn },
      broadcast
    })
    const context = {
      sessionId: 'trusted-session',
      turnId: 'trusted-turn',
      controlInvocationGeneration: 4,
      toolInvocationId: 'trusted-tool'
    }
    coordinator.arm(context, 'Public Specialist')
    const captured = coordinator.claimCompletion(context, {
      kind: 'returned',
      value: {
        transcript: 'RAW_TRANSCRIPT_MUST_NOT_APPEAR',
        token: 'RAW_TOKEN_MUST_NOT_APPEAR'
      }
    })
    await coordinator.complete(captured, context)

    expect(broadcast).toHaveBeenCalledTimes(5)
    expect(broadcast).toHaveBeenLastCalledWith({
      order: 5,
      kind: 'continuation-started',
      sessionId: 'trusted-session',
      turnId: 'trusted-turn',
      controlInvocationGeneration: 4,
      toolInvocationId: 'trusted-tool',
      handoffGeneration: 1,
      targetName: 'Public Specialist'
    })
    expect(debug).toHaveBeenCalledTimes(5)
    expect(warn).not.toHaveBeenCalled()
    const serialized = JSON.stringify({ broadcasts: broadcast.mock.calls, logs: debug.mock.calls })
    expect(serialized).not.toContain('RAW_TRANSCRIPT_MUST_NOT_APPEAR')
    expect(serialized).not.toContain('RAW_TOKEN_MUST_NOT_APPEAR')

    dispose()
    coordinator.arm(
      { ...context, controlInvocationGeneration: 5, toolInvocationId: 'later-tool' },
      null
    )
    expect(broadcast).toHaveBeenCalledTimes(5)
    expect(debug).toHaveBeenCalledTimes(5)
  })
})
