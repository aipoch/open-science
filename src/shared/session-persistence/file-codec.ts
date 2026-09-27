import type { PersistedChatSession, MaterializedPersistedChatSession } from './session'
import {
  type PersistedSessionFile,
  SESSION_FILE_VERSION,
  type SessionFileReadOptions,
  type SessionFileDecodeResult,
  decodeSessionEnvelope
} from '../session-persistence-envelope'
import { materializeSessionConversationGraph } from '../session-conversation-graph-materialization'
import {
  type PersistedChatMessage,
  retainRecentSessionEventIds,
  type PersistedToolActivity
} from './message'
import { sanitizeSessionMessageImages } from './message-content'
import { asString, isRecord } from './primitives'
import { sanitizeSession } from './session-codec'
import type { RuntimeCodec } from '../application-command-contract'

// ---------------------------------------------------------------------------
// Per-session file storage (sessions/<projectId>/<sessionId>.json) + manifest.
// ---------------------------------------------------------------------------

// Wraps a session in the on-disk envelope written per file.
export const createSessionFile = (session: PersistedChatSession): PersistedSessionFile => {
  const materialized = materializeSessionConversationGraph(session)
  const compactMessage = <Message extends PersistedChatMessage>(message: Message): Message =>
    message.status === 'streaming'
      ? message
      : ({ ...message, eventIds: retainRecentSessionEventIds(message.eventIds) } as Message)
  const compactActivity = <Activity extends PersistedToolActivity>(activity: Activity): Activity =>
    activity.status === 'pending' || activity.status === 'in_progress'
      ? activity
      : ({ ...activity, eventIds: retainRecentSessionEventIds(activity.eventIds) } as Activity)
  const compacted: MaterializedPersistedChatSession = {
    ...materialized,
    messages: materialized.messages.map(compactMessage),
    activities: materialized.activities?.map(compactActivity),
    conversationGraph: {
      ...materialized.conversationGraph,
      messages: materialized.conversationGraph.messages.map(compactMessage),
      activities: materialized.conversationGraph.activities.map(compactActivity)
    }
  }
  return {
    version: SESSION_FILE_VERSION,
    session: sanitizeSessionMessageImages(compacted)
  }
}

export const decodeSessionFile = (
  value: unknown,
  options: SessionFileReadOptions = {}
): SessionFileDecodeResult => {
  const envelope = decodeSessionEnvelope(value)
  if (envelope.status !== 'ok') return envelope
  const rawSession = envelope.session

  // A persisted Session needs one authoritative conversation representation. The compatibility
  // message list may be absent or malformed only when a canonical graph can replace it; otherwise
  // accepting the file would turn deterministic structural corruption into a valid empty Session.
  if (rawSession.conversationGraph === undefined && !Array.isArray(rawSession.messages)) {
    return { status: 'invalid' }
  }

  const sessionId = asString(rawSession.id)
  const preserveRuntimeState =
    typeof options.preserveRuntimeState === 'function'
      ? sessionId !== undefined && options.preserveRuntimeState(sessionId)
      : options.preserveRuntimeState

  const session = sanitizeSession(rawSession, {
    preserveLegacyUploadPaths: options.preserveLegacyUploadPaths,
    preserveRuntimeState
  })
  return session ? { status: 'ok', session } : { status: 'invalid' }
}

// Compatibility projection for callers that only need a readable Session. Runtime recovery is
// skipped only when the main process confirms that the owning prompt is still active.
export const normalizeSessionFile = (
  value: unknown,
  options: SessionFileReadOptions = {}
): PersistedChatSession | undefined => {
  const decoded = decodeSessionFile(value, options)
  return decoded.status === 'ok' ? decoded.session : undefined
}

const matchesSanitizedProjection = (
  value: unknown,
  sanitized: unknown,
  allowMissingSanitizedFields = false
): boolean => {
  if (Object.is(value, sanitized)) return true
  if (Array.isArray(value)) {
    return (
      Array.isArray(sanitized) &&
      value.length === sanitized.length &&
      value.every((item, index) => matchesSanitizedProjection(item, sanitized[index]))
    )
  }
  if (!isRecord(value) || !isRecord(sanitized)) return false
  if (!allowMissingSanitizedFields && Object.keys(value).length !== Object.keys(sanitized).length) {
    return false
  }
  return Object.entries(value).every(
    ([key, item]) =>
      Object.hasOwn(sanitized, key) && matchesSanitizedProjection(item, sanitized[key])
  )
}

const hasRequiredSessionFields = (value: unknown): value is PersistedChatSession =>
  isRecord(value) &&
  Object.hasOwn(value, 'id') &&
  Object.hasOwn(value, 'projectId') &&
  Object.hasOwn(value, 'title') &&
  Object.hasOwn(value, 'cwd') &&
  Object.hasOwn(value, 'status') &&
  Object.hasOwn(value, 'messages') &&
  Object.hasOwn(value, 'createdAt') &&
  Object.hasOwn(value, 'updatedAt')

// The wire boundary uses the same recursive decoder as durable Session files, but preserves live
// runtime state instead of applying restart recovery. This keeps one source of truth for every
// nested message, graph, activity and runtime-context field while upgrading historical shapes.
export const persistedChatSessionCodec: RuntimeCodec<PersistedChatSession> = Object.freeze({
  parse: (value): PersistedChatSession => {
    const decoded = decodeSessionFile(value, {
      preserveLegacyUploadPaths: true,
      preserveRuntimeState: true
    })
    if (decoded.status !== 'ok' || decoded.session.projectId.length === 0) {
      throw new Error('Invalid Session payload.')
    }
    return hasRequiredSessionFields(value) &&
      matchesSanitizedProjection(value, decoded.session, true)
      ? value
      : decoded.session
  }
})
