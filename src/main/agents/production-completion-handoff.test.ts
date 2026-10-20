import { describe, expect, it, vi } from 'vitest'

import {
  createApprovedContinuationPrompt,
  createProductionCompletionHandoffRuntime,
  withApprovedSpecialistBinding
} from './production-completion-handoff'
import { createClaudeCodeCompletionGateRuntime } from './claude-code-handoff'
import { OpenCodeImmediateHandoffRuntime } from '../acp/opencode-immediate-handoff'
import {
  CompletionHandoffLifecycle,
  InMemoryCompletionHandoffRepository
} from './completion-handoff-lifecycle'
import {
  SessionSpecialistReconfiguration,
  type PersistedSessionSpecialistBinding
} from '../specialist/session-reconfiguration'

const context = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'tool-1'
}

describe('production completion handoff runtime', () => {
  it.each([
    ['specialist-a', 'specialist-b'],
    [undefined, 'specialist-b'],
    ['specialist-a', undefined],
    ['specialist-a', 'specialist-a'],
    [undefined, undefined]
  ])(
    'retries a failed Claude handoff from %s only if picker target %s still matches',
    async (approved, next) => {
      let binding = approved
      let persisted: PersistedSessionSpecialistBinding = { specialistId: approved }
      let replaceSession = false
      const persistBinding = vi.fn(
        async (_id: string, specialistId: string | undefined, pending: boolean) => {
          persisted = {
            specialistId,
            ...(pending ? { specialistBindingPending: true as const } : {})
          }
        }
      )
      const applyRuntime = vi.fn(async () => ({ contextReset: replaceSession }))
      const reconfiguration = new SessionSpecialistReconfiguration({
        sessionBinding: {
          resolve: vi.fn(async () => ({ kind: 'main' as const })),
          setBinding: (_id, specialistId) => {
            binding = specialistId
          },
          clearSession: vi.fn()
        },
        loadBinding: async () => persisted,
        persistBinding,
        applyRuntime
      })
      const prepareReplayContext = vi.fn(async () => undefined)
      const sendAppContinuation = vi.fn(async () => undefined)
      const errors: unknown[] = []
      const runtime = withApprovedSpecialistBinding(
        createClaudeCodeCompletionGateRuntime({
          sessionFramework: () => 'claude-code',
          cancelPrompt: async () => undefined,
          waitForPromptOwnershipRelease: async () => undefined,
          // Match production: both callbacks read the current binding, while readback carries the old name.
          resolveSpecialistId: () => binding,
          resolveSwitchReadBack: async (sessionId, targetName) => ({
            status: 'approved',
            operation: 'switch',
            binding: { sessionId, specialistId: binding, targetName, revision: 1 }
          }),
          prepareReplayContext,
          discardReplayContext: async () => undefined,
          switchSpecialist: (id, specialistId) => reconfiguration.applyPersisted(id, specialistId),
          createContinuationRequest: async () => ({
            sessionId: context.sessionId,
            text: 'Continue'
          }),
          sendAppContinuation,
          reportHandoffFailure: async (error) => {
            errors.push(error)
          }
        }),
        {
          getSpecialistBinding: () => binding,
          getSpecialist: (id) => ({ name: id, revision: 1, enabled: true })
        }
      )
      const lifecycle = new CompletionHandoffLifecycle(
        new InMemoryCompletionHandoffRepository(),
        runtime,
        Date.now,
        undefined,
        async () => (approved ? { specialistId: approved, revision: 1 } : undefined)
      )
      await reconfiguration.commitDesired(context.sessionId, approved)
      await lifecycle.approve({ context, targetName: approved ?? null, generation: 1 })
      await lifecycle.capture(context, { kind: 'returned', value: 'approved' })
      await expect(lifecycle.run(context)).resolves.toMatchObject({
        stage: 'failed',
        retryFrom: 'reconfiguring'
      })
      expect(persisted.specialistBindingPending).toBeUndefined()
      replaceSession = true
      await expect(reconfiguration.requestSwitch(context.sessionId, next)).resolves.toMatchObject({
        status: 'applied'
      })
      applyRuntime.mockClear()
      persistBinding.mockClear()
      prepareReplayContext.mockClear()
      if (approved === next) {
        await expect(lifecycle.retry(context)).resolves.toMatchObject({ stage: 'continued' })
        expect(applyRuntime).toHaveBeenCalledOnce()
        expect(prepareReplayContext).toHaveBeenCalledOnce()
        expect(sendAppContinuation).toHaveBeenCalledOnce()
        expect(persisted.specialistBindingPending).toBeUndefined()
        return
      }
      await expect(lifecycle.retry(context)).resolves.toMatchObject({
        stage: 'failed',
        retryFrom: 'reconfiguring'
      })
      expect(errors.at(-1)).toEqual(
        expect.objectContaining({ message: expect.stringContaining('superseded') })
      )
      expect(applyRuntime).not.toHaveBeenCalled()
      expect(persistBinding).not.toHaveBeenCalled()
      expect(prepareReplayContext).not.toHaveBeenCalled()
      expect(sendAppContinuation).not.toHaveBeenCalled()
      expect(persisted).toEqual({ specialistId: next })
    }
  )

  it('keeps legacy handoffs without a durable Specialist identity fail-closed', async () => {
    const reconfigure = vi.fn(async () => undefined)
    const runtime = withApprovedSpecialistBinding(
      {
        stopOldPrompt: vi.fn(),
        waitForOwnershipRelease: vi.fn(),
        reconfigure,
        continueAsApproved: vi.fn(),
        reportHandoffFailure: vi.fn()
      },
      {
        getSpecialistBinding: () => 'specialist-a',
        getSpecialist: () => ({ name: 'Specialist A', revision: 1, enabled: true })
      }
    )
    await expect(runtime.reconfigure({ targetName: 'Specialist A' }, context)).rejects.toThrow(
      'The durable approved Specialist identity is unavailable.'
    )
    expect(reconfigure).not.toHaveBeenCalled()
  })

  it('retains the approved Claude identity if the binding changes during profile validation', async () => {
    let binding = 'specialist-a'
    const switchSpecialist = vi.fn(async () => ({ contextReset: true }))
    const prepareReplayContext = vi.fn(async () => undefined)
    const runtime = withApprovedSpecialistBinding(
      createClaudeCodeCompletionGateRuntime({
        sessionFramework: () => 'claude-code',
        cancelPrompt: async () => undefined,
        waitForPromptOwnershipRelease: async () => undefined,
        resolveSpecialistId: () => binding,
        resolveSwitchReadBack: async (sessionId, targetName) => ({
          status: 'approved',
          operation: 'switch',
          binding: { sessionId, specialistId: binding, targetName, revision: 1 }
        }),
        prepareReplayContext,
        discardReplayContext: async () => undefined,
        switchSpecialist,
        createContinuationRequest: vi.fn(),
        sendAppContinuation: vi.fn()
      }),
      {
        getSpecialistBinding: () => binding,
        getSpecialist: async () => {
          binding = 'specialist-b'
          return { name: 'Specialist A', revision: 1, enabled: true }
        }
      }
    )
    await expect(
      runtime.reconfigure(
        {
          targetName: 'Specialist A',
          approvedSpecialistId: 'specialist-a',
          approvedSpecialistRevision: 1
        },
        context
      )
    ).rejects.toThrow('superseded')
    expect(prepareReplayContext).not.toHaveBeenCalled()
    expect(switchSpecialist).not.toHaveBeenCalled()
  })

  it('does not restore a detached OpenCode provider after a picker switch during profile lookup', async () => {
    let binding = 'specialist-a'
    let startLookup!: () => void
    let finishLookup!: () => void
    const lookupStarted = new Promise<void>((resolve) => {
      startLookup = resolve
    })
    const lookupFinished = new Promise<void>((resolve) => {
      finishLookup = resolve
    })
    const restoreSession = vi.fn(async () => undefined)
    const applySpecialistProjection = vi.fn(async () => undefined)
    const runtime = withApprovedSpecialistBinding(
      new OpenCodeImmediateHandoffRuntime({
        isOpenCodeSession: () => true,
        captureCurrentPrompt: () => ({
          prompt: { sessionId: context.sessionId, text: 'Original task' },
          originatingTurnToken: 'turn-token',
          restoreSession
        }),
        stopOldPrompt: async () => undefined,
        waitForOwnershipRelease: async () => undefined,
        resolveSpecialistId: async () => binding,
        applySpecialistProjection,
        continueOriginalTurn: vi.fn(),
        reportHandoffFailure: vi.fn()
      }),
      {
        getSpecialistBinding: () => binding,
        getSpecialist: async () => {
          startLookup()
          await lookupFinished
          return { name: 'Specialist A', revision: 1, enabled: true }
        }
      }
    )
    await runtime.stopOldPrompt(context)
    const result = runtime.reconfigure(
      {
        targetName: 'Specialist A',
        approvedSpecialistId: 'specialist-a',
        approvedSpecialistRevision: 1
      },
      context
    )
    await lookupStarted
    binding = 'specialist-b'
    finishLookup()
    await expect(result).rejects.toThrow('superseded')
    expect(restoreSession).not.toHaveBeenCalled()
    expect(applySpecialistProjection).not.toHaveBeenCalled()
  })

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
