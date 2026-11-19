import { describe, expect, it } from 'vitest'
import { normalizeJournalValue, type JournalValue } from './journal-codec'
import {
  applySessionRecord,
  diffSessionRecords,
  validateSessionRecords,
  type SessionBusinessRecord
} from './session-record-codec'

const replay = (before: JournalValue, records: readonly SessionBusinessRecord[]): JournalValue =>
  records.reduce(applySessionRecord, before)
type TestEntity = { id: string; content?: string; changed?: string }
type TestDocument = {
  extraEnvelopeField?: string
  session: {
    revision: number
    messages: TestEntity[]
    activities?: { id: string; rawOutput: { text: string } }[]
    activityGroups?: TestEntity[]
    artifacts?: { id: string; name: string }[]
    newMetadata?: { value: string }
    conversationGraph?: Record<
      'messages' | 'activities' | 'activityGroups' | 'frames' | 'branches' | 'runtimeSegments',
      TestEntity[]
    >
  }
}
const fixtureValue = (value: unknown): TestDocument => value as TestDocument
const document = (): JournalValue =>
  normalizeJournalValue({
    version: 2,
    session: {
      id: 's',
      projectId: 'p',
      revision: 1,
      title: 'Before',
      messages: [
        { id: 'old', content: 'untouched historical body' },
        { id: 'active', content: 'hello' }
      ],
      activities: [{ id: 'tool', rawOutput: { text: 'old tool result' } }],
      conversationGraph: {
        schemaVersion: 1,
        rootFrameId: 'f',
        activeFrameId: 'f',
        messages: [
          { id: 'old', content: 'untouched historical body' },
          { id: 'active', content: 'hello' }
        ],
        activities: [{ id: 'tool', rawOutput: { text: 'old tool result' } }],
        activityGroups: [{ id: 'g', activityIds: ['tool'] }],
        frames: [{ id: 'f', activeBranchId: 'b' }],
        branches: [{ id: 'b', headMessageId: 'active' }],
        runtimeSegments: [{ id: 'segment' }]
      }
    }
  })

describe('Session business records', () => {
  it('validates parsed records in place while keeping live caller records isolated', () => {
    const before = document()
    const after = fixtureValue(structuredClone(before))
    after.session.revision = 2
    after.session.messages[1].content = 'continued 汉字😀'
    const raw = JSON.stringify(diffSessionRecords(before, after))
    const parsed = JSON.parse(raw)
    const records = validateSessionRecords(parsed, { parsed: true })
    expect(records).toBe(parsed)
    expect(Object.isFrozen(records)).toBe(true)
    expect(replay(before, records)).toEqual(after)

    const live = JSON.parse(raw)
    const isolated = validateSessionRecords(live)
    live[0].session.revision = 999
    expect(replay(before, isolated)).toEqual(after)
    expect(() => {
      parsed[0].session.revision = 999
    }).toThrow()
  })

  it('retains schema, number and nesting limits for parsed records', () => {
    for (const source of [
      '[{"type":"unknown"}]',
      '[{"type":"snapshot","document":1e400}]',
      '[{"type":"snapshot","document":' + '['.repeat(101) + '0' + ']'.repeat(101) + '}]'
    ]) {
      expect(() => validateSessionRecords(JSON.parse(source), { parsed: true })).toThrow()
    }
  })

  it('writes whole changed message/tool records and leaves unrelated historical content out', () => {
    const before = document()
    const after = fixtureValue(structuredClone(before))
    after.session.revision = 2
    after.session.messages[1].content = 'hello full new body'
    after.session.conversationGraph!.messages[1].content = 'hello full new body'
    after.session.activities![0].rawOutput.text = 'full new tool result'
    const records = diffSessionRecords(before, after)
    expect(replay(before, records)).toEqual(after)
    expect(JSON.stringify(records)).not.toContain('untouched historical body')
    expect(records).toContainEqual({
      type: 'entities',
      collection: 'messages',
      upserts: [after.session.messages[1]]
    })
    expect(records).toContainEqual({
      type: 'entities',
      collection: 'activities',
      upserts: [after.session.activities![0]]
    })
    expect(records.every((record) => !('path' in record))).toBe(true)
    expect(fixtureValue(replay(before, records)).session.messages[0]).toBe(
      fixtureValue(before).session.messages[0]
    )
  })

  it('preserves additions, deletions, ordering and absent versus empty collections', () => {
    const before = document()
    const after = fixtureValue(structuredClone(before))
    after.session.revision = 2
    after.session.messages = [{ id: 'new', content: 'new' }, after.session.messages[1]]
    delete after.session.activities
    after.session.activityGroups = []
    after.session.artifacts = [{ id: 'artifact', name: 'result.txt' }]
    const records = diffSessionRecords(before, after)
    expect(replay(before, records)).toEqual(after)
    expect(records).toContainEqual({
      type: 'entities',
      collection: 'messages',
      upserts: [{ id: 'new', content: 'new' }],
      order: ['new', 'active']
    })
    expect(records).toContainEqual({
      type: 'entities',
      collection: 'activities',
      upserts: [],
      order: null
    })
    expect(records).toContainEqual({
      type: 'entities',
      collection: 'activityGroups',
      upserts: [],
      order: []
    })
  })

  it('preserves every graph entity and metadata with graph creation and removal', () => {
    const full = document()
    const plain = fixtureValue(structuredClone(full))
    delete plain.session.conversationGraph
    for (const [before, after] of [
      [normalizeJournalValue(plain), full],
      [full, plain]
    ])
      expect(
        replay(before as JournalValue, diffSessionRecords(before as JournalValue, after))
      ).toEqual(after)
    const after = fixtureValue(structuredClone(full))
    after.extraEnvelopeField = 'retained'
    after.session.revision = 2
    after.session.newMetadata = { value: 'kept' }
    for (const key of [
      'messages',
      'activities',
      'activityGroups',
      'frames',
      'branches',
      'runtimeSegments'
    ] as const)
      after.session.conversationGraph![key][0].changed = key
    expect(replay(full, diffSessionRecords(full, after))).toEqual(after)
  })

  it('retains historical edits and freezes prepared values against later mutation', () => {
    const before = document()
    const after = fixtureValue(structuredClone(before))
    after.session.messages[0].content = 'historical edit'
    const expected = structuredClone(after)
    const records = diffSessionRecords(before, after)
    after.session.messages[0].content = 'late mutation'
    expect(replay(before, records)).toEqual(expected)
    expect(Object.isFrozen(records)).toBe(true)
    expect(Object.isFrozen(records.find((record) => record.type === 'entities')!.upserts[0])).toBe(
      true
    )
  })

  it('uses complete snapshot fallback for generic values and collections without unique IDs', () => {
    for (const after of [
      { revision: 2, content: 'generic' },
      { version: 2, session: { messages: [{ id: 'same' }, { id: 'same' }] } }
    ]) {
      const records = diffSessionRecords(document(), after)
      expect(records).toEqual([{ type: 'snapshot', document: after }])
      expect(replay(document(), records)).toEqual(after)
    }
  })

  it('preserves an explicitly empty graph and unknown metadata without inventing collections', () => {
    const before = normalizeJournalValue({ version: 2, session: { messages: [] } })
    const emptyGraph = {
      version: 2,
      envelopeExtension: true,
      session: { messages: [], conversationGraph: {} }
    }
    const withGraph = replay(before, diffSessionRecords(before, emptyGraph))
    expect(withGraph).toEqual(emptyGraph)
    const withMetadata = { ...emptyGraph, session: { ...emptyGraph.session, title: 'renamed' } }
    const records = diffSessionRecords(withGraph, withMetadata)
    expect(records.map((record) => record.type)).toEqual(['metadata'])
    expect(replay(withGraph, records)).toEqual(withMetadata)
    expect(replay(withGraph, diffSessionRecords(withGraph, before))).toEqual(before)
  })

  it.each([
    { type: 'text', path: ['session'], text: 'bad' },
    { type: 'entities', collection: '__proto__', upserts: [] },
    { type: 'entities', collection: 'messages', upserts: [{ id: 'a' }, { id: 'a' }] },
    { type: 'entities', collection: 'messages', upserts: [], order: ['a', 'a'] },
    { type: 'entities', collection: 'messages', upserts: [{ id: 'a' }], order: null },
    { type: 'metadata', envelope: { version: 2 }, session: { messages: [] }, graph: null }
  ])('rejects invalid or field-patch record %j', (record) => {
    expect(() => validateSessionRecords([record])).toThrow()
  })

  it('rejects missing IDs, unannounced additions and discarded upserts during replay', () => {
    for (const record of [
      { type: 'entities', collection: 'messages', upserts: [], order: ['missing'] },
      { type: 'entities', collection: 'messages', upserts: [{ id: 'new' }] },
      { type: 'entities', collection: 'messages', upserts: [{ id: 'new' }], order: ['old'] }
    ])
      expect(() => replay(document(), validateSessionRecords([record]))).toThrow()
  })
})
