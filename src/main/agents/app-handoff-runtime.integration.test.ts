import { describe, expect, it, vi } from 'vitest'

import { AppHandoffRuntime, createProductionAppHandoffRuntime } from './app-handoff-runtime'
import { CompletionGateCoordinator, runCompletionGatedTool } from './completion-gate'
import { HandoffLifecycleCoordinator } from './handoff-lifecycle'

const trustedContext = {
  sessionId: 'session-1',
  turnId: 'control-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'control-1',
  originatingTurnId: 'prompt-1',
  originatingUserMessageId: 'prompt-1',
  attachmentIds: ['upload-1'],
  artifactIds: ['artifact-1']
}

describe('production app handoff runtime', () => {
  it('waits for explicit ownership release before switching and starts a same-turn continuation', async () => {
    const calls: string[] = []
    const sendContinuation = vi.fn(async (_request: unknown) => {
      void _request
      calls.push('continue')
    })
    const runtime = createProductionAppHandoffRuntime({
      runtime: {
        cancelPrompt: async () => {
          calls.push('cancel')
          return {} as never
        },
        waitForPromptOwnershipRelease: async () => {
          calls.push('ownership-released')
        },
        switchSpecialist: async (_sessionId, specialistId) => {
          calls.push(`switch:${specialistId}`)
          return { contextReset: false }
        },
        sendAppContinuation: async (request) => {
          await sendContinuation(request)
          return { stopReason: 'end_turn' } as never
        }
      },
      sessionBinding: {
        resolve: async () => {
          calls.push('resolve-binding')
          return {
            kind: 'bound' as const,
            profile: {
              id: 'specialist-1',
              name: 'Data analyst'
            } as never
          }
        }
      }
    })
    const lifecycle = new HandoffLifecycleCoordinator()
    const coordinator = new CompletionGateCoordinator(runtime, lifecycle)
    coordinator.arm(trustedContext, 'Data analyst')

    await runCompletionGatedTool({
      coordinator,
      context: trustedContext,
      execute: async () => ({ rows: 42 }),
      deliverToCurrentPrompt: async () => undefined
    })

    expect(calls).toEqual([
      'cancel',
      'ownership-released',
      'resolve-binding',
      'switch:specialist-1',
      'continue'
    ])
    expect(sendContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        provenanceContext: { promptMessageId: 'prompt-1' },
        text: expect.stringContaining('{ rows: 42 }')
      })
    )
    expect(lifecycle.getEvents('session-1').map((event) => event.phase)).toEqual([
      'switching',
      'reconfiguring',
      'continuation-start',
      'continued'
    ])
  })

  it('retries continuation startup from retained context without reviving or reconfiguring old ownership', async () => {
    const cancelPrompt = vi.fn(async () => undefined)
    const waitForPromptOwnershipRelease = vi.fn(async () => undefined)
    const switchSpecialist = vi.fn(async () => undefined)
    const sendContinuation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockResolvedValueOnce(undefined)
    const runtime = new AppHandoffRuntime({
      cancelPrompt,
      waitForPromptOwnershipRelease,
      resolveSpecialistId: async () => 'specialist-1',
      switchSpecialist,
      sendContinuation
    })
    const lifecycle = new HandoffLifecycleCoordinator({
      retryHandoff: (context, retryFrom, onPhase) => runtime.retry(context, retryFrom, onPhase)
    })
    const coordinator = new CompletionGateCoordinator(runtime, lifecycle)
    coordinator.arm(trustedContext, 'Data analyst')

    await runCompletionGatedTool({
      coordinator,
      context: trustedContext,
      execute: async () => 'captured result',
      deliverToCurrentPrompt: async () => undefined
    })
    await lifecycle.retry({ sessionId: 'session-1', originatingTurnId: 'prompt-1' })

    expect(cancelPrompt).toHaveBeenCalledOnce()
    expect(waitForPromptOwnershipRelease).toHaveBeenCalledOnce()
    expect(switchSpecialist).toHaveBeenCalledOnce()
    expect(sendContinuation).toHaveBeenCalledTimes(2)
    expect(lifecycle.getEvents('session-1').at(-1)?.phase).toBe('continued')
  })
})
