import { describe, expect, it, vi } from 'vitest'

import {
  createApprovedContinuationPrompt,
  createProductionCompletionHandoffRuntime
} from './production-completion-handoff'

const context = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'tool-1'
}

describe('production completion handoff runtime', () => {
  it('places the approved switch readback and captured envelope in continuation context', () => {
    const prompt = createApprovedContinuationPrompt({
      kind: 'capture-for-handoff',
      targetName: 'Approved Specialist',
      generation: 1,
      switchReadback: {
        status: 'approved',
        operation: 'switch',
        binding: {
          sessionId: context.sessionId,
          specialistId: 'specialist-approved',
          targetName: 'Approved Specialist',
          revision: 3
        },
        pendingReconfigure: {
          sessionId: context.sessionId,
          targetName: 'Approved Specialist'
        }
      },
      envelope: { kind: 'returned', value: { afterAwait: 'finished' } }
    })

    expect(prompt).toContain('specialist-approved')
    expect(prompt).toContain('afterAwait')
  })

  it('uses explicit runtime release and the committed specialist binding', async () => {
    const requests: string[] = []
    const runtime = createProductionCompletionHandoffRuntime({
      stopPromptForHandoff: vi.fn(async () => {
        requests.push('cancel-requested')
      }),
      waitForSessionInteractionRelease: vi.fn(async () => {
        requests.push('ownership-released')
      }),
      getSpecialistBinding: () => 'specialist-approved',
      getSpecialist: () => ({ name: 'Approved Specialist', revision: 3, enabled: true }),
      switchSpecialist: vi.fn(async (_sessionId, specialistId) => {
        requests.push(`switch:${specialistId}`)
      }),
      continueAsApproved: vi.fn(async () => {
        requests.push('continue-approved')
      })
    })

    await runtime.stopOldPrompt(context)
    await runtime.waitForOwnershipRelease(context)
    await runtime.reconfigure(
      {
        targetName: 'Approved Specialist',
        approvedSpecialistId: 'specialist-approved',
        approvedSpecialistRevision: 3
      },
      context
    )
    await runtime.continueAsApproved(
      {
        kind: 'capture-for-handoff',
        targetName: 'Approved Specialist',
        generation: 1,
        envelope: { kind: 'returned', value: 'outer result' }
      },
      context
    )

    expect(requests).toEqual([
      'cancel-requested',
      'ownership-released',
      'switch:specialist-approved',
      'continue-approved'
    ])
  })

  it('fails closed when production continuation startup fails', async () => {
    const runtime = createProductionCompletionHandoffRuntime({
      stopPromptForHandoff: vi.fn(async () => undefined),
      waitForSessionInteractionRelease: vi.fn(async () => undefined),
      getSpecialistBinding: () => 'specialist-approved',
      getSpecialist: () => ({ name: 'Approved Specialist', revision: 3, enabled: true }),
      switchSpecialist: vi.fn(async () => undefined),
      continueAsApproved: vi.fn(async () => {
        throw new Error('continuation startup failed')
      })
    })

    await expect(
      runtime.continueAsApproved(
        {
          kind: 'capture-for-handoff',
          targetName: 'Approved Specialist',
          generation: 1,
          envelope: { kind: 'returned', value: 'outer result' }
        },
        context
      )
    ).rejects.toThrow('continuation startup failed')
  })

  it('refuses to recover through a different or revised Specialist identity', async () => {
    const switchSpecialist = vi.fn(async () => undefined)
    const runtime = createProductionCompletionHandoffRuntime({
      stopPromptForHandoff: vi.fn(async () => undefined),
      waitForSessionInteractionRelease: vi.fn(async () => undefined),
      getSpecialistBinding: () => 'specialist-different',
      getSpecialist: () => ({ name: 'Approved Specialist', revision: 4, enabled: true }),
      switchSpecialist,
      continueAsApproved: vi.fn(async () => undefined)
    })

    await expect(
      runtime.reconfigure(
        {
          targetName: 'Approved Specialist',
          approvedSpecialistId: 'specialist-approved',
          approvedSpecialistRevision: 3
        },
        context
      )
    ).rejects.toThrow('superseded')
    expect(switchSpecialist).not.toHaveBeenCalled()
  })
})
