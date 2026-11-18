import { describe, expect, it, vi } from 'vitest'
import { journalValueByteLength, normalizeJournalValue, type JournalValue } from './journal-codec'
import {
  applySessionRecord,
  diffSessionRecords,
  validateSessionRecords,
  type SessionBusinessRecord,
  type SessionTextEvent
} from './session-record-codec'

type Message = {
  id: string
  role: string
  status: string
  streamId: string
  responseToMessageId: string
  content: string
  eventIds: string[]
  createdAt: number
  updatedAt: number
  agentFrameId?: string
  introducedOnBranchId?: string
  runtimeSegmentId?: string
  images?: { id: string }[]
  notes?: string
}
type Document = {
  version: number
  session: {
    id: string
    revision: number
    messages: Message[]
    conversationGraph: { messages: Message[] }
  }
}
const document = (): Document => {
  const flat: Message = {
    id: 'message',
    role: 'agent',
    status: 'streaming',
    streamId: 'stream',
    responseToMessageId: 'prompt',
    content: 'retained body '.repeat(1_000),
    eventIds: ['initial'],
    createdAt: 1,
    updatedAt: 2
  }
  return {
    version: 2,
    session: {
      id: 'session',
      revision: 1,
      messages: [flat],
      conversationGraph: {
        messages: [
          {
            ...flat,
            eventIds: [...flat.eventIds],
            agentFrameId: 'frame',
            introducedOnBranchId: 'branch',
            runtimeSegmentId: 'segment'
          }
        ]
      }
    }
  }
}
const events: SessionTextEvent[] = [
  { messageId: 'message', eventId: 'second', text: ' new', timestamp: 5 },
  { messageId: 'message', eventId: 'third', text: ' text', timestamp: 4 }
]
const continued = (before: Document): Document => {
  const after = structuredClone(before)
  after.session.revision++
  for (const message of [...after.session.messages, ...after.session.conversationGraph.messages]) {
    message.content += events.map((event) => event.text).join('')
    message.eventIds.push(...events.map((event) => event.eventId))
    message.updatedAt = 5
  }
  return after
}
const replay = (before: unknown, records: readonly SessionBusinessRecord[]): JournalValue =>
  records.reduce(
    (document, record) => applySessionRecord(document, record),
    normalizeJournalValue(before)
  )
const textRecord = (): Extract<SessionBusinessRecord, { type: 'assistant_text_received' }> => {
  const before = document()
  return diffSessionRecords(normalizeJournalValue(before), continued(before), {
    textEvents: events
  }).find((record) => record.type === 'assistant_text_received')!
}

describe('accepted runtime text business events', () => {
  it('retains exact event-ID byte sizes in both views without re-encoding historical IDs', () => {
    const raw = document()
    const ids = Array.from(
      { length: 160 },
      (_, index) => `accepted-${index}-${'汉字"\\\ud800'.repeat(30)}`
    )
    raw.session.messages[0].eventIds = [...ids]
    raw.session.conversationGraph.messages[0].eventIds = [...ids]
    const before = normalizeJournalValue(raw)
    const after = continued(raw)
    const records = diffSessionRecords(before, after, { textEvents: events })
    journalValueByteLength(before)
    let result!: JournalValue
    const spy = vi.spyOn(JSON, 'stringify')
    try {
      result = before
      for (const record of records) {
        result = applySessionRecord(result, record)
        journalValueByteLength(result)
      }
      const historicalIds = new Set(ids)
      expect(
        spy.mock.calls.filter(([value]) => typeof value === 'string' && historicalIds.has(value))
      ).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
    expect(result).toEqual(after)
    expect(journalValueByteLength(result)).toBe(Buffer.byteLength(JSON.stringify(after)))
    expect(records.some((record) => record.type === 'assistant_text_received')).toBe(true)
  })
  it('stores only actual new chunks once and strictly rebuilds both complete message views', () => {
    const before = document()
    const after = continued(before)
    const records = diffSessionRecords(normalizeJournalValue(before), after, { textEvents: events })
    expect(records.map((record) => record.type)).toEqual(['metadata', 'assistant_text_received'])
    expect(records[1]).toEqual({
      type: 'assistant_text_received',
      sessionId: 'session',
      messageId: 'message',
      streamId: 'stream',
      promptMessageId: 'prompt',
      agentFrameId: 'frame',
      messageBranchId: 'branch',
      runtimeSegmentId: 'segment',
      chunks: events.map(({ eventId, text, timestamp }) => ({ eventId, text, timestamp }))
    })
    expect(replay(before, records)).toEqual(after)
    expect(JSON.stringify(records)).not.toContain('retained body')
    expect(JSON.stringify(records).match(/"text":" new"/g)).toHaveLength(1)
    expect(JSON.stringify(records)).not.toMatch(/"(?:path|offset|operations)":/)
  })

  it('never invents text events from before/after strings without runtime evidence', () => {
    const before = document()
    const after = continued(before)
    const records = diffSessionRecords(normalizeJournalValue(before), after)
    expect(records.some((record) => record.type === 'assistant_text_received')).toBe(false)
    expect(replay(before, records)).toEqual(after)
  })

  it.each(['missing-chunk', 'wrong-text', 'duplicate-id', 'already-applied', 'negative-time'])(
    'falls back to complete records for ineligible hint: %s',
    (kind) => {
      const before = document()
      const hints = events.map((event) => ({ ...event }))
      if (kind === 'missing-chunk') hints.pop()
      if (kind === 'wrong-text') hints[0].text = 'not accepted'
      if (kind === 'duplicate-id') hints[1].eventId = hints[0].eventId
      if (kind === 'already-applied') hints[0].eventId = 'initial'
      if (kind === 'negative-time') hints[0].timestamp = -1
      const after = continued(before)
      const records = diffSessionRecords(normalizeJournalValue(before), after, {
        textEvents: hints
      })
      expect(records.some((record) => record.type === 'assistant_text_received')).toBe(false)
      expect(replay(before, records)).toEqual(after)
    }
  )

  it.each([
    'new-message',
    'terminal',
    'scope',
    'non-text-field',
    'images',
    'normalized-prefix',
    'flat-divergence',
    'session-id'
  ])('keeps full entity fallback for %s', (kind) => {
    const before = document()
    const after = continued(before)
    if (kind === 'new-message') {
      before.session.messages = []
      before.session.conversationGraph.messages = []
    }
    if (kind === 'terminal') after.session.conversationGraph.messages[0].status = 'complete'
    if (kind === 'scope') after.session.conversationGraph.messages[0].runtimeSegmentId = 'different'
    if (kind === 'non-text-field') after.session.conversationGraph.messages[0].notes = 'changed'
    if (kind === 'images') {
      before.session.conversationGraph.messages[0].images = [{ id: 'image' }]
      after.session.conversationGraph.messages[0].images = [{ id: 'image' }]
    }
    if (kind === 'normalized-prefix')
      after.session.conversationGraph.messages[0].content = 'refusal normalized'
    if (kind === 'flat-divergence') after.session.messages[0].content += 'different'
    if (kind === 'session-id') after.session.id = 'different'
    const records = diffSessionRecords(normalizeJournalValue(before), after, { textEvents: events })
    expect(records.some((record) => record.type === 'assistant_text_received')).toBe(false)
    expect(replay(before, records)).toEqual(after)
  })

  it('updates a canonical message without creating a missing flat projection', () => {
    const before = document()
    before.session.messages = []
    const after = continued(before)
    const records = diffSessionRecords(normalizeJournalValue(before), after, { textEvents: events })
    expect(records.some((record) => record.type === 'assistant_text_received')).toBe(true)
    expect(replay(before, records)).toEqual(after)
  })

  it('freezes chunks and the reconstructed result against later caller mutation', () => {
    const before = document()
    const after = continued(before)
    const hints = events.map((event) => ({ ...event }))
    const records = diffSessionRecords(normalizeJournalValue(before), after, { textEvents: hints })
    hints[0].text = 'modified after preparation'
    const result = replay(before, records)
    expect(result).toEqual(after)
    expect(Object.isFrozen(records[1])).toBe(true)
    expect(Object.isFrozen(textRecord().chunks[0])).toBe(true)
    expect(Object.isFrozen((result as unknown as Document).session.messages[0].eventIds)).toBe(true)
  })

  it('rejects malformed text events and generic patch payloads', () => {
    const record = textRecord()
    for (const invalid of [
      { ...record, path: ['session', 'messages'] },
      { ...record, sessionId: '' },
      { ...record, chunks: [] },
      { ...record, chunks: [record.chunks[0], record.chunks[0]] },
      { ...record, chunks: [{ ...record.chunks[0], timestamp: -1 }] },
      { ...record, chunks: [{ ...record.chunks[0], text: '' }] },
      { ...record, chunks: [{ ...record.chunks[0], offset: 2 }] }
    ])
      expect(() => validateSessionRecords([invalid])).toThrow()
  })

  it.each([
    'session',
    'stream',
    'prompt',
    'frame',
    'branch',
    'segment',
    'terminal',
    'duplicate',
    'missing',
    'flat'
  ])('rejects a text record against conflicting %s authority', (kind) => {
    const before = document()
    const message = before.session.conversationGraph.messages[0]
    if (kind === 'session') before.session.id = 'other'
    if (kind === 'stream') message.streamId = 'other'
    if (kind === 'prompt') message.responseToMessageId = 'other'
    if (kind === 'frame') message.agentFrameId = 'other'
    if (kind === 'branch') message.introducedOnBranchId = 'other'
    if (kind === 'segment') message.runtimeSegmentId = 'other'
    if (kind === 'terminal') message.status = 'error'
    if (kind === 'duplicate') message.eventIds.push(events[0].eventId)
    if (kind === 'missing') before.session.conversationGraph.messages = []
    if (kind === 'flat') before.session.messages[0].content = 'divergent'
    expect(() => replay(before, [textRecord()])).toThrow()
  })
})
