import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  RuntimeSessionOwner,
  TERMINAL_COMMIT_INITIAL_BUDGET_MS,
  TERMINAL_COMMIT_MAX_ATTEMPTS,
  TERMINAL_COMMIT_RETRY_BUDGET_MS
} from './runtime-session-owner'

// The fixture retains exact mock signatures for failure-injection assertions.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = () => {
  let durable: PersistedChatSession = materializeSessionConversationGraph({
    id: 'session',
    projectId: 'project',
    title: 'Research',
    cwd: '/workspace',
    status: 'running',
    activeRun: { promptMessageId: 'prompt', startedAt: 1 },
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Research',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    agentFrameworkId: 'codex',
    createdAt: 1,
    updatedAt: 1
  })
  const graph = durable.conversationGraph!
  const scope = {
    projectId: durable.projectId,
    sessionId: durable.id,
    promptMessageId: 'prompt',
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    executionId: 'execution-1'
  }
  const publish = vi.fn()
  const exhausted = vi.fn()
  let failure: Error | undefined
  let gate: Promise<void> | undefined
  const mutate = vi.fn(
    async (_scope, mutation: (session: PersistedChatSession) => PersistedChatSession) => {
      if (gate) await gate
      if (failure) throw failure
      durable = mutation(structuredClone(durable))
      return structuredClone(durable)
    }
  )
  const owner = new RuntimeSessionOwner({
    loadSession: async () => structuredClone(durable),
    mutateSession: mutate,
    finalizeArtifacts: async () => [],
    onTerminalCommitExhausted: exhausted,
    scheduleFlush: () => () => undefined,
    now: () => 10
  })
  const event: AcpRuntimeEvent = {
    id: 'terminal-1',
    timestamp: 5,
    sessionId: scope.sessionId,
    promptMessageId: scope.promptMessageId,
    kind: 'stop',
    level: 'info',
    text: 'end_turn'
  }
  return {
    scope,
    owner,
    event,
    publish,
    exhausted,
    mutate,
    read: () => structuredClone(durable),
    fail: (error?: Error) => {
      failure = error
    },
    stall: (value?: Promise<void>) => {
      gate = value
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('terminal persistence recovery preserves execution authority', () => {
  it.each([
    ['Cannot update a missing runtime Session.', 'missing-record'],
    ['disk temporarily unavailable', 'storage']
  ])('bounds retries for %s and retains an explicit recovery', async (message, kind) => {
    vi.useFakeTimers()
    const h = harness()
    await h.owner.begin(h.scope)
    h.mutate.mockClear()
    h.fail(new Error(message))
    await h.owner.commitTerminal(h.event, h.publish)
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.mutate).toHaveBeenCalledTimes(1)
    h.owner.retryTerminalCommits(h.scope.sessionId)
    await vi.runAllTimersAsync()
    expect(h.mutate).toHaveBeenCalledTimes(TERMINAL_COMMIT_MAX_ATTEMPTS)
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        interruptionCause: 'terminal-commit-failed',
        terminalCommitFailure: kind,
        terminalScope: expect.objectContaining({ executionId: h.scope.executionId, startedAt: 1 })
      })
    )
    expect(h.read().status).toBe('running')
    expect(h.read().messages).toHaveLength(1)
    h.fail()
    await h.owner.retryTerminalCommitNow(
      h.scope.sessionId,
      h.scope.promptMessageId,
      'other-execution'
    )
    expect(h.mutate).toHaveBeenCalledTimes(TERMINAL_COMMIT_MAX_ATTEMPTS)
    await h.exhausted.mock.calls[0][2]()
    expect(h.read().status).toBe('idle')
    expect(h.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: h.event.id, kind: 'stop' })
    )
    expect(h.read().runtimeSessionAdmissions).toHaveLength(1)
  })

  it('releases a stalled initial commit within its deadline and bounds detached retries', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.owner.begin(h.scope)
    let release!: () => void
    h.stall(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const initial = h.owner.commitTerminal(h.event, h.publish)
    await vi.advanceTimersByTimeAsync(TERMINAL_COMMIT_INITIAL_BUDGET_MS)
    await initial
    expect(h.publish).not.toHaveBeenCalled()
    h.owner.retryTerminalCommits(h.scope.sessionId)
    await vi.advanceTimersByTimeAsync(TERMINAL_COMMIT_RETRY_BUDGET_MS)
    expect(h.exhausted).toHaveBeenCalledOnce()
    expect(h.publish).toHaveBeenCalledOnce()
    h.stall()
    release()
    await vi.runAllTimersAsync()
    await h.owner.retryTerminalCommitNow(
      h.scope.sessionId,
      h.scope.promptMessageId,
      h.scope.executionId
    )
    expect(h.read().status).toBe('idle')
    expect(h.read().messages.map(({ id }) => id)).toEqual(['prompt'])
  })

  it('still publishes the live release when the exhaustion callback throws', async () => {
    vi.useFakeTimers()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const h = harness()
      h.exhausted.mockImplementation(() => {
        throw new Error('registry unavailable')
      })
      await h.owner.begin(h.scope)
      h.fail(new Error('disk temporarily unavailable'))
      await h.owner.commitTerminal(h.event, h.publish)
      h.owner.retryTerminalCommits(h.scope.sessionId)
      await vi.runAllTimersAsync()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.exhausted).toHaveBeenCalledOnce()
      expect(h.publish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ interruptionCause: 'terminal-commit-failed' })
      )
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it.each(['initial', 'retry'] as const)(
    'publishes the committed terminal when a slow %s write finally succeeds after exhaustion',
    async (phase) => {
      vi.useFakeTimers()
      const h = harness()
      await h.owner.begin(h.scope)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      if (phase === 'initial') {
        h.stall(gate)
        const initial = h.owner.commitTerminal(h.event, h.publish)
        await vi.advanceTimersByTimeAsync(TERMINAL_COMMIT_INITIAL_BUDGET_MS)
        await initial
      } else {
        h.fail(new Error('disk temporarily unavailable'))
        await h.owner.commitTerminal(h.event, h.publish)
        h.fail()
        h.stall(gate)
      }
      h.owner.retryTerminalCommits(h.scope.sessionId)
      await vi.advanceTimersByTimeAsync(TERMINAL_COMMIT_RETRY_BUDGET_MS)
      expect(h.exhausted).toHaveBeenCalledOnce()
      expect(h.publish).toHaveBeenCalledOnce()
      h.publish.mockClear()
      h.fail()
      h.stall()
      release()
      await vi.runAllTimersAsync()
      expect(h.read().status).toBe('idle')
      expect(h.publish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: h.event.id, kind: 'stop', publicationOwner: 'main' })
      )
    }
  )
})
