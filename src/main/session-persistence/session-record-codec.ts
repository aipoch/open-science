import { isDeepStrictEqual } from 'node:util'
import {
  appendJournalArray,
  freezeParsedJournalValue,
  normalizeJournalValue,
  replaceJournalChild,
  SessionJournalCorruptionError,
  type JournalValue
} from './journal-codec'

// Names are a closed business vocabulary, never caller-selected JSON paths. Both transcript
// views remain in the existing v2 document until their public compatibility contract changes.
const COLLECTIONS = {
  messages: ['session', 'messages'],
  activities: ['session', 'activities'],
  activityGroups: ['session', 'activityGroups'],
  artifacts: ['session', 'artifacts'],
  graphMessages: ['graph', 'messages'],
  graphActivities: ['graph', 'activities'],
  graphActivityGroups: ['graph', 'activityGroups'],
  frames: ['graph', 'frames'],
  branches: ['graph', 'branches'],
  runtimeSegments: ['graph', 'runtimeSegments']
} as const

export type SessionRecordCollection = keyof typeof COLLECTIONS
export type SessionTextEvent = {
  readonly messageId: string
  readonly eventId: string
  readonly text: string
  readonly timestamp: number
}
export type SessionRecordChanges = {
  // Accepted runtime events, never text reconstructed by comparing two snapshots.
  readonly textEvents?: readonly SessionTextEvent[]
}
type ObjectValue = { readonly [key: string]: JournalValue }
type AssistantTextRecord = {
  readonly type: 'assistant_text_received'
  readonly sessionId: string
  readonly messageId: string
  readonly streamId: string
  readonly promptMessageId: string
  readonly agentFrameId: string
  readonly messageBranchId: string
  readonly runtimeSegmentId: string
  readonly chunks: readonly Omit<SessionTextEvent, 'messageId'>[]
}
export type SessionBusinessRecord =
  | {
      readonly type: 'metadata'
      readonly envelope: ObjectValue
      readonly session: ObjectValue
      readonly graph: ObjectValue | null
    }
  | {
      readonly type: 'entities'
      readonly collection: SessionRecordCollection
      readonly upserts: readonly ObjectValue[]
      // Omission preserves order; an array describes membership/order; null removes an optional
      // collection. Thus an absent activities field and an explicitly empty array stay distinct.
      readonly order?: readonly string[] | null
    }
  | { readonly type: 'snapshot'; readonly document: JournalValue }
  | AssistantTextRecord

const names = Object.keys(COLLECTIONS) as SessionRecordCollection[]
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (message: string): never => {
  throw new SessionJournalCorruptionError(message)
}
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const validChunks = (value: unknown): value is AssistantTextRecord['chunks'] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 100_000 &&
  value.every(
    (chunk) =>
      object(chunk) &&
      exact(chunk, ['eventId', 'text', 'timestamp']) &&
      id(chunk.eventId) &&
      id(chunk.text) &&
      timestamp(chunk.timestamp)
  ) &&
  new Set(value.map((chunk) => chunk.eventId)).size === value.length

// This is deliberately just one stable business transition, not the live runtime reducer:
// no provider normalization, graph routing, arbitrary fields, offsets or replacement operations.
const appendText = (
  message: Record<string, unknown>,
  record: AssistantTextRecord,
  canonical: boolean,
  retainMeasurements = false
): ObjectValue | undefined => {
  const previousIds = message.eventIds
  const existingIds = Array.isArray(previousIds) ? new Set(previousIds) : undefined
  if (
    message.id !== record.messageId ||
    message.role !== 'agent' ||
    message.status !== 'streaming' ||
    message.streamId !== record.streamId ||
    message.responseToMessageId !== record.promptMessageId ||
    typeof message.content !== 'string' ||
    !Array.isArray(previousIds) ||
    !previousIds.every(id) ||
    existingIds!.size !== previousIds.length ||
    !timestamp(message.updatedAt) ||
    ['uploads', 'images', 'annotations'].some(
      (key) =>
        message[key] !== undefined && (!Array.isArray(message[key]) || message[key].length > 0)
    ) ||
    (canonical &&
      (message.agentFrameId !== record.agentFrameId ||
        message.introducedOnBranchId !== record.messageBranchId ||
        message.runtimeSegmentId !== record.runtimeSegmentId))
  )
    return undefined
  if (record.chunks.some((chunk) => existingIds!.has(chunk.eventId))) return undefined
  const content = message.content + record.chunks.map((chunk) => chunk.text).join('')
  const receivedIds = record.chunks.map((chunk) => chunk.eventId)
  const updatedAt = record.chunks.reduce(
    (latest, chunk) => Math.max(latest, chunk.timestamp),
    message.updatedAt
  )
  if (retainMeasurements) {
    const ids = appendJournalArray(previousIds, receivedIds)
    const withText = replaceJournalChild(message as ObjectValue, 'content', content)
    const withIds = replaceJournalChild(withText, 'eventIds', ids)
    return replaceJournalChild(withIds, 'updatedAt', updatedAt) as ObjectValue
  }
  // Eligibility comparison constructs no measurement caches for this temporary candidate.
  return Object.freeze({
    ...(message as ObjectValue),
    content,
    eventIds: Object.freeze([...previousIds, ...receivedIds]),
    updatedAt
  })
}
const index = (values: unknown): Map<string, Record<string, unknown>> | undefined => {
  if (!Array.isArray(values)) return undefined
  const result = new Map<string, Record<string, unknown>>()
  for (const value of values) {
    if (!object(value) || !id(value.id) || result.has(value.id)) return undefined
    result.set(value.id, value)
  }
  return result
}
const without = (value: Record<string, unknown>, omitted: readonly string[]): ObjectValue =>
  normalizeJournalValue(
    Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)))
  ) as ObjectValue
type Parts = {
  metadata: Extract<SessionBusinessRecord, { type: 'metadata' }>
  collections: Partial<Record<SessionRecordCollection, Map<string, Record<string, unknown>>>>
}

const textRecords = (
  previous: Parts,
  next: Parts,
  events: SessionRecordChanges['textEvents']
): AssistantTextRecord[] => {
  const sessionId = previous.metadata.session.id
  if (!events?.length || !id(sessionId) || sessionId !== next.metadata.session.id) return []
  const batches = new Map<string, AssistantTextRecord['chunks'][number][]>()
  for (const event of events) {
    const batch = batches.get(event.messageId) ?? []
    batch.push({ eventId: event.eventId, text: event.text, timestamp: event.timestamp })
    batches.set(event.messageId, batch)
  }
  const result: AssistantTextRecord[] = []
  for (const [messageId, chunks] of batches) {
    const before = previous.collections.graphMessages?.get(messageId)
    const after = next.collections.graphMessages?.get(messageId)
    if (!before || !after || !validChunks(chunks)) continue
    const { streamId, responseToMessageId, agentFrameId, introducedOnBranchId, runtimeSegmentId } =
      before
    if (
      ![streamId, responseToMessageId, agentFrameId, introducedOnBranchId, runtimeSegmentId].every(
        id
      )
    )
      continue
    const record: AssistantTextRecord = {
      type: 'assistant_text_received',
      sessionId,
      messageId,
      streamId: streamId as string,
      promptMessageId: responseToMessageId as string,
      agentFrameId: agentFrameId as string,
      messageBranchId: introducedOnBranchId as string,
      runtimeSegmentId: runtimeSegmentId as string,
      chunks
    }
    const projected = appendText(before, record, true)
    if (!projected || !isDeepStrictEqual(projected, normalizeJournalValue(after))) continue
    const oldFlat = previous.collections.messages?.get(messageId)
    const newFlat = next.collections.messages?.get(messageId)
    if (Boolean(oldFlat) !== Boolean(newFlat)) continue
    if (oldFlat && newFlat) {
      const projectedFlat = appendText(oldFlat, record, false)
      if (
        oldFlat.content !== before.content ||
        oldFlat.updatedAt !== before.updatedAt ||
        !isDeepStrictEqual(oldFlat.eventIds, before.eventIds) ||
        !projectedFlat ||
        !isDeepStrictEqual(projectedFlat, normalizeJournalValue(newFlat))
      )
        continue
    }
    result.push(record)
  }
  return result
}
const partition = (document: unknown): Parts | undefined => {
  if (!object(document) || document.version !== 2 || !object(document.session)) return undefined
  const session = document.session
  const graph = session.conversationGraph
  if (graph !== undefined && !object(graph)) return undefined
  const collections: Parts['collections'] = {}
  for (const name of names) {
    const [scope, field] = COLLECTIONS[name]
    const owner = scope === 'session' ? session : graph
    const value = object(owner) ? owner[field] : undefined
    if (value === undefined) continue
    const entries = index(value)
    if (!entries) return undefined
    collections[name] = entries
  }
  if (!collections.messages && !object(graph)) return undefined
  return {
    metadata: {
      type: 'metadata',
      envelope: without(document, ['session']),
      session: without(session, [
        'conversationGraph',
        ...names
          .filter((name) => COLLECTIONS[name][0] === 'session')
          .map((name) => COLLECTIONS[name][1])
      ]),
      graph: object(graph)
        ? without(
            graph,
            names
              .filter((name) => COLLECTIONS[name][0] === 'graph')
              .map((name) => COLLECTIONS[name][1])
          )
        : null
    },
    collections
  }
}

// Reference-equal immutable entities skip comparison; changed entities are compared as complete
// normalized business values.
// Compatibility snapshot callers therefore still scan entity arrays, but never compute a tree
// patch or split text. Callers can preserve old immutable entity references on their hot path.
export const diffSessionRecords = (
  before: JournalValue,
  after: unknown,
  changes?: SessionRecordChanges
): readonly SessionBusinessRecord[] => {
  const previous = partition(before)
  const next = partition(after)
  if (!previous || !next)
    return validateSessionRecords([{ type: 'snapshot', document: normalizeJournalValue(after) }])
  const records: SessionBusinessRecord[] = []
  if (!isDeepStrictEqual(previous.metadata, next.metadata)) records.push(next.metadata)
  const received = textRecords(previous, next, changes?.textEvents)
  records.push(...received)
  const textMessageIds = new Set(received.map((record) => record.messageId))
  for (const name of names) {
    const oldValues = previous.collections[name]
    const newValues = next.collections[name]
    if (!oldValues && !newValues) continue
    if (!newValues) {
      // Removing the graph header already removes its collections.
      if (COLLECTIONS[name][0] === 'graph' && next.metadata.graph === null) continue
      records.push({ type: 'entities', collection: name, upserts: [], order: null })
      continue
    }
    const upserts: ObjectValue[] = []
    for (const [key, value] of newValues) {
      if ((name === 'messages' || name === 'graphMessages') && textMessageIds.has(key)) continue
      const previousValue = oldValues?.get(key)
      if (previousValue === value) continue
      const normalized = normalizeJournalValue(value) as ObjectValue
      if (!isDeepStrictEqual(previousValue, normalized)) upserts.push(normalized)
    }
    const oldOrder = oldValues && [...oldValues.keys()]
    const newOrder = [...newValues.keys()]
    const changedOrder = !oldOrder || !isDeepStrictEqual(oldOrder, newOrder)
    if (upserts.length || changedOrder)
      records.push({
        type: 'entities',
        collection: name,
        upserts,
        ...(changedOrder ? { order: newOrder } : {})
      })
  }
  return validateSessionRecords(records)
}

export const validateSessionRecords = (
  input: unknown,
  options?: { parsed: true }
): readonly SessionBusinessRecord[] => {
  if (!Array.isArray(input) || input.length > 100_000) return fail('Invalid Session record batch.')
  // Disk records already came from JSON.parse; freeze/validate them in place. Live callers
  // still normalize into owned copies so later caller mutations cannot change saved records.
  const records = (
    options?.parsed ? freezeParsedJournalValue(input, 100) : normalizeJournalValue(input, 0, 100)
  ) as readonly JournalValue[]
  for (const value of records) {
    if (!object(value)) return fail('Invalid Session business record.')
    if (value.type === 'assistant_text_received') {
      if (
        !exact(value, [
          'type',
          'sessionId',
          'messageId',
          'streamId',
          'promptMessageId',
          'agentFrameId',
          'messageBranchId',
          'runtimeSegmentId',
          'chunks'
        ]) ||
        ![
          'sessionId',
          'messageId',
          'streamId',
          'promptMessageId',
          'agentFrameId',
          'messageBranchId',
          'runtimeSegmentId'
        ].every((key) => id(value[key])) ||
        !validChunks(value.chunks)
      )
        return fail('Invalid assistant text event record.')
    } else if (value.type === 'snapshot') {
      if (!exact(value, ['type', 'document'])) return fail('Invalid Session snapshot record.')
    } else if (value.type === 'metadata') {
      if (
        !exact(value, ['type', 'envelope', 'session', 'graph']) ||
        !object(value.envelope) ||
        value.envelope.version !== 2 ||
        'session' in value.envelope ||
        !object(value.session) ||
        'conversationGraph' in value.session ||
        !(value.graph === null || object(value.graph)) ||
        names.some((name) => {
          const [scope, field] = COLLECTIONS[name]
          const owner = scope === 'session' ? value.session : value.graph
          return object(owner) && field in owner
        })
      )
        return fail('Invalid Session metadata record.')
    } else if (value.type === 'entities') {
      if (
        !exact(value, ['type', 'collection', 'upserts', ...('order' in value ? ['order'] : [])]) ||
        typeof value.collection !== 'string' ||
        !names.includes(value.collection as SessionRecordCollection) ||
        !index(value.upserts) ||
        ('order' in value &&
          value.order !== null &&
          (!Array.isArray(value.order) ||
            !value.order.every(id) ||
            new Set(value.order).size !== value.order.length)) ||
        (value.order === null && (value.upserts as unknown[]).length !== 0)
      )
        return fail('Invalid Session entity record.')
    } else return fail('Unknown Session business record type.')
  }
  return records as unknown as readonly SessionBusinessRecord[]
}

export const applySessionRecord = (
  document: JournalValue,
  record: SessionBusinessRecord,
  visitJoinedText?: (text: string) => void
): JournalValue => {
  if (record.type === 'snapshot') return record.document
  if (!object(document) || document.version !== 2 || !object(document.session))
    return fail('Session business records require a v2 Session document.')
  const session = document.session
  const graph = session.conversationGraph
  if (record.type === 'assistant_text_received') {
    if (session.id !== record.sessionId || !object(graph))
      return fail('Assistant text event has no matching Session graph.')
    const messages = index(graph.messages)
    const before = messages?.get(record.messageId)
    const projected = before && appendText(before, record, true, true)
    if (!messages || !before || !projected)
      return fail('Assistant text event does not match its streaming Message.')
    // Other after-images are present in the records. Only text can form a new reference
    // across updates; the compatibility message is required to have the same content.
    visitJoinedText?.(projected.content as string)
    const graphMessages = graph.messages as readonly JournalValue[]
    const nextMessages = replaceJournalChild(
      graphMessages,
      graphMessages.indexOf(before as ObjectValue),
      projected
    )
    const flat = session.messages === undefined ? undefined : index(session.messages)
    if (session.messages !== undefined && !flat)
      return fail('Assistant text event has an invalid compatibility projection.')
    const oldFlat = flat?.get(record.messageId)
    if (oldFlat) {
      const projectedFlat = appendText(oldFlat, record, false, true)
      if (
        oldFlat.content !== before.content ||
        oldFlat.updatedAt !== before.updatedAt ||
        !isDeepStrictEqual(oldFlat.eventIds, before.eventIds) ||
        !projectedFlat
      )
        return fail('Assistant text event has a conflicting compatibility Message.')
      const flatMessages = session.messages as readonly JournalValue[]
      const nextFlat = replaceJournalChild(
        flatMessages,
        flatMessages.indexOf(oldFlat as ObjectValue),
        projectedFlat
      )
      const nextGraph = replaceJournalChild(graph as ObjectValue, 'messages', nextMessages)
      const nextSession = replaceJournalChild(session as ObjectValue, 'messages', nextFlat)
      return replaceJournalChild(
        document,
        'session',
        replaceJournalChild(nextSession, 'conversationGraph', nextGraph)
      )
    }
    const nextGraph = replaceJournalChild(graph as ObjectValue, 'messages', nextMessages)
    return replaceJournalChild(
      document,
      'session',
      replaceJournalChild(session as ObjectValue, 'conversationGraph', nextGraph)
    )
  }
  if (record.type === 'metadata') {
    const retained = (scope: 'session' | 'graph', source: unknown): ObjectValue =>
      Object.freeze(
        Object.fromEntries(
          names.flatMap((name) => {
            const [owner, field] = COLLECTIONS[name]
            return owner === scope && object(source) && source[field] !== undefined
              ? [[field, source[field]]]
              : []
          })
        )
      ) as ObjectValue
    return Object.freeze({
      ...record.envelope,
      session: Object.freeze({
        ...record.session,
        ...retained('session', session),
        ...(record.graph === null
          ? {}
          : {
              conversationGraph: Object.freeze({
                ...record.graph,
                ...retained('graph', graph)
              })
            })
      })
    })
  }
  const [scope, field] = COLLECTIONS[record.collection]
  const owner = scope === 'session' ? session : graph
  if (!object(owner)) return fail('Session entity record has no graph owner.')
  const previous =
    owner[field] === undefined ? new Map<string, Record<string, unknown>>() : index(owner[field])
  if (!previous) return fail('Session entity collection has invalid or duplicate IDs.')
  const updated = { ...owner } as Record<string, JournalValue>
  if (record.order === null) delete updated[field]
  else {
    for (const value of record.upserts) {
      const key = value.id as string
      if (!previous.has(key) && record.order === undefined)
        return fail('New Session entity requires an explicit order.')
      previous.set(key, value)
    }
    const order = record.order ?? [...previous.keys()]
    const members = new Set(order)
    if (record.upserts.some((value) => !members.has(value.id as string)))
      return fail('Session upsert is absent from the final order.')
    updated[field] = Object.freeze(
      order.map((key) => {
        const value = previous.get(key)
        if (!value) return fail('Session entity order references a missing ID.')
        return value as ObjectValue
      })
    )
  }
  const nextSession =
    scope === 'session'
      ? Object.freeze(updated)
      : Object.freeze({
          ...session,
          conversationGraph: Object.freeze(updated)
        })
  return Object.freeze({ ...document, session: nextSession }) as JournalValue
}
