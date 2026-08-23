import type { ActiveSession, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import { claudeCodeFramework } from '../agent-framework'
import type { AgentFramework } from '../agent-framework/types'
import { AcpContextCompactionWorkflow } from './context-compaction-workflow'
import { ContextUsageTracker, type TokenCounter } from './context-usage-tracker'
import { AcpSessionInteractionOwner } from './session-interaction-owner'

type NextUpdate = Awaited<ReturnType<ActiveSession['nextUpdate']>>

type Deferred<Value> = {
  promise: Promise<Value>
  resolve: (value: Value) => void
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
  const promise = new Promise<Value>((done) => (resolve = done))
  return { promise, resolve }
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

const fakeSession = (messages: Array<NextUpdate | Promise<NextUpdate>> = []): FakeSession => {
  const queue = [...messages]
  return {
    sessionId: 'provider-session',
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
