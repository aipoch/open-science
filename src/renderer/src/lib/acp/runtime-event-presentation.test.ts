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
})
