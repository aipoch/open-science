import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SessionJournalStore,
  sessionJournalPath,
  type SessionJournalPreparedWrite,
  type SessionTextEvent
} from './journal'

const roots: string[] = []
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
}
type Document = {
  version: number
  session: {
    id: string
    projectId: string
    revision: number
    messages: Message[]
    conversationGraph: {
      messages: (Message & {
        agentFrameId: string
        introducedOnBranchId: string
        runtimeSegmentId: string
      })[]
    }
  }
}
const document = (): Document => {
  const message = {
    id: 'm',
    role: 'agent',
    status: 'streaming',
    streamId: 'stream',
    responseToMessageId: 'prompt',
    content: 'already saved '.repeat(1_000),
    eventIds: ['first'],
    createdAt: 1,
    updatedAt: 1
  }
  return {
    version: 2,
    session: {
      id: 's',
      projectId: 'p',
      revision: 1,
      messages: [message],
      conversationGraph: {
        messages: [
          {
            ...message,
            eventIds: [...message.eventIds],
            agentFrameId: 'f',
            introducedOnBranchId: 'b',
            runtimeSegmentId: 'r'
          }
        ]
      }
    }
  }
}
const next = (
  before: Document,
  eventId: string,
  text = '新 output 🚀'
): { after: Document; event: SessionTextEvent } => {
  const after = structuredClone(before)
  after.session.revision++
  const event: SessionTextEvent = {
    messageId: 'm',
    eventId,
    text,
    timestamp: after.session.revision
  }
  for (const message of [...after.session.messages, ...after.session.conversationGraph.messages]) {
    message.content += text
    message.eventIds.push(eventId)
    message.updatedAt = event.timestamp
  }
  return { after, event }
}
const store = (): SessionJournalStore => new SessionJournalStore({ maxBytes: 1024 * 1024 })
const fixture = async (): Promise<{ root: string; path: string; initial: Document }> => {
  const root = await mkdtemp(join(tmpdir(), 'session-text-events-'))
  roots.push(root)
  const path = join(root, 's.json')
  const initial = document()
  await store().write(path, { document: initial, expectedRevision: 0 })
  return { root, path, initial }
}
const prepare = async (
  owner: SessionJournalStore,
  path: string,
  before: Document,
  eventId: string
): Promise<{
  after: Document
  prepared: SessionJournalPreparedWrite
  request: { expectedRevision: number }
}> => {
  const { after, event } = next(before, eventId)
  const previous = (await owner.read(path))!
  const prepared = owner.prepareWrite(path, after, previous, { textEvents: [event] })
  return {
    after,
    prepared,
    request: { expectedRevision: before.session.revision }
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('durable accepted text events', () => {
  it('inspects a reference formed across a saved message and a later chunk', async () => {
    const { root } = await fixture()
    const path = join(root, 'joined.json')
    const initial = document()
    const reference = 'ac3dde96-c909-4a3c-9afa-6f90f264c9f4'
    for (const message of [
      ...initial.session.messages,
      ...initial.session.conversationGraph.messages
    ])
      message.content = reference.slice(0, 20)
    const owner = store()
    await owner.write(path, { document: initial, expectedRevision: 0 })
    const { after, event } = next(initial, 'continued', reference.slice(20))
    const prepared = owner.prepareWrite(path, after, (await owner.read(path))!, {
      textEvents: [event]
    })
    await owner.writePrepared(path, prepared, { expectedRevision: 1 })
    expect(await readFile(sessionJournalPath(path), 'utf8')).not.toContain(reference)
    const seen: unknown[] = []
    await owner.visitRetainedHistory(path, {
      maxBytes: 1024 * 1024,
      maxRecords: 100,
      visit: (value) => seen.push(value)
    })
    expect(seen).toContain(reference)
  })
  it('appends the actual received chunks once and restores both partial transcript views', async () => {
    const { path, initial } = await fixture()
    const owner = store()
    const update = await prepare(owner, path, initial, 'second')
    await owner.writePrepared(path, update.prepared, update.request)
    const lines = (await readFile(sessionJournalPath(path), 'utf8')).trimEnd().split('\n')
    const record = JSON.parse(lines[1])
    expect(record.type).toBe('session_update')
    expect(record.records.map((entry: { type: string }) => entry.type)).toEqual([
      'metadata',
      'assistant_text_received'
    ])
    expect(lines[1]).not.toContain('already saved')
    expect(lines[1].match(/新 output 🚀/g)).toHaveLength(1)
    expect((await store().read(path))?.document).toEqual(update.after)
    await appendFile(sessionJournalPath(path), '{"type":"session_update"')
    expect((await store().read(path))?.document).toEqual(update.after)
    const third = await prepare(store(), path, update.after, 'third')
    // Prepare/write capabilities remain owner-bound.
    const nextOwner = store()
    const next = await prepare(nextOwner, path, update.after, 'third')
    await nextOwner.writePrepared(path, next.prepared, next.request)
    expect((await store().read(path))?.document).toEqual(third.after)
  })
})
