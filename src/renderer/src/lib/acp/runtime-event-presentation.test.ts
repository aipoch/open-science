import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../../../shared/acp'
import { createSessionStore } from '../../stores/session-store'
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
