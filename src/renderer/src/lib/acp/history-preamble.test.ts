import { describe, expect, it } from 'vitest'

import { buildHistoryPreamble, buildHistoryReplayMedia } from './history-preamble'
import type { ChatMessage } from '../../stores/session-store'

const message = (
  partial: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>
): ChatMessage =>
  ({
    id: Math.random().toString(36).slice(2),
    status: 'complete',
    eventIds: [],
    createdAt: 0,
    updatedAt: 0,
    ...partial
  }) as ChatMessage

describe('buildHistoryPreamble', () => {
  it('returns undefined when there is nothing meaningful to replay', () => {
    expect(buildHistoryPreamble([])).toBeUndefined()
    expect(
      buildHistoryPreamble([
        message({ role: 'user', content: '   ' }),
        message({ role: 'agent', content: '', status: 'error' })
      ])
    ).toBeUndefined()
  })

  it('renders labelled user/assistant turns in order', () => {
    const preamble = buildHistoryPreamble([
      message({ role: 'user', content: 'plot the data' }),
      message({ role: 'agent', content: 'done, see chart.png' })
    ])

    expect(preamble).toContain('before you joined it')
    expect(preamble).toContain('**User:** plot the data')
    expect(preamble).toContain('**Assistant:** done, see chart.png')
    const userIndex = preamble!.indexOf('**User:**')
    const agentIndex = preamble!.indexOf('**Assistant:**')
    expect(userIndex).toBeLessThan(agentIndex)
  })

  it('skips failed and empty turns', () => {
    const preamble = buildHistoryPreamble([
      message({ role: 'user', content: 'first' }),
      message({ role: 'agent', content: 'half a reply', status: 'error' }),
      message({ role: 'user', content: 'second' })
    ])

    expect(preamble).not.toContain('half a reply')
    expect(preamble).toContain('**User:** first')
    expect(preamble).toContain('**User:** second')
  })

  it('keeps the most recent turns within budget and marks omissions', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message({
        role: index % 2 === 0 ? 'user' : 'agent',
        content: `turn-${index} ${'x'.repeat(50)}`
      })
    )

    const preamble = buildHistoryPreamble(messages, 200)

    expect(preamble).toContain('earlier turns omitted')
    // The newest turn survives; the oldest is dropped.
    expect(preamble).toContain('turn-9')
    expect(preamble).not.toContain('turn-0 ')
  })

  it('hard-bounds a single oversized latest turn', () => {
    const budget = 80
    const preamble = buildHistoryPreamble(
      [message({ role: 'user', content: `start-${'a'.repeat(500)}-end` })],
      budget
    )
    const transcript = preamble?.split('\n\n').slice(1).join('\n\n') ?? ''

    expect(transcript.length).toBeLessThanOrEqual(budget)
    expect(transcript).toContain('-end')
    expect(transcript).not.toContain('start-')
  })

  it('collects bounded recent image uploads and inline assistant images for replay', () => {
    const media = buildHistoryReplayMedia([
      message({
        role: 'user',
        content: 'look',
        uploads: [
          {
            id: 'u1',
            sessionId: 's1',
            name: 'plot.png',
            originalName: 'plot.png',
            path: '/uploads/plot.png',
            mimeType: 'image/png',
            size: 10
          }
        ]
      }),
      message({
        role: 'agent',
        content: '',
        images: [{ id: 'i1', mimeType: 'image/png', data: 'aGVsbG8=', byteLength: 5 }]
      })
    ])

    expect(media.attachments.map((item) => item.id)).toEqual(['u1'])
    expect(media.images).toHaveLength(1)
  })
})
