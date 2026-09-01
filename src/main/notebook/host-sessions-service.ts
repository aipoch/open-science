import { createHash } from 'node:crypto'

import type { AcpRuntimeEvent, AcpStateSnapshot } from '../../shared/acp'
import { resolveMessageBranchPath } from '../../shared/conversation-graph'
import { fuzzyScore } from '../../shared/fuzzy-match'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { isRecord } from '../value-guards'

type HostSessionReadContext = Readonly<{
  projectId: string
  sessionId: string
  callerRole: 'main' | 'delegate'
}>

type HostSessionsSessionDiagnostic =
  | { status: 'found'; session: PersistedChatSession }
  | { status: 'missing' }
  | { status: 'unreadable' }

type HostSessionsRepository = {
  readProject(projectId: string): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }>
  readSession(projectId: string, sessionId: string): Promise<HostSessionsSessionDiagnostic>
}

type HostSessionsRuntime = {
  getSnapshot(): AcpStateSnapshot | undefined
}

type HostSessionsReferencedSessionResolver = (
  context: HostSessionReadContext,
  sessionId: string
) => Promise<{ projectId: string } | undefined>

type ArchivedFilter = 'exclude' | 'include' | 'only'

type NormalizedListOptions = {
  archived: ArchivedFilter
  search?: string
  limit: number
  cursor?: string
}

type ListCursor = {
  version: 1
  queryKey: string
  snapshotKey: string
  offset: number
}

const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 100
const LIST_OPTION_KEYS = new Set(['archived', 'search', 'limit', 'cursor'])

const optionalString = (
  value: Record<string, unknown>,
  key: string,
  maxLength: number
): string | undefined => {
  const candidate = value[key]
  if (candidate === undefined) return undefined
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maxLength) {
    throw new Error(`host.sessions.list ${key} must be a non-empty string.`)
  }
  return candidate
}

const normalizeListOptions = (value: unknown): NormalizedListOptions => {
  if (value === undefined) value = {}
  if (!isRecord(value)) throw new Error('host.sessions.list options must be an object.')
  const unknown = Object.keys(value).find((key) => !LIST_OPTION_KEYS.has(key))
  if (unknown) throw new Error(`host.sessions.list unknown option: ${unknown}`)
  const archived = value.archived ?? 'exclude'
  if (!['exclude', 'include', 'only'].includes(archived as string)) {
    throw new Error('host.sessions.list archived must be exclude, include, or only.')
  }
  const search = optionalString(value, 'search', 256)
  const cursor = optionalString(value, 'cursor', 4096)
  const limit = value.limit ?? DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIST_LIMIT) {
    throw new Error(`host.sessions.list limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`)
  }
  return { archived: archived as ArchivedFilter, search, limit: limit as number, cursor }
}

const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url')

const encodeCursor = (cursor: ListCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

const decodeCursor = (value: string, queryKey: string): ListCursor => {
  let cursor: unknown
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('host.sessions.list cursor is invalid.')
  }
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.queryKey !== queryKey ||
    typeof cursor.snapshotKey !== 'string' ||
    !Number.isInteger(cursor.offset) ||
    (cursor.offset as number) < 0
  ) {
    throw new Error('host.sessions.list cursor does not match the requested filters.')
  }
  return cursor as ListCursor
}

const toIso = (timestamp: number): string => new Date(timestamp).toISOString()

const SAFE_OBSERVATION_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'running',
  'idle',
  'error',
  'waiting',
  'approved',
  'declined',
  'queued',
  'confirmed'
])

const safeObservationStatus = (value: string | undefined): string | undefined =>
  value && SAFE_OBSERVATION_STATUSES.has(value) ? value : undefined

const latestSessionEvent = (
  events: readonly AcpRuntimeEvent[],
  sessionId: string
): AcpRuntimeEvent | undefined => {
  let latest: AcpRuntimeEvent | undefined
  for (const event of events) {
    if (event.sessionId !== sessionId) continue
    if (!latest || event.timestamp >= latest.timestamp) latest = event
  }
  return latest
}

const activeConversation = (session: PersistedChatSession): unknown => {
  const graph = session.conversationGraph
  if (!graph) return undefined
  const frame = graph.frames.find((candidate) => candidate.id === graph.activeFrameId)
  if (!frame) return undefined
  const branch = graph.branches.find(
    (candidate) => candidate.id === frame.activeBranchId && candidate.agentFrameId === frame.id
  )
  if (!branch) return undefined
  return {
    frame_id: frame.id,
    branch_id: branch.id,
    message_count: resolveMessageBranchPath(graph, branch.id).length
  }
}

const sessionProjection = (
  session: PersistedChatSession,
  snapshot: AcpStateSnapshot | undefined
): unknown => {
  const sessionIds = snapshot?.sessionIds ?? []
  const promptInFlightSessionIds = snapshot?.promptInFlightSessionIds ?? []
  const agentPromptInFlightSessionIds = snapshot?.agentPromptInFlightSessionIds ?? []
  const event = latestSessionEvent(snapshot?.events ?? [], session.id)
  const observationStatus = safeObservationStatus(event?.status)
  const conversation = activeConversation(session)

  return {
    session_id: session.id,
    title: session.title,
    status: session.status,
    created_at: toIso(session.createdAt),
    updated_at: toIso(session.updatedAt),
    ...(session.archivedAt === undefined ? {} : { archived_at: toIso(session.archivedAt) }),
    ...(session.activeRun ? { active_run_started_at: toIso(session.activeRun.startedAt) } : {}),
    runtime: {
      attached: sessionIds.includes(session.id),
      ...(snapshot?.sessionConnectionStatuses?.[session.id]
        ? { connection_status: snapshot.sessionConnectionStatuses[session.id] }
        : {}),
      prompt_in_flight: promptInFlightSessionIds.includes(session.id),
      agent_prompt_in_flight: agentPromptInFlightSessionIds.includes(session.id),
      permission_pending:
        snapshot?.pendingPermissions.some((request) => request.sessionId === session.id) ?? false,
      user_input_pending:
        snapshot?.pendingElicitations?.some((request) => request.sessionId === session.id) ?? false
    },
    ...(conversation ? { active_conversation: conversation } : {}),
    ...(event
      ? {
          latest_observation: {
            timestamp: toIso(event.timestamp),
            kind: event.kind,
            level: event.level,
            ...(observationStatus ? { status: observationStatus } : {})
          }
        }
      : {})
  }
}

class HostSessionsService {
  constructor(
    private readonly repository: HostSessionsRepository,
    private readonly runtime: HostSessionsRuntime,
    private readonly resolveReferencedSession?: HostSessionsReferencedSessionResolver
  ) {}

  async list(options: unknown, context: HostSessionReadContext): Promise<unknown> {
    if (context.callerRole !== 'main') throw new Error('host.sessions is available to Main only.')
    const normalized = normalizeListOptions(options)

    const project = await this.repository.readProject(context.projectId)
    if (!project.isComplete) {
      throw new Error(
        'host.sessions.list cannot complete because a current Project Session is unreadable.'
      )
    }
    const sessions = project.sessions
      .filter((session) => {
        if (normalized.archived === 'exclude' && session.archivedAt !== undefined) return false
        if (normalized.archived === 'only' && session.archivedAt === undefined) return false
        if (
          normalized.search &&
          session.id !== normalized.search &&
          !fuzzyScore(normalized.search, session.title)
        ) {
          return false
        }
        return true
      })
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          (left.id === right.id ? 0 : left.id < right.id ? -1 : 1)
      )
    const snapshot = this.runtime.getSnapshot()
    const projections = sessions.map((session) => sessionProjection(session, snapshot))
    const queryKey = JSON.stringify({
      projectId: context.projectId,
      archived: normalized.archived,
      search: normalized.search
    })
    const snapshotKey = fingerprint(projections)
    const cursor = normalized.cursor ? decodeCursor(normalized.cursor, queryKey) : undefined
    if (cursor && cursor.snapshotKey !== snapshotKey) {
      throw new Error('host.sessions.list cursor is no longer valid.')
    }
    const offset = cursor?.offset ?? 0
    if (offset > projections.length) {
      throw new Error('host.sessions.list cursor is no longer valid.')
    }
    const page = projections.slice(offset, offset + normalized.limit)
    const nextOffset = offset + page.length
    return {
      total_count: projections.length,
      ...(nextOffset < projections.length
        ? {
            next_cursor: encodeCursor({
              version: 1,
              queryKey,
              snapshotKey,
              offset: nextOffset
            })
          }
        : {}),
      sessions: page
    }
  }

  async inspect(sessionId: unknown, context: HostSessionReadContext): Promise<unknown> {
    if (context.callerRole !== 'main') throw new Error('host.sessions is available to Main only.')
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
      throw new Error(
        'host.sessions.inspect session_id must be a non-empty string of at most 512 characters.'
      )
    }
    let diagnostic = await this.repository.readSession(context.projectId, sessionId)
    if (diagnostic.status === 'unreadable') {
      throw new Error(`Session is unreadable in the current Project: ${sessionId}`)
    }
    if (diagnostic.status === 'missing') {
      const referenced = await this.resolveReferencedSession?.(context, sessionId)
      if (referenced && referenced.projectId !== context.projectId) {
        diagnostic = await this.repository.readSession(referenced.projectId, sessionId)
      }
    }
    if (diagnostic.status === 'unreadable') {
      throw new Error(`Referenced Session is unreadable: ${sessionId}`)
    }
    if (diagnostic.status === 'missing') {
      throw new Error(`Session not found in the current Project: ${sessionId}`)
    }
    return sessionProjection(diagnostic.session, this.runtime.getSnapshot())
  }
}

export { HostSessionsService }
export type {
  HostSessionReadContext,
  HostSessionsRepository,
  HostSessionsRuntime,
  HostSessionsSessionDiagnostic
}
