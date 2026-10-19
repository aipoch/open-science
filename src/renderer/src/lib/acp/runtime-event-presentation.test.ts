import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../../../shared/acp'
import { createSessionStore, toPersistedSession } from '../../stores/session-store'
import { createRuntimeEventSubscriptionOwner } from './runtime-event-subscription-owner'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  forkConversationAfterActivity
} from '../../../../shared/conversation-graph'
import { applyRuntimeSessionEvents } from '../../../../shared/runtime-session-projection'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import {
  applyRuntimePresentationEvent,
  createRuntimePresentationContext
} from './runtime-event-presentation'

const event = (overrides: Partial<AcpRuntimeEvent>): AcpRuntimeEvent =>
  ({
    id: 'event-1',
    timestamp: 1_710_000_000_000,
    kind: 'message',
    level: 'info',
    sessionId: 'session-1',
    ...overrides
  }) as unknown as AcpRuntimeEvent

describe('runtime event presentation reducer', () => {
  it('projects rich assistant messages and grouped tool updates through an injected store', () => {
    const store = createSessionStore()
    const context = createRuntimePresentationContext()
    const prompt = store.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Inspect the repository'
    })

    expect(
      applyRuntimePresentationEvent(
        event({
          role: 'assistant',
          messageId: 'assistant-stream',
          text: 'I will inspect it.'
        }),
        store,
        context
      )
    ).toBe(true)
    expect(
      applyRuntimePresentationEvent(
        event({
          id: 'group-start',
          kind: 'tool',
          toolCallId: 'group-call',
          providerToolName: 'mcp__open-science-activity__begin_activity_group',
          rawInput: { title: 'Inspect implementation' },
          status: 'completed',
          promptMessageId: prompt?.messageId
        }),
        store,
        context
      )
    ).toBe(true)
    applyRuntimePresentationEvent(
      event({
        id: 'tool-start',
        kind: 'tool',
        toolCallId: 'bash-call',
        providerToolName: 'Bash',
        toolKind: 'execute',
        title: 'npm test',
        status: 'in_progress',
        rawInput: { command: 'npm test' },
        promptMessageId: prompt?.messageId
      }),
      store,
      context
    )
    applyRuntimePresentationEvent(
      event({
        id: 'tool-stop',
        kind: 'tool',
        toolCallId: 'bash-call',
        status: 'completed',
        terminalOutput: 'All tests passed',
        terminalExitCode: 0,
        rawOutput: { stdout: 'All tests passed' },
        promptMessageId: prompt?.messageId
      }),
      store,
      context
    )

    const session = store.getState().sessions[0]
    expect(session.messages[1]).toMatchObject({
      content: 'I will inspect it.',
      createdAt: 1_710_000_000_000,
      streamId: 'assistant-stream',
      status: 'streaming'
    })
    expect(session.activityGroups).toEqual([
      expect.objectContaining({
        id: 'group-call',
        title: 'Inspect implementation',
        activityIds: ['bash-call']
      })
    ])
    expect(session.activities).toEqual([
      expect.objectContaining({
        id: 'bash-call',
        activityGroupId: 'group-call',
        status: 'completed',
        rawInput: { command: 'npm test' },
        rawOutput: { stdout: 'All tests passed' },
        terminalOutput: 'All tests passed',
        terminalExitCode: 0,
        eventIds: ['tool-start', 'tool-stop']
      })
    ])
  })

  it('attributes a terminal tool to the owning prompt after a routed reply without an active run', () => {
    const store = createSessionStore()
    const context = createRuntimePresentationContext()
    const prompt = store.getState().appendUserMessage({
      sessionId: 'session-1',
      content: 'Inspect the repository'
    })
    store.getState().setAgentPromptInFlight('session-1', true)
    // The foreground runtime can own the request while the renderer holds no local run record.
    store.setState((state) => ({
      sessions: state.sessions.map((session) => ({ ...session, activeRun: undefined }))
    }))
    applyRuntimePresentationEvent(
      event({
        id: 'steering',
        role: 'user',
        messageId: 'steering-message',
        text: 'Also check the tests',
        promptMessageId: prompt?.messageId
      }),
      store,
      context
    )
    expect(store.getState().sessions[0].awaitingFirstAgentOutput).toBeFalsy()
    for (const [id, status] of [
      ['tool-start', 'in_progress'],
      ['tool-stop', 'completed']
    ] as const)
      applyRuntimePresentationEvent(
        event({
          id,
          kind: 'tool',
          toolCallId: 'bash-call',
          providerToolName: 'Bash',
          toolKind: 'execute',
          title: 'npm test',
          status,
          promptMessageId: prompt?.messageId
        }),
        store,
        context
      )

    const session = store.getState().sessions[0]
    console.log(
      JSON.stringify({
        m: session.messages.map(({ id, role, responseToMessageId }) => ({
          id,
          role,
          responseToMessageId
        })),
        a: session.activities?.map(({ id, promptMessageId, status }) => ({
          id,
          promptMessageId,
          status
        })),
        run: session.activeRun,
        st: session.status,
        p: prompt
      })
    )
    expect(session.messages.at(-1)?.responseToMessageId).toBe(prompt?.messageId)
    expect(session.awaitingFirstAgentOutput).toBe(true)
  })
})

it('retains main-owned receipt provenance across incremental updates', () => {
  const store = createSessionStore()
  const context = createRuntimePresentationContext()
  store.getState().appendUserMessage({ sessionId: 'session-1', content: 'Review the code' })
  applyRuntimePresentationEvent(
    event({
      id: 'review-start',
      kind: 'tool',
      toolCallId: 'app-approval:review',
      appOwned: true,
      status: 'in_progress'
    }),
    store,
    context
  )
  applyRuntimePresentationEvent(
    event({
      id: 'review-end',
      kind: 'tool',
      toolCallId: 'app-approval:review',
      status: 'completed'
    }),
    store,
    context
  )
  expect(store.getState().sessions[0].activities?.[0]).toMatchObject({
    appOwned: true,
    status: 'completed'
  })
})

const startupFixture = (): {
  session: PersistedChatSession
  scope: Parameters<typeof applyRuntimeSessionEvents>[1]
  startup: AcpRuntimeEvent
} => {
  const prompt = {
    id: 'prompt',
    role: 'user' as const,
    content: 'Inspect',
    status: 'complete' as const,
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  }
  const graph = createLinearConversationGraph({
    sessionId: 'session-1',
    messages: [prompt],
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 1
  })
  const scope = {
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.branches[0].id,
    promptMessageId: prompt.id,
    runtimeSegmentId: graph.runtimeSegments[0].id
  }
  const session: PersistedChatSession = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Startup',
    cwd: '/workspace',
    agentFrameworkId: 'codex',
    status: 'running',
    runtimeTranscriptOwner: 'main',
    activeRun: { promptMessageId: prompt.id, startedAt: 1 },
    messages: [prompt],
    conversationGraph: graph,
    createdAt: 1,
    updatedAt: 1
  }
  const startup = event({
    id: 'startup',
    kind: 'tool',
    timestamp: 2,
    toolCallId: 'mcp_startup.example',
    title: 'mcp__example__startup',
    status: 'failed',
    promptMessageId: prompt.id
  })
  return { session, scope, startup }
}

describe('MCP startup activity identity across persistence and presentation', () => {
  it.each([false, true])(
    'replays and updates a hydrated startup without duplicating evidence (legacy: %s)',
    (legacy) => {
      const { session, scope, startup } = startupFixture()
      const saved = applyRuntimeSessionEvents(session, scope, [startup])
      if (legacy) {
        saved.conversationGraph!.activities[0].id = startup.toolCallId!
        saved.activities![0].id = startup.toolCallId!
      }
      const store = createSessionStore()
      store.getState().hydrateSessions([JSON.parse(JSON.stringify(saved))])
      const context = createRuntimePresentationContext()
      const id = saved.activities![0].id
      const subscription = createRuntimeEventSubscriptionOwner()
      subscription.observeInitialSnapshot([startup])
      const unsubscribe = subscription.subscribe((events) => {
        for (const next of events) applyRuntimePresentationEvent(next, store, context)
      })
      expect(store.getState().sessions[0].activities).toHaveLength(1)
      unsubscribe()
      applyRuntimePresentationEvent(
        { ...startup, id: 'startup-detail', rawOutput: 'Connection refused' },
        store,
        context
      )
      expect(store.getState().sessions[0].activities).toEqual([
        expect.objectContaining({
          id,
          eventIds: ['startup', 'startup-detail'],
          rawOutput: 'Connection refused'
        })
      ])
    }
  )

  it('uses the durable identity before the first startup event is saved', () => {
    const { session, scope, startup } = startupFixture()
    const store = createSessionStore()
    store.getState().hydrateSessions([session])
    const context = createRuntimePresentationContext()
    applyRuntimePresentationEvent(startup, store, context)
    expect(store.getState().sessions[0].awaitingFirstAgentOutput).toBe(true)
    const expected = applyRuntimeSessionEvents(session, scope, [startup]).activities![0].id
    expect(store.getState().sessions[0].activities?.map(({ id }) => id)).toEqual([expected])
  })

  it('marks first-output waiting for a new prompt beside a legacy startup record', () => {
    const { session, scope, startup } = startupFixture()
    const saved = applyRuntimeSessionEvents(session, scope, [startup])
    const graph = saved.conversationGraph!
    graph.activities[0].id = startup.toolCallId!
    saved.activities![0].id = startup.toolCallId!
    const nextPrompt = {
      ...graph.messages[0],
      id: 'next-prompt',
      parentMessageId: scope.promptMessageId,
      createdAt: 3,
      updatedAt: 3
    }
    graph.messages.push(nextPrompt)
    graph.branches[0].headMessageId = nextPrompt.id
    saved.messages.push(nextPrompt)
    saved.activeRun = { promptMessageId: nextPrompt.id, startedAt: 3 }
    const store = createSessionStore()
    store.getState().hydrateSessions([saved])
    const retry = { ...startup, id: 'next-startup', promptMessageId: nextPrompt.id, timestamp: 4 }
    applyRuntimePresentationEvent(retry, store, createRuntimePresentationContext())
    expect(store.getState().sessions[0].activities).toHaveLength(2)
    expect(store.getState().sessions[0].awaitingFirstAgentOutput).toBe(true)
    expect(store.getState().sessions[0].activities?.[0].eventIds).toEqual([startup.id])
  })

  it('isolates continuation branches and ignores replay from a hidden predecessor', () => {
    const { session, scope, startup } = startupFixture()
    const original = applyRuntimeSessionEvents(session, scope, [startup])
    const graph = forkConversationAfterActivity(
      original.conversationGraph!,
      scope.promptMessageId,
      original.activities![0].id,
      'continuation',
      3
    )
    const continued = { ...original, conversationGraph: graph, activities: [] }
    const retry = { ...startup, id: 'startup-retry', timestamp: 4 }
    const expected = applyRuntimeSessionEvents(
      continued,
      { ...scope, messageBranchId: 'continuation' },
      [retry]
    )
    const store = createSessionStore()
    store.getState().hydrateSessions([continued])
    const context = createRuntimePresentationContext()
    applyRuntimePresentationEvent(startup, store, context)
    expect(store.getState().sessions[0].activities ?? []).toHaveLength(0)
    applyRuntimePresentationEvent(retry, store, context)
    expect(store.getState().sessions[0].activities?.map(({ id }) => id)).toEqual(
      expected.activities!.map(({ id }) => id)
    )
  })

  it.each([false, true])(
    'uses the admitted runtime segment when a continuation reuses its prompt (hidden: %s)',
    (hidden) => {
      const { session, scope, startup } = startupFixture()
      const graph = session.conversationGraph!
      graph.runtimeSegments.push({
        ...graph.runtimeSegments[0],
        id: 'resumed-segment',
        startedAt: 3
      })
      const resumedScope = { ...scope, runtimeSegmentId: 'resumed-segment' }
      session.runtimeSessionAdmissions = [
        {
          ...resumedScope,
          executionId: 'resumed-execution',
          rootFrameId: graph.rootFrameId,
          promptRuntimeSegmentId: scope.runtimeSegmentId
        }
      ]
      if (hidden) {
        session.conversationGraph = forkEditedConversationMessage(
          graph,
          scope.promptMessageId,
          'selected-branch',
          3
        )
        session.messages = []
      }
      const resumed = { ...startup, timestamp: 4, promptExecutionId: 'resumed-execution' }
      const store = createSessionStore()
      store.getState().hydrateSessions([session])
      applyRuntimePresentationEvent(resumed, store, createRuntimePresentationContext())
      const projected = store.getState().sessions[0]
      const persisted = toPersistedSession(projected)
      expect(persisted.conversationGraph?.activities).toEqual([
        expect.objectContaining({ ...resumedScope, eventIds: [resumed.id] })
      ])
      const expected = applyRuntimeSessionEvents(session, resumedScope, [resumed])
      expect(persisted.conversationGraph?.activities.map(({ id }) => id)).toEqual(
        expected.conversationGraph!.activities.map(({ id }) => id)
      )
      expect(projected.activities ?? []).toHaveLength(hidden ? 0 : 1)
      expect(projected.activeRunRuntimeSegmentId).toBeUndefined()
    }
  )

  it.each([
    ['claude-code', 'claude-code'],
    ['opencode', 'opencode'],
    ['codex', 'codex-responses'],
    ['codex', 'codex-bridge']
  ] as const)('preserves ordinary tool identities for %s / %s', (framework, backend) => {
    const { session, scope, startup } = startupFixture()
    session.agentFrameworkId = framework
    session.agentBackendId = backend
    const ordinary = { ...startup, toolCallId: 'ordinary-tool', title: 'Read file' }
    const saved = applyRuntimeSessionEvents(session, scope, [ordinary])
    const store = createSessionStore()
    store.getState().hydrateSessions([saved])
    const context = createRuntimePresentationContext()
    applyRuntimePresentationEvent(ordinary, store, context)
    applyRuntimePresentationEvent(
      { ...ordinary, id: 'tool-detail', rawOutput: 'done' },
      store,
      context
    )
    expect(store.getState().sessions[0].activities).toEqual([
      expect.objectContaining({
        id: 'ordinary-tool',
        eventIds: ['startup', 'tool-detail'],
        rawOutput: 'done'
      })
    ])
  })
})
