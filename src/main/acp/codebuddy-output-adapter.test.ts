import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import { CodeBuddyOutputAdapter } from './codebuddy-output-adapter'

const message = (
  text: string,
  id = 'event-1',
  messageId = 'message-1'
): AcpRuntimeEvent & {
  kind: 'message'
  role: 'assistant'
  text: string
} => ({
  id,
  timestamp: 1,
  sessionId: 'session-1',
  kind: 'message',
  level: 'info',
  role: 'assistant',
  messageId,
  text,
  raw: { unfiltered: text }
})

describe('CodeBuddyOutputAdapter', () => {
  it('streams split think tags as thought events without leaking them into messages', () => {
    const adapter = new CodeBuddyOutputAdapter()

    expect(adapter.projectAssistantChunk('session-1', message('<thi', 'event-1'))).toEqual([])
    expect(
      adapter.projectAssistantChunk('session-1', message('nk>private reasoning', 'event-2'))
    ).toMatchObject([{ kind: 'thought', text: 'private reasoning', raw: undefined }])
    expect(adapter.projectAssistantChunk('session-1', message('</thi', 'event-3'))).toEqual([])
    expect(
      adapter.projectAssistantChunk('session-1', message('nk>Visible answer.', 'event-4'))
    ).toMatchObject([{ kind: 'message', text: 'Visible answer.', raw: undefined }])
  })

  it('segments assistant messages after tools that omit a provider message id', () => {
    const adapter = new CodeBuddyOutputAdapter()
    const tool = (toolCallId: string): AcpRuntimeEvent =>
      adapter.projectToolEvent(
        'session-1',
        {
          id: `event-${toolCallId}`,
          timestamp: 1,
          sessionId: 'session-1',
          kind: 'tool',
          level: 'info',
          toolCallId
        },
        true
      )

    expect(adapter.projectAssistantChunk('session-1', message('Before tool.'))).toMatchObject([
      { kind: 'message', messageId: 'message-1', text: 'Before tool.' }
    ])
    expect(tool('tool-1')).not.toHaveProperty('messageId')
    expect(adapter.projectAssistantChunk('session-1', message('After tool.'))).toMatchObject([
      { kind: 'message', messageId: 'message-1:tool-1', text: 'After tool.' }
    ])
    expect(tool('tool-2')).not.toHaveProperty('messageId')
    expect(adapter.projectAssistantChunk('session-1', message('After second tool.'))).toMatchObject(
      [{ kind: 'message', messageId: 'message-1:tool-2', text: 'After second tool.' }]
    )
    expect(
      adapter.projectAssistantChunk(
        'session-1',
        message('Next response.', 'event-next', 'message-2')
      )
    ).toMatchObject([{ kind: 'message', messageId: 'message-2', text: 'Next response.' }])
  })
})
