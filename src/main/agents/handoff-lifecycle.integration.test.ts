import { describe, expect, it, vi } from 'vitest'

import {
  CompletionGateCoordinator,
  runCompletionGatedTool,
  type CompletionGateRuntime,
  type TrustedToolCompletionContext
} from './completion-gate'
import { HandoffLifecycleCoordinator } from './handoff-lifecycle'

const trustedContext: TrustedToolCompletionContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'tool-1',
  originatingUserMessageId: 'user-1',
  attachmentIds: ['upload-1'],
  artifactIds: ['artifact-1']
}

const createRuntime = (): {
  runtime: CompletionGateRuntime
  continuationContexts: unknown[]
} => {
  const continuationContexts: unknown[] = []
  const runtime: CompletionGateRuntime = {
    stopOldPrompt: vi.fn(async () => undefined),
    waitForOwnershipRelease: vi.fn(async () => undefined),
    reconfigure: vi.fn(async () => undefined),
    continueAsApproved: vi.fn(async (_handoff, _context, continuationContext) => {
      continuationContexts.push(continuationContext)
    }),
    reportHandoffFailure: vi.fn(async () => undefined)
  }
  return { runtime, continuationContexts }
}

describe('handoff lifecycle coordinator', () => {
  it('retains awaiting approval and emits an exact removal when approval declines', () => {
    const onChange = vi.fn()
    const lifecycle = new HandoffLifecycleCoordinator({ onChange })
    const approvalContext = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      originatingTurnId: 'turn-1',
      originatingUserMessageId: 'user-1',
      toolInvocationId: 'tool-1',
      target: { kind: 'specialist' as const, name: 'Data analyst' },
      attachmentIds: ['upload-1'],
      artifactIds: ['artifact-1']
    }

    lifecycle.onAwaitingApproval(approvalContext)
    const pendingEvent = lifecycle.getEvents('session-1')[0]
    expect(pendingEvent?.phase).toBe('awaiting-approval')

    lifecycle.settleApproval(approvalContext, false)
    expect(lifecycle.getEvents('session-1')).toEqual([])
    expect(onChange).toHaveBeenLastCalledWith({
      kind: 'remove',
      sessionId: 'session-1',
      eventIds: [pendingEvent?.id]
    })
  })

  it('carries a captured result and original-turn resource provenance into the continuation', async () => {
    const lifecycle = new HandoffLifecycleCoordinator()
    const { runtime, continuationContexts } = createRuntime()
    const coordinator = new CompletionGateCoordinator(runtime, lifecycle)
    coordinator.arm(trustedContext, 'Data analyst')

    await runCompletionGatedTool({
      coordinator,
      context: trustedContext,
      deliverToCurrentPrompt: async () => undefined,
      execute: async () => ({ rows: 42 })
    })

    expect(continuationContexts).toEqual([
      {
        sessionId: 'session-1',
        originatingTurnId: 'turn-1',
        originatingUserMessageId: 'user-1',
        toolInvocationId: 'tool-1',
        target: { kind: 'specialist', name: 'Data analyst' },
        completion: { kind: 'returned', value: { rows: 42 } },
        switchReadback: { target: { kind: 'specialist', name: 'Data analyst' } },
        attachmentIds: ['upload-1'],
        artifactIds: ['artifact-1']
      }
    ])
    expect(lifecycle.getEvents('session-1').map((event) => event.phase)).toEqual([
      'switching',
      'reconfiguring',
      'continuation-start',
      'continued'
    ])
  })

  it('keeps a captured tool error app-owned and exposes only its outcome in renderer events', async () => {
    const lifecycle = new HandoffLifecycleCoordinator()
    const { runtime, continuationContexts } = createRuntime()
    const coordinator = new CompletionGateCoordinator(runtime, lifecycle)
    coordinator.arm(trustedContext, { kind: 'main' })

    await runCompletionGatedTool({
      coordinator,
      context: trustedContext,
      deliverToCurrentPrompt: async () => undefined,
      execute: async () => {
        throw new Error('private tool detail')
      }
    })

    expect(continuationContexts).toHaveLength(1)
    expect(continuationContexts[0]).toMatchObject({
      target: { kind: 'main' },
      completion: { kind: 'threw' }
    })
    expect(lifecycle.getEvents('session-1').at(-1)).toMatchObject({
      phase: 'continued',
      continuation: {
        outcome: 'threw',
        switchReadback: { target: { kind: 'main' } }
      }
    })
    expect(JSON.stringify(lifecycle.getEvents('session-1'))).not.toContain('private tool detail')
  })

  it('accepts a renderer retry intent only through the coordinator-owned safe retry stage', async () => {
    const retryHandoff = vi.fn(async () => undefined)
    const lifecycle = new HandoffLifecycleCoordinator({ retryHandoff })
    const { runtime } = createRuntime()
    runtime.reconfigure = vi.fn(async () => {
      throw new Error('private runtime detail')
    })
    const coordinator = new CompletionGateCoordinator(runtime, lifecycle)
    coordinator.arm(trustedContext, 'Data analyst')

    await runCompletionGatedTool({
      coordinator,
      context: trustedContext,
      deliverToCurrentPrompt: async () => undefined,
      execute: async () => 'captured'
    })
    await lifecycle.retry({ sessionId: 'session-1', originatingTurnId: 'turn-1' })

    expect(retryHandoff).toHaveBeenCalledWith(
      lifecycle.getContinuationContext('session-1', 'turn-1'),
      'reconfiguring',
      expect.any(Function)
    )
  })
})
