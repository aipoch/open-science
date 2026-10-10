import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CompletionHandoffLifecycle,
  FileCompletionHandoffRepository,
  InMemoryCompletionHandoffRepository,
  toCompletionHandoffLifecycleEvent,
  type DurableCompletionHandoff,
  type CompletionHandoffRuntime
} from './completion-handoff-lifecycle'
import type { TrustedToolCompletionContext } from './completion-gate'
import { createClaudeCodeCompletionGateRuntime } from './claude-code-handoff'
import { withApprovedSpecialistBinding } from './production-completion-handoff'

const context: TrustedToolCompletionContext = {
  sessionId: 'trusted-session',
  turnId: 'turn-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'tool-1'
}

const createRuntime = (
  overrides: Partial<CompletionHandoffRuntime> = {}
): { runtime: CompletionHandoffRuntime; requests: string[] } => {
  const requests: string[] = []
  const runtime: CompletionHandoffRuntime = {
    stopOldPrompt: vi.fn(async () => {
      requests.push('stop-old')
    }),
    waitForOwnershipRelease: vi.fn(async () => {
      requests.push('ownership-released')
    }),
    reconfigure: vi.fn(async ({ targetName }) => {
      requests.push(`reconfigure:${targetName}`)
    }),
    continueAsApproved: vi.fn(async ({ targetName }) => {
      requests.push(`continue:${targetName}`)
    }),
    reportHandoffFailure: vi.fn(async () => undefined),
    ...overrides
  }
  return { runtime, requests }
}

describe('CompletionHandoffLifecycle', () => {
  it.each([false, true])(
    'ignores stale ownership release after a same-context retry (retry completed=%s)',
    async (retryCompleted) => {
      const oldOwnership = Promise.withResolvers<void>()
      const retryPreparation = Promise.withResolvers<void>()
      let ownershipWaits = 0
      const { runtime } = createRuntime({
        waitForOwnershipRelease: async () => {
          if (++ownershipWaits === 1) await oldOwnership.promise
        },
        reconfigure: vi.fn(async () => {
          await retryPreparation.promise
        })
      })
      const lifecycle = new CompletionHandoffLifecycle(
        new InMemoryCompletionHandoffRepository(),
        runtime
      )
      await lifecycle.approve({ context, targetName: 'Specialist', generation: 1 })
      await lifecycle.capture(context, { kind: 'returned', value: 'approved' })
      const oldRun = lifecycle.run(context)
      await vi.waitFor(() => expect(ownershipWaits).toBe(1))
      await lifecycle.cancel(context)
      const retry = lifecycle.retry(context)
      await vi.waitFor(() => expect(runtime.reconfigure).toHaveBeenCalledOnce())
      if (retryCompleted) {
        retryPreparation.resolve()
        await expect(retry).resolves.toMatchObject({ stage: 'continued' })
      }
      oldOwnership.resolve()
      await oldRun
      expect(runtime.reconfigure).toHaveBeenCalledOnce()
      if (!retryCompleted) retryPreparation.resolve()
      await Promise.all([oldRun, retry])
      expect(runtime.reconfigure).toHaveBeenCalledOnce()
      expect(runtime.continueAsApproved).toHaveBeenCalledOnce()
      expect(runtime.reportHandoffFailure).not.toHaveBeenCalled()
    }
  )
  it('invalidates attempt authority synchronously when cancellation starts', async () => {
    const pending = Promise.withResolvers<void>()
    let isCurrentAttempt: (() => boolean) | undefined
    const { runtime } = createRuntime({
      reconfigure: async (_handoff, _context, isCurrent) => {
        isCurrentAttempt = isCurrent
        await pending.promise
      }
    })
    const lifecycle = new CompletionHandoffLifecycle(
      new InMemoryCompletionHandoffRepository(),
      runtime
    )
    await lifecycle.approve({ context, targetName: 'Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'approved' })
    const running = lifecycle.run(context)
    await vi.waitFor(() => expect(isCurrentAttempt?.()).toBe(true))
    const cancellation = lifecycle.cancel(context)
    expect(isCurrentAttempt?.()).toBe(false)
    await cancellation
    pending.resolve()
    await running
    expect(runtime.continueAsApproved).not.toHaveBeenCalled()
  })
  it('rejects a cancelled guard lookup before it can steal a same-context retry replay', async () => {
    const profile = Promise.withResolvers<void>()
    const retryPreparation = Promise.withResolvers<void>()
    let lookups = 0
    let preparations = 0
    let staged: string | undefined
    const switchSpecialist = vi.fn(async () => ({ contextReset: true }))
    const sendAppContinuation = vi.fn(async () => {
      expect(staged).toBe('retry')
    })
    const reportHandoffFailure = vi.fn(async () => undefined)
    const runtime = withApprovedSpecialistBinding(
      createClaudeCodeCompletionGateRuntime({
        sessionFramework: () => 'claude-code',
        cancelPrompt: vi.fn(),
        waitForPromptOwnershipRelease: vi.fn(),
        resolveSpecialistId: () => 'approved',
        resolveSwitchReadBack: async (sessionId, targetName) => ({
          status: 'approved',
          operation: 'switch',
          binding: { sessionId, targetName, specialistId: 'approved' }
        }),
        prepareReplayContext: async (_input, isCurrent) => {
          const attempt = ++preparations
          if (attempt === 1) await retryPreparation.promise
          if (isCurrent?.()) staged = attempt === 1 ? 'retry' : 'stale-old'
        },
        discardReplayContext: async () => {
          staged = undefined
        },
        switchSpecialist,
        createContinuationRequest: async () => ({ sessionId: context.sessionId, text: 'Continue' }),
        sendAppContinuation,
        reportHandoffFailure
      }),
      {
        getSpecialistBinding: () => 'approved',
        getSpecialist: async () => {
          if (++lookups === 1) await profile.promise
          return { name: 'Specialist', revision: 1, enabled: true }
        }
      }
    )
    const lifecycle = new CompletionHandoffLifecycle(
      new InMemoryCompletionHandoffRepository(),
      runtime,
      Date.now,
      undefined,
      async () => ({ specialistId: 'approved', revision: 1 })
    )
    await lifecycle.approve({ context, targetName: 'Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'approved' })
    const oldRun = lifecycle.run(context)
    await vi.waitFor(() => expect(lookups).toBe(1))
    await lifecycle.cancel(context)
    const retry = lifecycle.retry(context)
    await vi.waitFor(() => expect(preparations).toBe(1))
    profile.resolve()
    await oldRun
    expect(switchSpecialist).not.toHaveBeenCalled()
    expect(preparations).toBe(1)
    retryPreparation.resolve()
    await expect(retry).resolves.toMatchObject({ stage: 'continued' })
    expect(sendAppContinuation).toHaveBeenCalledOnce()
    expect(reportHandoffFailure).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'prevents replay staging after cancellation while production approval validation was pending (throw=%s)',
    async (throwOnSwitch) => {
      const profile = Promise.withResolvers<{ name: string; revision: number; enabled: boolean }>()
      const getSpecialist = vi.fn(() => profile.promise)
      let staged = false
      const discardReplayContext = vi.fn(async () => {
        staged = false
      })
      const reportHandoffFailure = vi.fn(async () => undefined)
      const runtime = withApprovedSpecialistBinding(
        createClaudeCodeCompletionGateRuntime({
          sessionFramework: () => 'claude-code',
          cancelPrompt: vi.fn(),
          waitForPromptOwnershipRelease: vi.fn(),
          resolveSpecialistId: () => 'approved',
          resolveSwitchReadBack: async (sessionId, targetName) => ({
            status: 'approved',
            operation: 'switch',
            binding: { sessionId, targetName, specialistId: 'approved' }
          }),
          prepareReplayContext: async () => {
            staged = true
          },
          discardReplayContext,
          switchSpecialist: async () => {
            if (throwOnSwitch) throw new Error('replacement failed')
            return { contextReset: true }
          },
          createContinuationRequest: vi.fn(),
          sendAppContinuation: vi.fn(),
          reportHandoffFailure
        }),
        { getSpecialistBinding: () => 'approved', getSpecialist }
      )
      const lifecycle = new CompletionHandoffLifecycle(
        new InMemoryCompletionHandoffRepository(),
        runtime,
        Date.now,
        undefined,
        async () => ({ specialistId: 'approved', revision: 1 })
      )
      await lifecycle.approve({ context, targetName: 'Specialist', generation: 1 })
      await lifecycle.capture(context, { kind: 'returned', value: 'approved' })
      const running = lifecycle.run(context)
      await vi.waitFor(() => expect(getSpecialist).toHaveBeenCalledOnce())
      await lifecycle.cancel(context)
      profile.resolve({ name: 'Specialist', revision: 1, enabled: true })
      await expect(running).resolves.toMatchObject({ cancelled: true })
      expect(staged).toBe(false)
      expect(discardReplayContext).not.toHaveBeenCalled()
      expect(reportHandoffFailure).not.toHaveBeenCalled()
    }
  )
  it.each(['reject', 'resolve'] as const)(
    'does not let a stale reconfiguration %s unwind affect a same-context retry',
    async (outcome) => {
      const oldGate = Promise.withResolvers<void>()
      const retryGate = Promise.withResolvers<void>()
      let preparations = 0
      let switches = 0
      let staged: string | undefined
      const sendAppContinuation = vi.fn(async () => {
        expect(staged).toBe('retry')
      })
      const reportHandoffFailure = vi.fn(async () => undefined)
      const runtime = createClaudeCodeCompletionGateRuntime({
        sessionFramework: () => 'claude-code',
        cancelPrompt: vi.fn(),
        waitForPromptOwnershipRelease: vi.fn(),
        resolveSpecialistId: () => 'approved',
        resolveSwitchReadBack: async (sessionId, targetName) => ({
          status: 'approved',
          operation: 'switch',
          binding: { sessionId, targetName, specialistId: 'approved' }
        }),
        prepareReplayContext: async (_input, isCurrent) => {
          const attempt = ++preparations
          if (attempt === 1 && outcome === 'reject') await oldGate.promise
          if (isCurrent?.()) staged = attempt === 1 ? 'old' : 'retry'
        },
        discardReplayContext: async () => {
          staged = undefined
        },
        switchSpecialist: async () => {
          const attempt = ++switches
          await (outcome === 'resolve' && attempt === 1 ? oldGate.promise : retryGate.promise)
          return { contextReset: true }
        },
        createContinuationRequest: async () => ({ sessionId: context.sessionId, text: 'Continue' }),
        sendAppContinuation,
        reportHandoffFailure
      })
      const lifecycle = new CompletionHandoffLifecycle(
        new InMemoryCompletionHandoffRepository(),
        runtime
      )
      await lifecycle.approve({ context, targetName: 'Specialist', generation: 1 })
      await lifecycle.capture(context, { kind: 'returned', value: 'approved' })
      const oldRun = lifecycle.run(context)
      await vi.waitFor(() => expect(outcome === 'reject' ? preparations : switches).toBe(1))
      await lifecycle.cancel(context)
      const retry = lifecycle.retry(context)
      await vi.waitFor(() => expect(switches).toBe(outcome === 'reject' ? 1 : 2))
      oldGate.resolve()
      await oldRun
      expect(reportHandoffFailure).not.toHaveBeenCalled()
      expect(sendAppContinuation).not.toHaveBeenCalled()
      expect(staged).toBe('retry')
      retryGate.resolve()
      await expect(retry).resolves.toMatchObject({ stage: 'continued' })
      expect(sendAppContinuation).toHaveBeenCalledOnce()
    }
  )
  it('cleans cancelled adapter context without publishing failure when preparation unwinds', async () => {
    const preparation = Promise.withResolvers<void>()
    const cleanupCancelledHandoff = vi.fn(async () => undefined)
    const { runtime } = createRuntime({
      reconfigure: vi.fn(() => preparation.promise),
      cleanupCancelledHandoff
    })
    const lifecycle = new CompletionHandoffLifecycle(
      new InMemoryCompletionHandoffRepository(),
      runtime
    )
    await lifecycle.approve({ context, targetName: 'Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'approved' })
    const running = lifecycle.run(context)
    await vi.waitFor(() => expect(runtime.reconfigure).toHaveBeenCalledOnce())
    await lifecycle.cancel(context)
    expect(cleanupCancelledHandoff).toHaveBeenCalledWith(context)
    preparation.reject(new Error('The Claude Code handoff was superseded.'))
    await expect(running).resolves.toMatchObject({ cancelled: true })
    expect(runtime.reportHandoffFailure).not.toHaveBeenCalled()
    expect(runtime.continueAsApproved).not.toHaveBeenCalled()
  })
  it('assigns unique global commit order across concurrent file writes and continues after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-handoff-order-'))
    const makeRecord = (toolInvocationId: string): DurableCompletionHandoff => ({
      id: toolInvocationId,
      context: { ...context, toolInvocationId },
      targetName: 'Approved Specialist',
      generation: 1,
      sequence: 1,
      observedAt: 100,
      provenance: { originatingTurnId: context.turnId, attachmentIds: [], artifactIds: [] },
      stage: 'awaiting-approval' as const,
      cancelled: false
    })

    try {
      const repository = new FileCompletionHandoffRepository(directory)
      await Promise.all([repository.save(makeRecord('one')), repository.save(makeRecord('two'))])
      const firstOrders = (await repository.list())
        .map((handoff) => handoff.commitOrder)
        .sort((left, right) => (left ?? 0) - (right ?? 0))
      expect(firstOrders).toEqual([1, 2])

      const restarted = new FileCompletionHandoffRepository(directory)
      await restarted.save(makeRecord('three'))
      expect((await restarted.get({ ...context, toolInvocationId: 'three' }))?.commitOrder).toBe(3)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not let a lifecycle projection listener affect handoff authority', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime } = createRuntime()
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime, Date.now, () => {
      throw new Error('renderer unavailable')
    })

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'owned' })
    await expect(lifecycle.run(context)).resolves.toMatchObject({ stage: 'continued' })
  })

  it('projects an unresolved approval and clears it after a decline without arming a handoff', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime } = createRuntime()
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)
    const approvalContext = {
      ...context,
      originatingTurnId: 'prompt-message-17',
      originatingUserMessageId: 'prompt-message-17',
      attachmentIds: ['upload-1'],
      artifactIds: ['artifact-1'],
      target: { kind: 'specialist' as const, name: 'Approved Specialist' }
    }

    await lifecycle.onAwaitingApproval(approvalContext)
    await expect(lifecycle.getEvents(context.sessionId)).resolves.toMatchObject([
      {
        phase: 'awaiting-approval',
        target: 'Approved Specialist',
        provenance: {
          originatingTurnId: 'prompt-message-17',
          originatingUserMessageId: 'prompt-message-17',
          attachmentIds: ['upload-1'],
          artifactIds: ['artifact-1']
        }
      }
    ])

    await lifecycle.settleApproval(approvalContext, false)
    await expect(lifecycle.getEvents(context.sessionId)).resolves.toEqual([])
  })

  it('does not replace a captured approved generation with a duplicate approval', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime } = createRuntime()
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'captured once' })
    await lifecycle.approve({ context, targetName: null, generation: 1 })

    expect(await repository.get(context)).toMatchObject({
      targetName: 'Approved Specialist',
      envelope: { kind: 'returned', value: 'captured once' }
    })
  })

  it('projects durable state into the shared lifecycle event semantics without renderer state', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime } = createRuntime({
      reconfigure: vi.fn(async () => {
        throw new Error('approved target unavailable')
      })
    })
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime, () => 1234)

    await lifecycle.approve({
      context,
      targetName: 'Approved Specialist',
      generation: 1,
      provenance: {
        originatingUserMessageId: 'user-message-1',
        attachmentIds: ['attachment-1'],
        artifactIds: ['artifact-1']
      }
    })
    await lifecycle.capture(context, { kind: 'returned', value: 'outer result' })
    const failed = await lifecycle.run(context)

    expect(toCompletionHandoffLifecycleEvent(failed)).toEqual({
      id: expect.any(String),
      sessionId: 'trusted-session',
      sequence: expect.any(Number),
      commitOrder: expect.any(Number),
      observedAt: 1234,
      phase: 'failed',
      target: 'Approved Specialist',
      provenance: {
        originatingTurnId: 'turn-1',
        originatingUserMessageId: 'user-message-1',
        attachmentIds: ['attachment-1'],
        artifactIds: ['artifact-1']
      },
      failure: { retryFrom: 'reconfiguring', message: 'Handoff reconfiguration failed.' }
    })
  })

  it('persists and projects only a bounded failure classification', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const leaked =
      'token=super-secret transcript=private UUID=11111111-1111-1111-1111-111111111111 connectorArgs={password:secret}'
    const { runtime } = createRuntime({
      reconfigure: vi.fn(async () => {
        throw new Error(leaked)
      })
    })
    const events: unknown[] = []
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime, Date.now, (event) => {
      events.push(event)
    })

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'captured' })
    const failed = await lifecycle.run(context)
    const persisted = await repository.get(context)
    const serialized = JSON.stringify({
      persisted,
      event: toCompletionHandoffLifecycleEvent(failed),
      events
    })

    expect(toCompletionHandoffLifecycleEvent(failed).failure).toEqual({
      retryFrom: 'reconfiguring',
      message: 'Handoff reconfiguration failed.'
    })
    for (const secret of [
      'super-secret',
      'private',
      '11111111-1111-1111-1111-111111111111',
      'connectorArgs',
      'password:secret'
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('does not reconfigure after a failed old-prompt release, then retries from the switching barrier', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime, requests } = createRuntime({
      waitForOwnershipRelease: vi
        .fn()
        .mockRejectedValueOnce(new Error('ownership release timed out'))
        .mockImplementation(async () => {
          requests.push('ownership-released')
        })
    })
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'outer result' })

    await expect(lifecycle.run(context)).resolves.toMatchObject({
      stage: 'failed',
      retryFrom: 'switching'
    })
    expect(requests).toEqual(['stop-old'])

    await expect(lifecycle.retry(context)).resolves.toMatchObject({ stage: 'continued' })
    expect(requests).toEqual([
      'stop-old',
      'stop-old',
      'ownership-released',
      'reconfigure:Approved Specialist',
      'continue:Approved Specialist'
    ])
  })

  it('keeps the captured envelope app-owned and retries a reconfiguration failure without reviving the old identity', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime, requests } = createRuntime({
      reconfigure: vi
        .fn()
        .mockRejectedValueOnce(new Error('target unavailable'))
        .mockImplementation(async ({ targetName }: { targetName: string | null }) => {
          requests.push(`reconfigure:${targetName}`)
        })
    })
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: { afterAwait: 'finished' } })

    await expect(lifecycle.run(context)).resolves.toMatchObject({ stage: 'failed' })
    expect(await repository.get(context)).toMatchObject({
      stage: 'failed',
      retryFrom: 'reconfiguring',
      envelope: { kind: 'returned', value: { afterAwait: 'finished' } }
    })
    expect(requests).toEqual(['stop-old', 'ownership-released'])

    await expect(lifecycle.retry(context)).resolves.toMatchObject({ stage: 'continued' })
    expect(requests).toEqual([
      'stop-old',
      'ownership-released',
      'reconfigure:Approved Specialist',
      'continue:Approved Specialist'
    ])
    expect(await repository.get(context)).toMatchObject({ stage: 'continued' })
  })

  it('joins concurrent retries so handoff side effects run exactly once', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime } = createRuntime({
      reconfigure: vi.fn().mockRejectedValueOnce(new Error('target unavailable'))
    })
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'captured' })
    await expect(lifecycle.run(context)).resolves.toMatchObject({ stage: 'failed' })

    await expect(
      Promise.all([lifecycle.retry(context), lifecycle.retry(context)])
    ).resolves.toEqual([
      expect.objectContaining({ stage: 'continued' }),
      expect.objectContaining({ stage: 'continued' })
    ])
    expect(runtime.reconfigure).toHaveBeenCalledTimes(2)
    expect(runtime.continueAsApproved).toHaveBeenCalledOnce()
  })

  it('does not create a binding when cancellation happens before approval, and cancellation after approval never permits the old identity to resume', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime, requests } = createRuntime()
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)

    await expect(lifecycle.cancel(context)).resolves.toBeUndefined()
    expect(await repository.get(context)).toBeUndefined()

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.cancel(context)
    await lifecycle.capture(context, { kind: 'returned', value: 'captured after cancel' })

    expect(await lifecycle.run(context)).toMatchObject({ stage: 'failed', cancelled: true })
    expect(requests).toEqual([])
    expect(await repository.get(context)).toMatchObject({
      targetName: 'Approved Specialist',
      stage: 'failed',
      cancelled: true
    })

    await expect(lifecycle.retry(context)).resolves.toMatchObject({
      stage: 'continued',
      cancelled: false
    })
    expect(requests).toEqual([
      'stop-old',
      'ownership-released',
      'reconfigure:Approved Specialist',
      'continue:Approved Specialist'
    ])
  })

  it('does not let a stale runner overwrite cancellation after ownership release', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    let releaseOwnership!: () => void
    const ownershipReleased = new Promise<void>((resolve) => {
      releaseOwnership = resolve
    })
    const { runtime, requests } = createRuntime({
      waitForOwnershipRelease: vi.fn(async () => ownershipReleased)
    })
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'returned', value: 'captured' })
    const running = lifecycle.run(context)
    await vi.waitFor(() => expect(requests).toEqual(['stop-old']))

    await lifecycle.cancel(context)
    releaseOwnership()

    await expect(running).resolves.toMatchObject({ stage: 'failed', cancelled: true })
    expect(requests).toEqual(['stop-old'])
    expect(await repository.get(context)).toMatchObject({ stage: 'failed', cancelled: true })
  })

  it('persists the immutable approved Specialist identity and continuation readback', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime } = createRuntime()
    const switchReadback = {
      status: 'approved' as const,
      operation: 'switch' as const,
      binding: {
        sessionId: context.sessionId,
        specialistId: 'specialist-1',
        targetName: 'Approved Specialist',
        revision: 7
      },
      pendingReconfigure: {
        sessionId: context.sessionId,
        targetName: 'Approved Specialist',
        turnId: context.turnId,
        toolInvocationId: context.toolInvocationId
      }
    }
    const lifecycle = new CompletionHandoffLifecycle(
      repository,
      runtime,
      Date.now,
      undefined,
      async () => ({ specialistId: 'specialist-1', revision: 7 })
    )

    await lifecycle.approve({
      context,
      targetName: 'Approved Specialist',
      generation: 1,
      continuation: { outcome: 'pending', switchReadback }
    })
    await lifecycle.capture(context, { kind: 'returned', value: 'captured' })
    await lifecycle.run(context)

    const persisted = await repository.get(context)
    expect(persisted).toMatchObject({
      approvedSpecialistId: 'specialist-1',
      approvedSpecialistRevision: 7,
      continuation: { outcome: 'continued', switchReadback }
    })
    expect(persisted).toBeDefined()
    if (!persisted) throw new Error('Expected a persisted completion handoff.')
    expect(toCompletionHandoffLifecycleEvent(persisted)).toMatchObject({
      continuation: {
        switchReadback: {
          binding: {
            sessionId: context.sessionId,
            targetName: 'Approved Specialist',
            revision: 7
          }
        }
      }
    })
    expect(JSON.stringify(toCompletionHandoffLifecycleEvent(persisted))).not.toContain(
      'specialist-1'
    )
    expect(runtime.reconfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedSpecialistId: 'specialist-1',
        approvedSpecialistRevision: 7
      }),
      context,
      expect.any(Function)
    )
  })

  it('orders same-millisecond replay events by repository commit rather than per-handoff sequence', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime } = createRuntime()
    const earlier = { ...context, toolInvocationId: 'earlier' }
    const later = { ...context, toolInvocationId: 'later' }
    await repository.save({
      id: 'earlier',
      context: earlier,
      targetName: 'Earlier',
      generation: 1,
      sequence: 99,
      observedAt: 100,
      provenance: { originatingTurnId: context.turnId, attachmentIds: [], artifactIds: [] },
      stage: 'failed',
      retryFrom: 'switching',
      cancelled: false,
      failureMessage: 'earlier'
    })
    await repository.save({
      id: 'later',
      context: later,
      targetName: 'Later',
      generation: 1,
      sequence: 2,
      observedAt: 100,
      provenance: { originatingTurnId: context.turnId, attachmentIds: [], artifactIds: [] },
      stage: 'failed',
      retryFrom: 'switching',
      cancelled: false,
      failureMessage: 'later'
    })

    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)
    const events = await lifecycle.getEvents(context.sessionId)
    expect(events.map((event) => event.id)).toEqual(['earlier', 'later'])
    expect(events[1].commitOrder).toBeGreaterThan(events[0].commitOrder ?? 0)
  })

  it('retries a continuation startup failure without reconfiguring or delivering the envelope to an old prompt', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const { runtime, requests } = createRuntime({
      continueAsApproved: vi
        .fn()
        .mockRejectedValueOnce(new Error('approved continuation unavailable'))
        .mockImplementation(async ({ targetName }: { targetName: string | null }) => {
          requests.push(`continue:${targetName}`)
        })
    })
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)

    await lifecycle.approve({ context, targetName: 'Approved Specialist', generation: 1 })
    await lifecycle.capture(context, { kind: 'threw', error: new Error('outer tool failure') })

    await expect(lifecycle.run(context)).resolves.toMatchObject({
      stage: 'failed',
      retryFrom: 'continuation-start'
    })
    await expect(lifecycle.retry(context)).resolves.toMatchObject({ stage: 'continued' })

    expect(requests).toEqual([
      'stop-old',
      'ownership-released',
      'reconfigure:Approved Specialist',
      'continue:Approved Specialist'
    ])
    expect(await repository.get(context)).toMatchObject({
      stage: 'continued',
      envelope: { kind: 'threw' }
    })
  })

  it('recovers a captured approved handoff after restart using only the approved target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-handoff-'))
    const repository = new FileCompletionHandoffRepository(directory)
    const initial = createRuntime({
      reconfigure: vi.fn(async () => {
        throw new Error('app stopped during reconfigure')
      })
    })
    const beforeRestart = new CompletionHandoffLifecycle(repository, initial.runtime)

    try {
      await beforeRestart.approve({ context, targetName: 'Approved Specialist', generation: 1 })
      await beforeRestart.capture(context, {
        kind: 'threw',
        error: new Error('outer tool failed before restart')
      })
      await beforeRestart.run(context)
      const beforeRestartOrder = (await repository.get(context))?.commitOrder

      const recovered = createRuntime()
      // A fresh repository instance verifies the persisted envelope and approved target are enough
      // to recover; no old runtime object or renderer-side state is reused.
      const afterRestart = new CompletionHandoffLifecycle(
        new FileCompletionHandoffRepository(directory),
        recovered.runtime
      )
      await expect(afterRestart.recover()).resolves.toEqual([
        expect.objectContaining({ context, stage: 'continued', targetName: 'Approved Specialist' })
      ])

      expect(recovered.requests).toEqual([
        'reconfigure:Approved Specialist',
        'continue:Approved Specialist'
      ])
      const persisted = await repository.get(context)
      expect(persisted).toMatchObject({ stage: 'continued', envelope: { kind: 'threw' } })
      expect(persisted?.commitOrder).toBeGreaterThan(beforeRestartOrder ?? 0)
      expect(persisted?.envelope?.kind === 'threw' && persisted.envelope.error).toBeInstanceOf(
        Error
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('discards an unresolved pre-card approval on restart without creating a retryable handoff', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'open-science-unresolved-approval-'))
    const approvalContext = {
      ...context,
      originatingTurnId: 'prompt-message-17',
      originatingUserMessageId: 'prompt-message-17',
      attachmentIds: ['upload-1'],
      artifactIds: ['artifact-1'],
      target: { kind: 'specialist' as const, name: 'Approved Specialist' }
    }
    const beforeRestart = new CompletionHandoffLifecycle(
      new FileCompletionHandoffRepository(directory),
      createRuntime().runtime
    )

    try {
      await beforeRestart.onAwaitingApproval(approvalContext)

      const recovered = createRuntime()
      const broadcasts: Array<{ removed?: true; phase: string }> = []
      const afterRestart = new CompletionHandoffLifecycle(
        new FileCompletionHandoffRepository(directory),
        recovered.runtime,
        Date.now,
        (event) => broadcasts.push(event)
      )

      await expect(afterRestart.recover()).resolves.toEqual([])
      expect(recovered.requests).toEqual([])
      expect(recovered.runtime.reportHandoffFailure).not.toHaveBeenCalled()
      await expect(afterRestart.getEvents(context.sessionId)).resolves.toEqual([])
      expect(broadcasts).toEqual([
        expect.objectContaining({ phase: 'awaiting-approval', removed: true })
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
