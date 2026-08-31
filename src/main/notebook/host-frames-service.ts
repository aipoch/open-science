import { createHash } from 'node:crypto'

import {
  resolveMessageBranchPath,
  type PersistedAgentFrame,
  type PersistedConversationGraph,
  type PersistedMessageNode
} from '../../shared/conversation-graph'
import { sanitizeExportMarkdown } from '../../shared/conversation-export'
import { fuzzyScore } from '../../shared/fuzzy-match'
import type { PersistedArtifact, PersistedChatSession } from '../../shared/session-persistence'
import { isRecord } from '../value-guards'

type HostFrameReadContext = Readonly<{ projectId: string; sessionId: string }>

type HostFramesSessionDiagnostic =
  | { status: 'found'; session: PersistedChatSession }
  | { status: 'missing' }
  | { status: 'unreadable' }

type HostFramesRepository = {
  readProject(projectId: string): Promise<{
    sessions: PersistedChatSession[]
    isComplete: boolean
  }>
  readSession(projectId: string, sessionId: string): Promise<HostFramesSessionDiagnostic>
}

type HostFramesReferencedSessionResolver = (
  context: HostFrameReadContext,
  sessionId: string
) => Promise<{ projectId: string } | undefined>

type ArchivedFilter = 'exclude' | 'include' | 'only'

type NormalizedListOptions = {
  sessionId?: string
  rootsOnly: boolean
  kind?: 'root' | 'reviewer' | 'delegate' | 'compatibility'
  archived: ArchivedFilter
  search?: string
  afterMs?: number
  beforeMs?: number
  cursor?: string
  limit: number
}

type ListCursor = {
  version: 1
  queryKey: string
  snapshotKey: string
  offset: number
}

type TranscriptCursor = {
  version: 1
  projectId: string
  sessionId: string
  frameId: string
  branchId: string
  snapshotKey: string
  end: number
}

type NormalizedGetOptions = {
  sessionId?: string
  branchId?: string
  before?: string
  limit: number
}

type HostFrameProjection = {
  frame_id: string
  session_id: string
  session_title: string
  parent_frame_id?: string
  origin_message_id?: string
  kind: PersistedAgentFrame['kind']
  agent_name?: string
  delegate_name?: string
  linked_review_id?: string
  recorded_frame_status: PersistedAgentFrame['status']
  session_status: PersistedChatSession['status']
  created_at: string
  completed_at?: string
  session_updated_at: string
  archived_at?: string
  message_count: number
  child_count: number
}

const LIST_OPTION_KEYS = new Set([
  'session_id',
  'roots_only',
  'kind',
  'archived',
  'search',
  'after',
  'before',
  'limit',
  'cursor'
])
const FRAME_KINDS = new Set(['root', 'reviewer', 'delegate', 'compatibility'])
const ARCHIVED_FILTERS = new Set<ArchivedFilter>(['exclude', 'include', 'only'])
const DEFAULT_LIST_LIMIT = 20
const MAX_LIMIT = 100
const DEFAULT_GET_LIMIT = 40
const GET_OPTION_KEYS = new Set(['session_id', 'branch_id', 'before', 'limit'])

const optionalString = (
  options: Record<string, unknown>,
  key: string,
  maxLength = 256,
  prefix = 'host.frames'
): string | undefined => {
  const value = options[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(
      `${prefix} ${key} must be a non-empty string of at most ${maxLength} characters.`
    )
  }
  return value
}

const parseUtcTime = (value: string, key: 'after' | 'before'): number => {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value)
  const normalized = dateOnly ? `${value}T00:00:00.000Z` : value
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      normalized
    )
  ) {
    throw new Error(`host.frames.list ${key} must be a UTC date or ISO timestamp with an offset.`)
  }
  const calendarDate = normalized.slice(0, 10)
  const calendarTime = Date.parse(`${calendarDate}T00:00:00.000Z`)
  if (
    !Number.isFinite(calendarTime) ||
    new Date(calendarTime).toISOString().slice(0, 10) !== calendarDate
  ) {
    throw new Error(`host.frames.list ${key} is not a valid ${dateOnly ? 'UTC date' : 'time'}.`)
  }
  const parsed = Date.parse(normalized)
  if (!Number.isFinite(parsed)) throw new Error(`host.frames.list ${key} is not a valid time.`)
  return parsed
}

const normalizeListOptions = (value: unknown): NormalizedListOptions => {
  if (value === undefined) value = {}
  if (!isRecord(value)) throw new Error('host.frames.list options must be an object.')
  const unknown = Object.keys(value).find((key) => !LIST_OPTION_KEYS.has(key))
  if (unknown) throw new Error(`host.frames.list unknown option: ${unknown}`)

  const sessionId = optionalString(value, 'session_id', 512, 'host.frames.list')
  const search = optionalString(value, 'search', 256, 'host.frames.list')
  const after = optionalString(value, 'after', 64, 'host.frames.list')
  const before = optionalString(value, 'before', 64, 'host.frames.list')
  const cursor = optionalString(value, 'cursor', 4096, 'host.frames.list')
  const rootsOnly = value.roots_only === undefined ? true : value.roots_only
  if (typeof rootsOnly !== 'boolean') {
    throw new Error('host.frames.list roots_only must be a boolean.')
  }
  const kind = value.kind
  if (kind !== undefined && (typeof kind !== 'string' || !FRAME_KINDS.has(kind))) {
    throw new Error('host.frames.list kind is invalid.')
  }
  const archived = value.archived === undefined ? 'exclude' : value.archived
  if (typeof archived !== 'string' || !ARCHIVED_FILTERS.has(archived as ArchivedFilter)) {
    throw new Error('host.frames.list archived must be exclude, include, or only.')
  }
  const limit = value.limit === undefined ? DEFAULT_LIST_LIMIT : value.limit
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) {
    throw new Error(`host.frames.list limit must be an integer between 1 and ${MAX_LIMIT}.`)
  }
  const afterMs = after ? parseUtcTime(after, 'after') : undefined
  const beforeMs = before ? parseUtcTime(before, 'before') : undefined
  if (afterMs !== undefined && beforeMs !== undefined && afterMs >= beforeMs) {
    throw new Error('host.frames.list after must be earlier than before.')
  }
  return {
    sessionId,
    rootsOnly,
    kind: kind as NormalizedListOptions['kind'],
    archived: archived as ArchivedFilter,
    search,
    afterMs,
    beforeMs,
    cursor,
    limit: limit as number
  }
}

const normalizeGetOptions = (value: unknown): NormalizedGetOptions => {
  if (value === undefined) value = {}
  if (!isRecord(value)) throw new Error('host.frames.get options must be an object.')
  const unknown = Object.keys(value).find((key) => !GET_OPTION_KEYS.has(key))
  if (unknown) throw new Error(`host.frames.get unknown option: ${unknown}`)
  const sessionId = optionalString(value, 'session_id', 512, 'host.frames.get')
  const branchId = optionalString(value, 'branch_id', 512, 'host.frames.get')
  const before = optionalString(value, 'before', 4096, 'host.frames.get')
  const limit = value.limit === undefined ? DEFAULT_GET_LIMIT : value.limit
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_LIMIT) {
    throw new Error(`host.frames.get limit must be an integer between 1 and ${MAX_LIMIT}.`)
  }
  return { sessionId, branchId, before, limit: limit as number }
}

const toIso = (timestamp: number): string => new Date(timestamp).toISOString()

const encodeCursor = (cursor: ListCursor | TranscriptCursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')

const decodeListCursor = (value: string, queryKey: string): ListCursor => {
  let cursor: unknown
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('host.frames.list cursor is invalid.')
  }
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.queryKey !== queryKey ||
    typeof cursor.snapshotKey !== 'string' ||
    !Number.isInteger(cursor.offset) ||
    (cursor.offset as number) < 0
  ) {
    throw new Error('host.frames.list cursor does not match the requested filters.')
  }
  return cursor as ListCursor
}

const decodeTranscriptCursor = (
  value: string,
  binding: Pick<TranscriptCursor, 'projectId' | 'sessionId' | 'frameId' | 'branchId'>
): TranscriptCursor => {
  let cursor: unknown
  try {
    cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('host.frames.get cursor is invalid.')
  }
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.projectId !== binding.projectId ||
    cursor.sessionId !== binding.sessionId ||
    cursor.frameId !== binding.frameId ||
    cursor.branchId !== binding.branchId ||
    typeof cursor.snapshotKey !== 'string' ||
    !Number.isInteger(cursor.end) ||
    (cursor.end as number) < 0
  ) {
    throw new Error('host.frames.get cursor does not match the requested Frame and Branch.')
  }
  return cursor as TranscriptCursor
}

const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('base64url')

const compareOrdinal = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1

const toTurnUsage = (usage: NonNullable<PersistedMessageNode['turnUsage']>): unknown => ({
  input_tokens: usage.inputTokens,
  cache_tokens: usage.cacheTokens,
  ...(usage.cachedReadTokens === undefined ? {} : { cached_read_tokens: usage.cachedReadTokens }),
  ...(usage.cachedWriteTokens === undefined
    ? {}
    : { cached_write_tokens: usage.cachedWriteTokens }),
  output_tokens: usage.outputTokens,
  ...(usage.turnCount === undefined ? {} : { turn_count: usage.turnCount })
})

const displayName = (value: string | undefined): string | undefined =>
  value?.split(/[\\/]/u).filter(Boolean).at(-1) || undefined

const safeSize = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const toAttachments = (
  message: PersistedMessageNode,
  artifactsById: ReadonlyMap<string, PersistedArtifact>
): unknown[] => [
  ...(message.uploads ?? []).map((upload) => {
    const name = displayName(upload.originalName) ?? displayName(upload.name)
    const size = safeSize(upload.size)
    return {
      kind: 'upload',
      attachment_id: upload.id,
      ...(upload.versionId ? { version_id: upload.versionId } : {}),
      ...(name ? { name } : {}),
      ...(upload.mimeType ? { mime_type: upload.mimeType } : {}),
      ...(size === undefined ? {} : { size_bytes: size })
    }
  }),
  ...(message.artifactIds ?? []).flatMap((artifactId) => {
    const artifact = artifactsById.get(artifactId)
    if (!artifact) return []
    const name = displayName(artifact.name)
    const size = safeSize(artifact.size)
    return [
      {
        kind: 'artifact',
        attachment_id: artifact.id,
        ...(artifact.versionId ? { version_id: artifact.versionId } : {}),
        ...(name ? { name } : {}),
        ...(artifact.mimeType ? { mime_type: artifact.mimeType } : {}),
        ...(size === undefined ? {} : { size_bytes: size })
      }
    ]
  }),
  ...(message.images ?? []).map((image, index) => ({
    kind: 'image',
    attachment_id: image.id,
    name: `Image ${index + 1}`,
    mime_type: image.mimeType
  }))
]

const toMessage = (
  message: PersistedMessageNode,
  artifactsById: ReadonlyMap<string, PersistedArtifact>
): unknown => {
  const attachments = toAttachments(message, artifactsById)
  return {
    message_id: message.id,
    role: message.role,
    content: sanitizeExportMarkdown(message.content),
    status: message.status,
    ...(message.responseToMessageId ? { response_to_message_id: message.responseToMessageId } : {}),
    ...(message.runtimeSegmentId ? { runtime_segment_id: message.runtimeSegmentId } : {}),
    created_at: toIso(message.createdAt),
    updated_at: toIso(message.updatedAt),
    ...(message.completedAt === undefined ? {} : { completed_at: toIso(message.completedAt) }),
    ...(message.failedAt === undefined ? {} : { failed_at: toIso(message.failedAt) }),
    ...(message.turnUsage ? { turn_usage: toTurnUsage(message.turnUsage) } : {}),
    ...(attachments.length > 0 ? { attachments } : {})
  }
}

const frameProjection = (
  session: PersistedChatSession,
  graph: PersistedConversationGraph,
  frame: PersistedAgentFrame
): HostFrameProjection => ({
  frame_id: frame.id,
  session_id: session.id,
  session_title: session.title,
  ...(frame.parentFrameId ? { parent_frame_id: frame.parentFrameId } : {}),
  ...(frame.originMessageId ? { origin_message_id: frame.originMessageId } : {}),
  kind: frame.kind,
  ...(frame.agentName ? { agent_name: frame.agentName } : {}),
  ...(frame.delegateName ? { delegate_name: frame.delegateName } : {}),
  ...(frame.linkedReviewId ? { linked_review_id: frame.linkedReviewId } : {}),
  recorded_frame_status: frame.status,
  session_status: session.status,
  created_at: toIso(frame.createdAt),
  ...(frame.completedAt === undefined ? {} : { completed_at: toIso(frame.completedAt) }),
  session_updated_at: toIso(session.updatedAt),
  ...(session.archivedAt === undefined ? {} : { archived_at: toIso(session.archivedAt) }),
  message_count: resolveMessageBranchPath(graph, frame.activeBranchId).length,
  child_count: graph.frames.filter((candidate) => candidate.parentFrameId === frame.id).length
})

class HostFramesService {
  constructor(
    private readonly repository: HostFramesRepository,
    private readonly resolveReferencedSession?: HostFramesReferencedSessionResolver
  ) {}

  async list(options: unknown, context: HostFrameReadContext): Promise<unknown> {
    const normalized = normalizeListOptions(options)
    const target = normalized.sessionId
      ? await this.readNarrowedSession(context, normalized.sessionId)
      : {
          projectId: context.projectId,
          sessions: (await this.repository.readProject(context.projectId)).sessions
        }
    const frames = target.sessions.flatMap((session) => {
      if (
        (normalized.archived === 'exclude' && session.archivedAt !== undefined) ||
        (normalized.archived === 'only' && session.archivedAt === undefined)
      ) {
        return []
      }
      const graph = session.conversationGraph
      if (!graph) return []
      return graph.frames
        .filter((frame) => {
          if (normalized.rootsOnly && frame.parentFrameId) return false
          if (normalized.kind && frame.kind !== normalized.kind) return false
          if (normalized.afterMs !== undefined && frame.createdAt < normalized.afterMs) return false
          if (normalized.beforeMs !== undefined && frame.createdAt >= normalized.beforeMs)
            return false
          if (
            normalized.search &&
            ![session.title, frame.agentName, frame.delegateName].some(
              (value) => value && fuzzyScore(normalized.search!, value)
            )
          ) {
            return false
          }
          return true
        })
        .map((frame) => frameProjection(session, graph, frame))
    })
    frames.sort(
      (left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at) ||
        compareOrdinal(left.session_id, right.session_id) ||
        compareOrdinal(left.frame_id, right.frame_id)
    )
    const queryKey = JSON.stringify({
      projectId: target.projectId,
      sessionId: normalized.sessionId,
      rootsOnly: normalized.rootsOnly,
      kind: normalized.kind,
      archived: normalized.archived,
      search: normalized.search,
      afterMs: normalized.afterMs,
      beforeMs: normalized.beforeMs
    })
    const snapshotKey = fingerprint(frames)
    const cursor = normalized.cursor ? decodeListCursor(normalized.cursor, queryKey) : undefined
    if (cursor && cursor.snapshotKey !== snapshotKey) {
      throw new Error('host.frames.list cursor is no longer valid.')
    }
    const offset = cursor?.offset ?? 0
    if (offset > frames.length) throw new Error('host.frames.list cursor is no longer valid.')
    const page = frames.slice(offset, offset + normalized.limit)
    const nextOffset = offset + page.length
    return {
      project_id: target.projectId,
      total_count: frames.length,
      ...(nextOffset < frames.length
        ? {
            next_cursor: encodeCursor({
              version: 1,
              queryKey,
              snapshotKey,
              offset: nextOffset
            })
          }
        : {}),
      frames: page
    }
  }

  private async readNarrowedSession(
    context: HostFrameReadContext,
    sessionId: string
  ): Promise<{ projectId: string; sessions: PersistedChatSession[] }> {
    const diagnostic = await this.repository.readSession(context.projectId, sessionId)
    if (diagnostic.status === 'found') {
      return { projectId: context.projectId, sessions: [diagnostic.session] }
    }
    if (diagnostic.status === 'unreadable') {
      throw new Error(`Session is unreadable in the current Project: ${sessionId}`)
    }
    const referenced = await this.resolveReferencedSession?.(context, sessionId)
    if (!referenced || referenced.projectId === context.projectId) {
      return { projectId: context.projectId, sessions: [] }
    }
    const referencedDiagnostic = await this.repository.readSession(referenced.projectId, sessionId)
    if (referencedDiagnostic.status === 'unreadable') {
      throw new Error(`Referenced Session is unreadable: ${sessionId}`)
    }
    return {
      projectId: referenced.projectId,
      sessions: referencedDiagnostic.status === 'found' ? [referencedDiagnostic.session] : []
    }
  }

  async get(frameId: unknown, options: unknown, context: HostFrameReadContext): Promise<unknown> {
    if (typeof frameId !== 'string' || frameId.length === 0 || frameId.length > 512) {
      throw new Error(
        'host.frames.get frame_id must be a non-empty string of at most 512 characters.'
      )
    }
    const normalized = normalizeGetOptions(options)
    let target: { projectId: string; sessions: PersistedChatSession[] }
    if (normalized.sessionId) {
      target = await this.readNarrowedSession(context, normalized.sessionId)
    } else {
      const project = await this.repository.readProject(context.projectId)
      if (!project.isComplete) {
        throw new Error(
          'host.frames.get cannot complete because a current Project Session is unreadable.'
        )
      }
      target = { projectId: context.projectId, sessions: project.sessions }
    }
    const matches = target.sessions.flatMap((session) => {
      const graph = session.conversationGraph
      const frame = graph?.frames.find((candidate) => candidate.id === frameId)
      return graph && frame ? [{ session, graph, frame }] : []
    })
    if (matches.length > 1) {
      throw new Error(`Frame id is ambiguous in the current Project: ${frameId}`)
    }
    const match = matches[0]
    if (!match) throw new Error(`Frame not found in the current Project: ${frameId}`)
    const branchId = normalized.branchId ?? match.frame.activeBranchId
    const branch = match.graph.branches.find(
      (candidate) => candidate.id === branchId && candidate.agentFrameId === match.frame.id
    )
    if (!branch) throw new Error(`Frame Branch not found in the current Project: ${branchId}`)
    const path = resolveMessageBranchPath(match.graph, branch.id)
    const binding = {
      projectId: target.projectId,
      sessionId: match.session.id,
      frameId: match.frame.id,
      branchId: branch.id
    }
    const snapshotKey = fingerprint({
      branchUpdatedAt: branch.updatedAt,
      messages: path.map((message) => [
        message.id,
        message.updatedAt,
        message.status,
        message.content
      ])
    })
    const cursor = normalized.before
      ? decodeTranscriptCursor(normalized.before, binding)
      : undefined
    if (cursor && cursor.snapshotKey !== snapshotKey) {
      throw new Error('host.frames.get cursor is no longer valid.')
    }
    const end = cursor?.end ?? path.length
    if (end > path.length) throw new Error('host.frames.get cursor is no longer valid.')
    const start = Math.max(0, end - normalized.limit)
    const messages = path.slice(start, end)
    const artifactsById = new Map(
      (match.session.artifacts ?? []).map((artifact) => [artifact.id, artifact])
    )
    return {
      project_id: target.projectId,
      session: {
        session_id: match.session.id,
        session_title: match.session.title,
        session_status: match.session.status,
        created_at: toIso(match.session.createdAt),
        updated_at: toIso(match.session.updatedAt),
        ...(match.session.archivedAt === undefined
          ? {}
          : { archived_at: toIso(match.session.archivedAt) })
      },
      frame: frameProjection(match.session, match.graph, match.frame),
      branch: {
        branch_id: branch.id,
        created_at: toIso(branch.createdAt),
        updated_at: toIso(branch.updatedAt)
      },
      transcript: {
        messages: messages.map((message) => toMessage(message, artifactsById)),
        ...(start > 0
          ? {
              previous_cursor: encodeCursor({
                version: 1,
                ...binding,
                snapshotKey,
                end: start
              })
            }
          : {}),
        has_more_before: start > 0
      },
      runtime_segments: match.graph.runtimeSegments
        .filter((segment) => segment.agentFrameId === match.frame.id)
        .map((segment) => ({
          runtime_segment_id: segment.id,
          ...(segment.agentName ? { agent_name: segment.agentName } : {}),
          started_at: toIso(segment.startedAt),
          ...(segment.endedAt === undefined ? {} : { ended_at: toIso(segment.endedAt) })
        }))
    }
  }
}

export { HostFramesService }
export type { HostFrameReadContext, HostFramesRepository, HostFramesSessionDiagnostic }
