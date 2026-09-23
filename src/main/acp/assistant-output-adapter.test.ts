import { describe, expect, it } from 'vitest'

import type { AcpRuntimeEvent } from '../../shared/acp'
import { AcpAssistantOutputAdapter } from './assistant-output-adapter'

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

describe('AcpAssistantOutputAdapter', () => {
  it('preserves the same reasoning and answer at every chunk split', () => {
    const text = '<think>reasoning 🧪</think>Answer: `literal <think>tag</think>`'
    for (let split = 0; split <= text.length; split++) {
      const adapter = new AcpAssistantOutputAdapter()
      const events = [
        ...adapter.projectAssistantChunk('session-1', message(text.slice(0, split), 'a'), true),
        ...adapter.projectAssistantChunk('session-1', message(text.slice(split), 'b'), true),
        ...adapter.finishSession('session-1')
      ]
      expect(
        events
          .filter((e) => e.kind === 'thought')
          .map((e) => e.text)
          .join('')
      ).toBe('reasoning 🧪')
      expect(
        events
          .filter((e) => e.kind === 'message')
          .map((e) => e.text)
          .join('')
      ).toBe('Answer: `literal <think>tag</think>`')
      expect(new Set(events.map((e) => e.id)).size).toBe(events.length)
    }
  })

  it.each([
    'Use <think>literal</think>.',
    '```xml\n<think>literal</think>\n```',
    '`<think>literal</think>`'
  ])('preserves literal tags in an OpenCode answer: %s', (text) => {
    const adapter = new AcpAssistantOutputAdapter()
    const events = [...text].flatMap((chunk, index) =>
      adapter.projectAssistantChunk('session-1', message(chunk, `e-${index}`), true)
    )
    expect(events.every((e) => e.kind === 'message')).toBe(true)
    expect(events.map((e) => e.text).join('')).toBe(text)
  })

  it('flushes a partial literal before stop and isolates reused message ids and sessions', () => {
    const adapter = new AcpAssistantOutputAdapter()
    adapter.projectAssistantChunk('session-1', message('<thi'), true)
    adapter.projectAssistantChunk(
      'session-2',
      { ...message('<think>other'), sessionId: 'session-2' },
      true
    )
    expect(adapter.finishSession('session-1')).toMatchObject([
      { kind: 'message', text: '<thi', raw: undefined }
    ])
    expect(adapter.projectAssistantChunk('session-1', message('next turn'), true)).toMatchObject([
      { kind: 'message', text: 'next turn' }
    ])
    expect(
      adapter.projectAssistantChunk(
        'session-2',
        { ...message(' thought</think>reply'), sessionId: 'session-2' },
        true
      )
    ).toMatchObject([
      { kind: 'thought', text: ' thought' },
      { kind: 'message', text: 'reply' }
    ])
  })

  it('keeps a stable thought identity when the framework omits message ids', () => {
    const adapter = new AcpAssistantOutputAdapter()
    const first = adapter.projectAssistantChunk(
      'session-1',
      { ...message('<think>a', 'e-1'), messageId: undefined },
      true
    )
    const next = adapter.projectAssistantChunk(
      'session-1',
      { ...message('b</think>answer', 'e-2'), messageId: undefined },
      true
    )
    expect(first[0].messageId).toBe(next[0].messageId)
    expect(first[0].id).not.toBe(next[0].id)
  })

  it('retires unterminated reasoning on cancellation without changing the next turn', () => {
    const adapter = new AcpAssistantOutputAdapter()
    adapter.projectAssistantChunk('session-1', message('<think>hidden</thi'), true)
    expect(adapter.finishSession('session-1')).toMatchObject([{ kind: 'thought', text: '</thi' }])
    expect(
      adapter.projectAssistantChunk('session-1', message('ordinary answer'), true)
    ).toMatchObject([{ kind: 'message', text: 'ordinary answer' }])
    adapter.clear()
    expect(adapter.finishSession('session-1')).toEqual([])
  })

  it('streams split think tags as thought events without leaking them into messages', () => {
    const adapter = new AcpAssistantOutputAdapter()

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
    const adapter = new AcpAssistantOutputAdapter()
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
