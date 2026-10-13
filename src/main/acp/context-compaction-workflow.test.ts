import type { ActiveSession, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import { claudeCodeFramework, codeBuddyFramework, opencodeFramework } from '../agent-framework'
import type { AgentFramework } from '../agent-framework/types'
import { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import { ContextUsageTracker, type TokenCounter } from './context-usage-tracker'
import { AcpProviderPromptSerializationOwner } from './provider-prompt-serialization-owner'
import { AcpSessionInteractionOwner } from './session-interaction-owner'

type NextUpdate = Awaited<ReturnType<ActiveSession['nextUpdate']>>

type Deferred<Value> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (reason: unknown) => void
}

type FakeSession = ActiveSession & {
  prompt: ReturnType<typeof vi.fn>
  nextUpdate: ReturnType<typeof vi.fn>
}

const wordCounter: TokenCounter = {
  count: (text) => text.trim().split(/\s+/).filter(Boolean).length
}

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const stop = (stopReason: PromptResponse['stopReason']): NextUpdate =>
  ({ kind: 'stop', response: { stopReason } }) as NextUpdate

const notification = (text: string): SessionNotification => ({
  sessionId: 'provider-session',
  update: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text }
  }
})

const update = (message: SessionNotification): NextUpdate =>
  ({ kind: 'session_update', notification: message, update: message.update }) as NextUpdate

const fakeSession = (
  messages: Array<NextUpdate | Promise<NextUpdate>> = [],
  sessionId = 'provider-session'
): FakeSession => {
  const queue = [...messages]
  return {
    sessionId,
    prompt: vi.fn(async () => undefined),
    nextUpdate: vi.fn(async () => {
      const message = queue.shift()
      if (!message) return new Promise<never>(() => undefined)
      return await message
    })
  } as unknown as FakeSession
}

const frameworkManaged = {
  ...claudeCodeFramework,
  displayName: 'Managed Agent',
  contextCompaction: { kind: 'framework-managed' }
} satisfies AgentFramework

const createHarness = (input?: {
  framework?: AgentFramework
  session?: FakeSession
  cancelCompaction?: (sessionId: string) => Promise<void>
  beforePromptDispatch?: (input: { appSessionId: string; session: ActiveSession }) => Promise<void>
  usage?: ConstructorParameters<typeof AcpContextCompactionWorkflow>[0]['usage']
  serialization?: AcpProviderPromptSerializationOwner
}): {
  cancelCompaction: ReturnType<typeof vi.fn>
  context: ContextUsageTracker
  emitState: ReturnType<typeof vi.fn>
  events: Array<Partial<AcpRuntimeEvent>>
  interactions: AcpSessionInteractionOwner
  promptContent: { resetSession: ReturnType<typeof vi.fn> }
  pushEvent: ReturnType<typeof vi.fn>
  routeHiddenNotification: ReturnType<typeof vi.fn>
  session: FakeSession
  workflow: AcpContextCompactionWorkflow
} => {
  const framework = input?.framework ?? claudeCodeFramework
  const activeSession: ActiveSession | undefined = input?.session ?? fakeSession()
  const session = activeSession as FakeSession
  const interactions = new AcpSessionInteractionOwner()
  const context = new ContextUsageTracker(wordCounter)
  context.beginSession('app-session', {
    frameworkId: framework.id,
    model: 'test-model'
  })
  const events: Array<Partial<AcpRuntimeEvent>> = []
  const promptContent = { resetSession: vi.fn() }
  const pushEvent = vi.fn((event: Partial<AcpRuntimeEvent>) => events.push(event))
  const routeHiddenNotification = vi.fn()
  const emitState = vi.fn()
  const cancelCompaction = vi.fn(input?.cancelCompaction ?? (async () => undefined))
  const workflow = new AcpContextCompactionWorkflow({
    sessions: {
      activeSession: (sessionId) => (sessionId === 'app-session' ? activeSession : undefined),
      currentFramework: () => framework
    },
    interactions,
    context,
    promptContent,
    contextEstimateInput: () => ({ frameworkId: framework.id, model: 'test-model' }),
    selectedContextWindow: () => 200_000,
    routeHiddenNotification,
    pushEvent,
    emitState,
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    beforePromptDispatch: input?.beforePromptDispatch,
    usage: input?.usage,
    serialization: input?.serialization ?? new AcpProviderPromptSerializationOwner(),
    cancelCompaction
  })

  return {
    cancelCompaction,
    context,
    emitState,
    events,
    interactions,
    promptContent,
    pushEvent,
    routeHiddenNotification,
    session,
    workflow
  }
}

describe('AcpContextCompactionWorkflow', () => {
  it.each([
    { succeeded: true },
    { succeeded: false, error: 'Session too large to compact' },
    undefined
  ])('requires a verified OpenCode summary result: %j', async (compaction) => {
    const harness = createHarness({
      framework: opencodeFramework,
      session: fakeSession([stop('end_turn')]),
      usage: {
        begin: async () => ({ finalize: () => ({ compaction }), cancel: () => {} }),
        cwd: () => '/workspace',
        model: () => 'model',
        record: async () => {}
      }
    })
    const operation = harness.workflow.compact({ sessionId: 'app-session' })
    if (compaction?.succeeded)
      await expect(operation).resolves.toMatchObject({ stopReason: 'end_turn' })
    else await expect(operation).rejects.toThrow(compaction?.error ?? 'could not be verified')
    expect(harness.events.at(-1)?.status).toBe(compaction?.succeeded ? 'completed' : 'failed')
    expect(harness.promptContent.resetSession).toHaveBeenCalledTimes(compaction?.succeeded ? 1 : 0)
  })

  it('records provider usage for the hidden native compaction turn', async () => {
    const hidden = notification('Compacting conversation history')
    const session = fakeSession([update(hidden), stop('end_turn')])
    const record = vi.fn(async () => undefined)
    const observe = vi.fn()
    const finalize = vi.fn(async () => ({
      turnUsage: { inputTokens: 20, cacheTokens: 4, outputTokens: 2 },
      modelTurnCount: 1
    }))
    const harness = createHarness({
      session,
      usage: {
        begin: vi.fn(async () => ({ observe, finalize, cancel: vi.fn() })),
        record,
        cwd: () => '/workspace',
        model: () => 'model-a'
      }
    })

    await harness.workflow.compact({ sessionId: 'app-session' })

    expect(observe).toHaveBeenCalledWith(hidden)
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'app-session',
        eventId: expect.stringMatching(/^context-compaction:/u),
        frameworkId: 'claude-code',
        model: 'model-a',
        facts: expect.objectContaining({ modelTurnCount: 1 })
      })
    )
  })

  it('runs a manual native control turn without projecting its hidden output', async () => {
    const hidden = notification('Compacting conversation history')
    const session = fakeSession([update(hidden), stop('end_turn')])
    const harness = createHarness({ session })
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
    const checkpointSession = vi.spyOn(harness.context, 'checkpointSession')
    const resetAfterCompaction = vi.spyOn(harness.context, 'resetAfterCompaction')

    await expect(harness.workflow.compact({ sessionId: 'app-session' })).resolves.toEqual({
      stopReason: 'end_turn'
    })

    expect(session.prompt).toHaveBeenCalledWith([{ type: 'text', text: '/compact' }])
    expect(harness.routeHiddenNotification).toHaveBeenCalledWith(hidden, 'app-session')
    expect(checkpointSession).toHaveBeenCalledWith('app-session')
    expect(resetAfterCompaction).toHaveBeenCalledWith(
      'app-session',
      { frameworkId: 'claude-code', model: 'test-model' },
      checkpointSession.mock.results[0].value,
      200_000
    )
    expect(harness.promptContent.resetSession).toHaveBeenCalledWith('app-session')
    expect(
      harness.events.map(({ kind, status, compactionReason }) => ({
        kind,
        status,
        compactionReason
      }))
    ).toEqual([
      { kind: 'compaction', status: 'in_progress', compactionReason: 'manual' },
      { kind: 'compaction', status: 'completed', compactionReason: 'manual' }
    ])
    expect(harness.events[0].toolCallId).toMatch(/^context-compaction:/u)
    expect(harness.events[1].toolCallId).toBe(harness.events[0].toolCallId)
    expect(harness.emitState).toHaveBeenCalledTimes(2)
    expect(harness.interactions.current('app-session')).toBeUndefined()
  })

  it.each([
    {
      name: 'cancelled stop',
      messages: [stop('cancelled')],
      expectedStatus: 'cancelled',
      expectedError: undefined
    },
    {
      name: 'adapter failure output',
      messages: [update(notification('  Compacting failed: media_unstrippable')), stop('end_turn')],
      expectedStatus: 'failed',
      expectedError: 'Compacting failed: media_unstrippable'
    },
    {
      name: 'streamed adapter failure output',
      messages: [
        update(notification('  Compacting ')),
        update(notification('failed: media_unstrippable')),
        stop('end_turn')
      ],
      expectedStatus: 'failed',
      expectedError: 'Compacting failed: media_unstrippable'
    }
  ])('restores the pre-compaction context after $name', async (testCase) => {
    const harness = createHarness({ session: fakeSession(testCase.messages) })
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
    const restoreSession = vi.spyOn(harness.context, 'restoreSession')
    const resetAfterCompaction = vi.spyOn(harness.context, 'resetAfterCompaction')

    const compact = harness.workflow.compact({ sessionId: 'app-session' })
    if (testCase.expectedError) {
      await expect(compact).rejects.toThrow(testCase.expectedError)
    } else {
      await expect(compact).resolves.toEqual({ stopReason: 'cancelled' })
    }

    expect(restoreSession).toHaveBeenCalledOnce()
    expect(resetAfterCompaction).not.toHaveBeenCalled()
    expect(harness.promptContent.resetSession).not.toHaveBeenCalled()
    expect(harness.events.at(-1)).toMatchObject({
      kind: 'compaction',
      status: testCase.expectedStatus,
      compactionReason: 'manual'
    })
    expect(harness.interactions.current('app-session')).toBeUndefined()
  })

  it('rejects ordinary overlap and atomically transfers overflow recovery ownership', async () => {
    const completion = deferred<NextUpdate>()
    const harness = createHarness({ session: fakeSession([completion.promise]) })
    const oldPrompt = harness.interactions.claim({ sessionId: 'app-session', kind: 'prompt' })

    await expect(harness.workflow.compact({ sessionId: 'app-session' })).rejects.toThrow(
      'An ACP prompt is already running for this session'
    )

    const recovering = harness.workflow.compact({
      sessionId: 'app-session',
      reason: 'overflow-recovery'
    })
    expect(oldPrompt.signal.aborted).toBe(true)
    const compaction = harness.interactions.current('app-session')
    expect(compaction).toMatchObject({ kind: 'compaction' })

    harness.interactions.release(oldPrompt)
    expect(harness.interactions.current('app-session')).toBe(compaction)
    await expect(
      harness.workflow.compact({ sessionId: 'app-session', reason: 'overflow-recovery' })
    ).rejects.toThrow('Context compaction is already running for this session')

    completion.resolve(stop('end_turn'))
    await recovering
    expect(harness.interactions.current('app-session')).toBeUndefined()
  })

  it('starts automatic compaction after idle when the native threshold is reached', async () => {
    const session = fakeSession([stop('end_turn')])
    const harness = createHarness({ session })
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })

    await expect(harness.workflow.compactIfIdle('app-session')).resolves.toEqual({
      stopReason: 'end_turn'
    })
    expect(session.prompt).toHaveBeenCalledWith([{ type: 'text', text: '/compact' }])
    expect(
      harness.events.map(({ compactionReason, status }) => ({ compactionReason, status }))
    ).toEqual([
      { compactionReason: 'automatic', status: 'in_progress' },
      { compactionReason: 'automatic', status: 'completed' }
    ])
    expect(harness.interactions.current('app-session')).toBeUndefined()
  })

  it('uses the host threshold for a long CodeBuddy session', async () => {
    const session = fakeSession([stop('end_turn')])
    const harness = createHarness({ framework: codeBuddyFramework, session })
    harness.context.reconcileProviderUsage('app-session', { used: 179_999, size: 200_000 })

    await expect(harness.workflow.compactIfIdle('app-session')).resolves.toBeUndefined()
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
    await expect(harness.workflow.compactIfIdle('app-session')).resolves.toEqual({
      stopReason: 'end_turn'
    })

    expect(session.prompt).toHaveBeenCalledOnce()
    expect(session.prompt).toHaveBeenCalledWith([{ type: 'text', text: '/compact' }])
  })

  it('activates the target CodeBuddy provider session before compacting it', async () => {
    const target = fakeSession([stop('end_turn')], 'provider-session-b')
    const beforePromptDispatch = vi.fn(async () => undefined)
    const harness = createHarness({
      framework: codeBuddyFramework,
      session: target,
      beforePromptDispatch
    })
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })

    await expect(harness.workflow.compact({ sessionId: 'app-session' })).resolves.toEqual({
      stopReason: 'end_turn'
    })

    expect(beforePromptDispatch).toHaveBeenCalledWith({
      appSessionId: 'app-session',
      session: target
    })
    expect(beforePromptDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      target.prompt.mock.invocationCallOrder[0]
    )
  })

  it('does not compact while idle when no native threshold is declared', async () => {
    const session = fakeSession([stop('end_turn')])
    const harness = createHarness({
      session,
      framework: {
        ...claudeCodeFramework,
        id: 'codex',
        displayName: 'Codex',
        contextCompaction: { kind: 'native-command', command: '/compact' }
      }
    })
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })

    await expect(harness.workflow.compactIfIdle('app-session')).resolves.toBeUndefined()
    expect(session.prompt).not.toHaveBeenCalled()
  })

  it('does not compact while another interaction is current', async () => {
    const session = fakeSession([stop('end_turn')])
    const harness = createHarness({ session })
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
    const prompt = harness.interactions.claim({ sessionId: 'app-session', kind: 'prompt' })

    await expect(harness.workflow.compactIfIdle('app-session')).resolves.toBeUndefined()
    expect(session.prompt).not.toHaveBeenCalled()
    harness.interactions.release(prompt)
  })

  it('does not compact while a prompt is reserved for preflight', async () => {
    const session = fakeSession([stop('end_turn')])
    const harness = createHarness({ session })
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
    const prompt = harness.interactions.reservePrompt({
      sessionId: 'app-session',
      kind: 'prompt'
    })

    await expect(harness.workflow.compactIfIdle('app-session')).resolves.toBeUndefined()
    expect(session.prompt).not.toHaveBeenCalled()
    harness.interactions.release(prompt)
  })

  it('cancels and drains an owned compaction before admitting a prompt', async () => {
    const completion = deferred<NextUpdate>()
    const session = fakeSession([completion.promise])
    const harness = createHarness({ session })
    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })

    const compaction = harness.workflow.compactIfIdle('app-session')
    const preemption = harness.workflow.preemptForPrompt('app-session')
    if (!preemption) throw new Error('Expected active compaction preemption')
    let preemptionSettled = false
    void preemption.finally(() => {
      preemptionSettled = true
    })

    expect(harness.cancelCompaction).toHaveBeenCalledWith('app-session')
    await Promise.resolve()
    expect(preemptionSettled).toBe(false)

    completion.resolve(stop('cancelled'))
    await expect(preemption).resolves.toBeUndefined()
    await expect(compaction).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.interactions.current('app-session')).toBeUndefined()
  })

  it.each([
    { boundary: 'queue', automatic: false },
    { boundary: 'preparation', automatic: false },
    { boundary: 'usage', automatic: false },
    { boundary: 'queue', automatic: true },
    { boundary: 'preparation', automatic: true },
    { boundary: 'usage', automatic: true }
  ])(
    'honors accepted cancellation at $boundary (automatic=$automatic)',
    async ({ boundary, automatic }) => {
      const waiting = deferred<void>()
      const entered = deferred<void>()
      const serialization = new AcpProviderPromptSerializationOwner()
      const cancelProbe = vi.fn()
      const waitAtBoundary = async (): Promise<void> => {
        entered.resolve()
        await waiting.promise
      }
      const predecessor =
        boundary === 'queue' ? serialization.run(codeBuddyFramework, waitAtBoundary) : undefined
      const harness = createHarness({
        framework: codeBuddyFramework,
        serialization,
        session: fakeSession([stop('end_turn')]),
        beforePromptDispatch: boundary === 'preparation' ? waitAtBoundary : undefined,
        usage:
          boundary === 'usage'
            ? {
                begin: async () => {
                  await waitAtBoundary()
                  return { finalize: () => ({}), cancel: cancelProbe }
                },
                cwd: () => '/workspace',
                model: () => 'model',
                record: async () => {}
              }
            : undefined
      })
      harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
      const restoreSession = vi.spyOn(harness.context, 'restoreSession')
      const interaction = automatic
        ? harness.interactions.claim({ sessionId: 'app-session', kind: 'prompt' })
        : undefined
      const compaction = interaction
        ? harness.workflow.compactAutomatic({
            sessionId: 'app-session',
            session: harness.session,
            interaction
          })
        : harness.workflow.compact({ sessionId: 'app-session' })
      await entered.promise
      const onAccepted = vi.fn()
      await harness.interactions.cancelPrompt({
        sessionId: 'app-session',
        notify: async () => undefined,
        onAccepted,
        onTimeout: vi.fn()
      })
      expect(onAccepted).toHaveBeenCalledTimes(1)
      waiting.resolve()
      await predecessor

      await expect(compaction).resolves.toEqual({ stopReason: 'cancelled' })
      expect(harness.session.prompt).not.toHaveBeenCalled()
      expect(harness.session.nextUpdate).not.toHaveBeenCalled()
      expect(restoreSession).toHaveBeenCalledTimes(1)
      expect(harness.promptContent.resetSession).not.toHaveBeenCalled()
      expect(harness.events.map(({ status }) => status)).toEqual(['in_progress', 'cancelled'])
      expect(cancelProbe).toHaveBeenCalledTimes(boundary === 'usage' ? 1 : 0)
      if (interaction) {
        expect(harness.interactions.current('app-session')).toBe(interaction)
        harness.interactions.release(interaction)
      } else {
        expect(harness.interactions.current('app-session')).toBeUndefined()
      }
    }
  )

  it.each([true, false])(
    'waits for cancellation admission and preserves failed notification behavior (accepted=%s)',
    async (accepted) => {
      const serialization = new AcpProviderPromptSerializationOwner()
      const predecessorGate = deferred<void>()
      const predecessor = serialization.run(codeBuddyFramework, () => predecessorGate.promise)
      const harness = createHarness({
        framework: codeBuddyFramework,
        serialization,
        session: fakeSession([stop('end_turn')])
      })
      const notification = deferred<void>()
      const cancellation = harness.workflow.compact({ sessionId: 'app-session' })
      const onAccepted = vi.fn()
      const stopRequest = harness.interactions.cancelPrompt({
        sessionId: 'app-session',
        notify: () => notification.promise,
        onAccepted,
        onTimeout: vi.fn()
      })
      const stopped = accepted
        ? expect(stopRequest).resolves.toBeUndefined()
        : expect(stopRequest).rejects.toThrow('notification failed')
      predecessorGate.resolve()
      await predecessor
      expect(harness.session.prompt).not.toHaveBeenCalled()
      if (accepted) notification.resolve()
      else {
        // The owner aborts its signal before notify settles; an abort alone is not acceptance.
        expect(harness.interactions.current('app-session')?.signal.aborted).toBe(true)
        notification.reject(new Error('notification failed'))
      }
      await stopped
      await expect(cancellation).resolves.toEqual({
        stopReason: accepted ? 'cancelled' : 'end_turn'
      })
      expect(onAccepted).toHaveBeenCalledTimes(accepted ? 1 : 0)
      expect(harness.session.prompt).toHaveBeenCalledTimes(accepted ? 0 : 1)
      expect(harness.events.at(-1)?.status).toBe(accepted ? 'cancelled' : 'completed')
    }
  )

  it('does not dispatch or restore a cancelled queued scope after replacement', async () => {
    const serialization = new AcpProviderPromptSerializationOwner()
    const gate = deferred<void>()
    const predecessor = serialization.run(codeBuddyFramework, () => gate.promise)
    const harness = createHarness({
      framework: codeBuddyFramework,
      serialization,
      session: fakeSession([stop('end_turn')])
    })
    const restoreSession = vi.spyOn(harness.context, 'restoreSession')
    const compaction = harness.workflow.compact({ sessionId: 'app-session' })
    const scope = harness.interactions.current('app-session')!
    await harness.interactions.cancelPrompt({
      sessionId: 'app-session',
      notify: async () => undefined,
      onAccepted: vi.fn(),
      onTimeout: vi.fn()
    })
    harness.interactions.release(scope)
    const replacement = harness.interactions.claim({ sessionId: 'app-session', kind: 'prompt' })
    gate.resolve()
    await predecessor

    await expect(compaction).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.session.prompt).not.toHaveBeenCalled()
    expect(restoreSession).not.toHaveBeenCalled()
    expect(harness.interactions.current('app-session')).toBe(replacement)
    harness.interactions.release(replacement)
  })

  it.each([false, true])(
    'honors Stop accepted in the final dispatch microtask (automatic=%s)',
    async (automatic) => {
      const trace: string[] = []
      let cancellation: Promise<void> | undefined
      let finalCheckpoint: Promise<'active' | 'cancelled'> | undefined
      const cancelProbe = vi.fn()
      const session = fakeSession([stop('end_turn')])
      session.prompt.mockImplementation(async () => {
        trace.push('provider.prompt')
      })
      const harness = createHarness({
        framework: codeBuddyFramework,
        session,
        beforePromptDispatch: async () => undefined,
        usage: {
          begin: async () => ({ finalize: () => ({}), cancel: cancelProbe }),
          cwd: () => '/workspace',
          model: () => 'model',
          record: async () => {}
        }
      })
      const originalCheckpoint = harness.interactions.cancellationCheckpoint.bind(
        harness.interactions
      )
      let checkpoints = 0
      const checkpoint = vi
        .spyOn(harness.interactions, 'cancellationCheckpoint')
        .mockImplementation((scope) => {
          const result = originalCheckpoint(scope)
          if (++checkpoints === 3) {
            // Preserve the owner's exact Promise and snapshot. Stop arrives after this final
            // active snapshot, while the workflow awaits its result before dispatch.
            finalCheckpoint = result
            expect(harness.interactions.isCancellationAccepted(scope)).toBe(false)
            trace.push('checkpoint.active')
            cancellation = harness.interactions.cancelPrompt({
              sessionId: 'app-session',
              notify: async () => undefined,
              onAccepted: () => trace.push('cancel.accepted'),
              onTimeout: vi.fn()
            })
          }
          return result
        })
      harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
      const interaction = automatic
        ? harness.interactions.claim({ sessionId: 'app-session', kind: 'prompt' })
        : undefined
      const compaction = interaction
        ? harness.workflow.compactAutomatic({ sessionId: 'app-session', session, interaction })
        : harness.workflow.compact({ sessionId: 'app-session' })
      try {
        const result = await compaction
        await cancellation
        expect(checkpoint.mock.results[2].value).toBe(finalCheckpoint)
        expect(await finalCheckpoint).toBe('active')
        expect(trace).toContain('cancel.accepted')
        if (session.prompt.mock.calls.length) {
          expect(trace.indexOf('cancel.accepted')).toBeLessThan(trace.indexOf('provider.prompt'))
        }
        expect(session.prompt).not.toHaveBeenCalled()
        expect(result).toEqual({ stopReason: 'cancelled' })
        expect(cancelProbe).toHaveBeenCalledTimes(1)
        expect(harness.events.map(({ status }) => status)).toEqual(['in_progress', 'cancelled'])
      } finally {
        if (interaction) harness.interactions.release(interaction)
      }
    }
  )

  it.each([
    { ownership: 'released', automatic: false },
    { ownership: 'replacement', automatic: false },
    { ownership: 'connection-cleared', automatic: false },
    { ownership: 'current', automatic: false },
    { ownership: 'released', automatic: true },
    { ownership: 'replacement', automatic: true },
    { ownership: 'connection-cleared', automatic: true },
    { ownership: 'current', automatic: true }
  ])(
    'restores a late preparation failure only for $ownership ownership (automatic=$automatic)',
    async ({ ownership, automatic }) => {
      const entered = deferred<void>()
      const preparation = deferred<void>()
      const harness = createHarness({
        session: fakeSession([stop('end_turn')]),
        beforePromptDispatch: async () => {
          entered.resolve()
          await preparation.promise
        }
      })
      harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
      const checkpointUsage = harness.context.usage('app-session')
      const restoreSession = vi.spyOn(harness.context, 'restoreSession')
      const interaction = automatic
        ? harness.interactions.claim({ sessionId: 'app-session', kind: 'prompt' })
        : undefined
      const compaction = interaction
        ? harness.workflow.compactAutomatic({
            sessionId: 'app-session',
            session: harness.session,
            interaction
          })
        : harness.workflow.compact({ sessionId: 'app-session' })
      const failed = expect(compaction).rejects.toThrow('late preparation failure')
      await entered.promise
      const original = harness.interactions.current('app-session')!
      if (ownership === 'connection-cleared') harness.interactions.supersedeAll()
      else if (ownership !== 'current') harness.interactions.release(original)
      const replacement =
        ownership === 'replacement'
          ? harness.interactions.claim({ sessionId: 'app-session', kind: 'prompt' })
          : undefined
      harness.context.reconcileProviderUsage('app-session', { used: 42_000, size: 200_000 })
      const latestUsage = harness.context.usage('app-session')
      preparation.reject(new Error('late preparation failure'))
      await failed

      expect(harness.session.prompt).not.toHaveBeenCalled()
      expect(restoreSession).toHaveBeenCalledTimes(ownership === 'current' ? 1 : 0)
      expect(harness.context.usage('app-session')).toEqual(
        ownership === 'current' ? checkpointUsage : latestUsage
      )
      expect(harness.events.map(({ status }) => status)).toEqual(['in_progress', 'failed'])
      expect(harness.interactions.current('app-session')).toBe(
        replacement ?? (automatic && ownership === 'current' ? interaction : undefined)
      )
      if (replacement) harness.interactions.release(replacement)
      if (interaction) harness.interactions.release(interaction)
    }
  )

  it('gates automatic compaction and preserves the current prompt interaction when eligible', async () => {
    const session = fakeSession([stop('end_turn')])
    const harness = createHarness({ session })
    const staleInteraction = harness.interactions.claim({
      sessionId: 'app-session',
      kind: 'prompt'
    })
    harness.interactions.supersede(staleInteraction)
    const interaction = harness.interactions.claim({ sessionId: 'app-session', kind: 'prompt' })

    await harness.workflow.compactAutomatic({
      sessionId: 'app-session',
      session,
      interaction: staleInteraction
    })
    await harness.workflow.compactAutomatic({
      sessionId: 'app-session',
      session: fakeSession(),
      interaction
    })
    harness.context.appendPromptContent('app-session', 'large local estimate')
    harness.context.refreshUsage('app-session', 'preflight', 200_000)
    await harness.workflow.compactAutomatic({ sessionId: 'app-session', session, interaction })
    harness.context.reconcileProviderUsage('app-session', { used: 100_000, size: 200_000 })
    await harness.workflow.compactAutomatic({ sessionId: 'app-session', session, interaction })

    expect(session.prompt).not.toHaveBeenCalled()

    harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
    await expect(
      harness.workflow.compactAutomatic({ sessionId: 'app-session', session, interaction })
    ).resolves.toEqual({ stopReason: 'end_turn' })

    expect(session.prompt).toHaveBeenCalledWith([{ type: 'text', text: '/compact' }])
    expect(
      harness.events.map(({ compactionReason, status }) => ({
        compactionReason,
        status
      }))
    ).toEqual([
      { compactionReason: 'automatic', status: 'in_progress' },
      { compactionReason: 'automatic', status: 'completed' }
    ])
    expect(harness.interactions.current('app-session')).toBe(interaction)
    harness.interactions.release(interaction)
  })

  it('cleans up the manual scope when the framework owns compaction', async () => {
    const harness = createHarness({ framework: frameworkManaged })

    await expect(harness.workflow.compact({ sessionId: 'app-session' })).rejects.toThrow(
      'Managed Agent manages context compaction automatically.'
    )

    expect(harness.session.prompt).not.toHaveBeenCalled()
    expect(harness.events).toEqual([])
    expect(harness.emitState).toHaveBeenCalledTimes(2)
    expect(harness.interactions.current('app-session')).toBeUndefined()
  })

  it.each([
    { stopReason: 'end_turn' as const, terminalStatus: 'completed', reset: true },
    { stopReason: 'cancelled' as const, terminalStatus: 'cancelled', reset: false }
  ])(
    'keeps $terminalStatus terminal state when projection callbacks throw',
    async ({ stopReason, terminalStatus, reset }) => {
      const harness = createHarness({ session: fakeSession([stop(stopReason)]) })
      const restoreSession = vi.spyOn(harness.context, 'restoreSession')
      harness.context.reconcileProviderUsage('app-session', { used: 180_000, size: 200_000 })
      harness.emitState.mockImplementation(() => {
        throw new Error('state listener failed')
      })
      harness.pushEvent.mockImplementation((event: Partial<AcpRuntimeEvent>) => {
        harness.events.push(event)
        if (event.status === terminalStatus) throw new Error('event listener failed')
      })

      await expect(harness.workflow.compact({ sessionId: 'app-session' })).resolves.toEqual({
        stopReason
      })

      expect(harness.promptContent.resetSession).toHaveBeenCalledTimes(reset ? 1 : 0)
      expect(restoreSession).toHaveBeenCalledTimes(reset ? 0 : 1)
      expect(harness.events.map(({ status }) => status)).toEqual(['in_progress', terminalStatus])
      expect(harness.interactions.current('app-session')).toBeUndefined()
    }
  )
})
