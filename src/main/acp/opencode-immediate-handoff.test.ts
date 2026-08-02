import { describe, expect, it, vi } from 'vitest'

import {
  CompletionGateCoordinator,
  runCompletionGatedTool,
  type TrustedToolCompletionContext
} from '../agents/completion-gate'
import {
  OpenCodeHandoffFailureStore,
  OpenCodeImmediateHandoffRuntime
} from './opencode-immediate-handoff'

const context: TrustedToolCompletionContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'tool-1'
}

describe('OpenCode immediate handoff', () => {
  it('stops the old request before projecting the approved Specialist and continuing the original turn', async () => {
    const requests: Array<{ owner: 'old' | 'new'; text: string; turnToken?: string }> = []
    const calls: string[] = []
    const continueOriginalTurn = vi.fn(async (request) => {
      calls.push('continuation-request')
      requests.push({
        owner: 'new',
        text: request.prompt.text,
        turnToken: request.originatingTurnToken
      })
      expect(request.completion).toEqual({
        kind: 'returned',
        value: { completedAfterSwitch: true }
      })
    })
    const handoff = new OpenCodeImmediateHandoffRuntime({
      isOpenCodeSession: (sessionId) => sessionId === 'session-1',
      captureCurrentPrompt: () => ({
        prompt: { sessionId: 'session-1', text: 'analyse these samples' },
        originatingTurnToken: 'original-turn-token'
      }),
      stopOldPrompt: async () => {
        calls.push('stop-old-prompt')
      },
      waitForOwnershipRelease: async () => {
        calls.push('ownership-released')
      },
      resolveSpecialistId: async () => 'specialist-new',
      applySpecialistProjection: async () => {
        calls.push('reconfigured')
      },
      continueOriginalTurn,
      reportHandoffFailure: async () => {
        calls.push('handoff-failed')
      }
    })
    const coordinator = new CompletionGateCoordinator(handoff)

    coordinator.arm(context, 'New Specialist')
    await runCompletionGatedTool({
      coordinator,
      context,
      execute: async () => ({ completedAfterSwitch: true }),
      deliverToCurrentPrompt: async () => {
        // The old provider immediately requests another completion if it receives the tool result.
        requests.push({
          owner: 'old',
          text: 'old provider continuation'
        })
      }
    })

    expect(calls).toEqual([
      'stop-old-prompt',
      'ownership-released',
      'reconfigured',
      'continuation-request'
    ])
    expect(requests).toEqual([
      {
        owner: 'new',
        text: 'analyse these samples',
        turnToken: 'original-turn-token'
      }
    ])
  })

  it('leaves a non-OpenCode session on the existing completion path', async () => {
    const deliverToOldPrompt = vi.fn(async () => undefined)
    const handoff = new OpenCodeImmediateHandoffRuntime({
      isOpenCodeSession: () => false,
      captureCurrentPrompt: () => undefined,
      stopOldPrompt: async () => undefined,
      waitForOwnershipRelease: async () => undefined,
      resolveSpecialistId: async () => {
        throw new Error('should not resolve a projection')
      },
      applySpecialistProjection: async () => undefined,
      continueOriginalTurn: async () => undefined,
      reportHandoffFailure: async () => undefined
    })
    const coordinator = new CompletionGateCoordinator(handoff)

    coordinator.arm(context, 'New Specialist')
    await runCompletionGatedTool({
      coordinator,
      context,
      execute: async () => 'outer result',
      deliverToCurrentPrompt: deliverToOldPrompt
    })

    expect(deliverToOldPrompt).toHaveBeenCalledOnce()
  })

  it('reports a continuation startup failure without reopening the old completion route', async () => {
    const deliverToOldPrompt = vi.fn(async () => undefined)
    const reportHandoffFailure = vi.fn(async () => undefined)
    const handoff = new OpenCodeImmediateHandoffRuntime({
      isOpenCodeSession: () => true,
      captureCurrentPrompt: () => ({
        prompt: { sessionId: 'session-1', text: 'analyse these samples' },
        originatingTurnToken: 'original-turn-token'
      }),
      stopOldPrompt: async () => undefined,
      waitForOwnershipRelease: async () => undefined,
      resolveSpecialistId: async () => 'specialist-new',
      applySpecialistProjection: async () => undefined,
      continueOriginalTurn: async () => {
        throw new Error('provider rejected continuation')
      },
      reportHandoffFailure
    })
    const coordinator = new CompletionGateCoordinator(handoff)

    coordinator.arm(context, 'New Specialist')
    await runCompletionGatedTool({
      coordinator,
      context,
      execute: async () => 'outer result',
      deliverToCurrentPrompt: deliverToOldPrompt
    })

    expect(deliverToOldPrompt).not.toHaveBeenCalled()
    expect(reportHandoffFailure).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'tool-1',
      generation: 1,
      targetName: 'New Specialist',
      failedPhase: 'continuation-startup',
      errorMessage: 'provider rejected continuation',
      completion: { kind: 'returned', value: 'outer result' },
      continuation: {
        prompt: { sessionId: 'session-1', text: 'analyse these samples' },
        originatingTurnToken: 'original-turn-token',
        targetName: 'New Specialist',
        completion: { kind: 'returned', value: 'outer result' }
      }
    })
  })

  it('keeps a public app-owned failure record until recovery explicitly clears it', () => {
    const store = new OpenCodeHandoffFailureStore()
    const failure = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolInvocationId: 'tool-1',
      generation: 1,
      targetName: 'New Specialist',
      failedPhase: 'continuation-startup' as const,
      errorMessage: 'provider rejected continuation',
      completion: { kind: 'returned' as const, value: 'outer result' },
      continuation: {
        prompt: { sessionId: 'session-1', text: 'analyse these samples' },
        originatingTurnToken: 'original-turn-token',
        targetName: 'New Specialist',
        completion: { kind: 'returned' as const, value: 'outer result' }
      }
    }

    store.record(failure)

    expect(store.get('session-1')).toEqual(failure)
    expect(store.list()).toEqual([failure])
    store.clear('session-1')
    expect(store.get('session-1')).toBeUndefined()
    store.record(failure)
    store.clearAll()
    expect(store.list()).toEqual([])

    for (let index = 0; index <= 100; index += 1) {
      store.record({ ...failure, sessionId: `session-${index}` })
    }
    expect(store.list()).toHaveLength(100)
    expect(store.get('session-0')).toBeUndefined()
  })
})
