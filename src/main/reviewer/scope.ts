import { createHash } from 'node:crypto'

import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../shared/session-persistence'
import {
  projectConversationMessage,
  resolveMessageBranchPath
} from '../../shared/conversation-graph'
import type { ScopeBlock, TurnScope } from '../../shared/reviewer'

// One item in the flattened transcript: either a persisted message or a tool activity, tagged so the
// resolver can order and hash them uniformly. Mirrors the renderer's conversation-item projection.
type TurnItem =
  | {
      kind: 'message'
      sourceId: string
      createdAt: number
      sortIndex: number
      message: PersistedChatMessage
    }
  | {
      kind: 'activity'
      sourceId: string
      createdAt: number
      sortIndex: number
      activity: PersistedToolActivity
    }

// Recursively sorts object keys so equal content always serializes identically, giving stable hashes
// regardless of the key order the persistence layer happened to write.
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)

  return `{${entries.join(',')}}`
}

const hashContent = (value: unknown): string =>
  createHash('sha256').update(stableStringify(value)).digest('hex')

// Hashes only the durable, reviewer-relevant fields of a message so cosmetic/runtime churn does not
// invalidate a locator, while any change to what the agent actually said or produced does. When
// artifact digests are supplied, each referenced artifact's current content digest is folded in so an
// external edit to a generated file invalidates this block's hash (and any finding locator anchored to
// it) — the id alone never pinned the bytes. Messages with no artifacts keep their prior hash exactly,
// so existing locators stay valid across this change.
const hashMessage = (
  message: PersistedChatMessage,
  artifactDigests: ReadonlyMap<string, string>
): string => {
  const artifactIds = [...(message.artifactIds ?? [])].sort()

  return hashContent({
    role: message.role,
    content: message.content,
    artifactIds,
    ...(artifactIds.length > 0
      ? { artifactDigests: artifactIds.map((id) => artifactDigests.get(id) ?? null) }
      : {})
  })
}

// Hashes the execution record of a tool activity — the ground truth the reviewer compares claims against.
const hashActivity = (activity: PersistedToolActivity): string =>
  hashContent({
    title: activity.title,
    status: activity.status,
    providerToolName: activity.providerToolName,
    toolKind: activity.toolKind,
    toolContent: activity.toolContent,
    toolLocations: activity.toolLocations,
    rawInput: activity.rawInput,
    rawOutput: activity.rawOutput,
    terminalOutput: activity.terminalOutput,
    terminalExitCode: activity.terminalExitCode
  })

// Projects messages + activities into one list ordered exactly like the rendered transcript: by
// timestamp, then sortIndex, then id. Persisted messages carry no sortIndex, so (matching the renderer)
// they fall back to their array position.
export type ReviewTurnProjection = {
  messages: PersistedChatMessage[]
  activities: PersistedToolActivity[]
  agentFrameId?: string
  messageBranchId?: string
}

const projectBranchActivity = (
  activity: NonNullable<PersistedChatSession['conversationGraph']>['activities'][number]
): PersistedToolActivity => {
  const { agentFrameId, messageBranchId, promptMessageId, runtimeSegmentId, ...projected } =
    activity
  void agentFrameId
  void messageBranchId
  void promptMessageId
  void runtimeSegmentId
  return projected
}

// The Conversation Graph is authoritative when present. The flat arrays are only a compatibility
// projection and may briefly lag after a Branch switch, so audit scope must never read them first.
export const resolveReviewTurnProjection = (
  session: PersistedChatSession,
  turnMessageId: string
): ReviewTurnProjection => {
  const graph = session.conversationGraph
  if (!graph) {
    return { messages: session.messages, activities: session.activities ?? [] }
  }

  const target = graph.messages.find((message) => message.id === turnMessageId)
  const frame = target
    ? graph.frames.find((candidate) => candidate.id === target.agentFrameId)
    : undefined
  if (!target || !frame) return { messages: [], activities: [] }

  const path = resolveMessageBranchPath(graph, frame.activeBranchId)
  if (!path.some((message) => message.id === target.id)) return { messages: [], activities: [] }

  const messageIds = new Set(path.map((message) => message.id))
  return {
    messages: path.map(projectConversationMessage),
    activities: graph.activities
      .filter(
        (activity) => activity.agentFrameId === frame.id && messageIds.has(activity.promptMessageId)
      )
      .map(projectBranchActivity),
    agentFrameId: frame.id,
    messageBranchId: frame.activeBranchId
  }
}

const buildOrderedItems = (
  messages: PersistedChatMessage[],
  activities: PersistedToolActivity[]
): TurnItem[] => {
  const messageItems: TurnItem[] = messages.map((message, index) => ({
    kind: 'message',
    sourceId: message.id,
    createdAt: message.createdAt,
    sortIndex: index,
    message
  }))
  const activityItems: TurnItem[] = activities.map((activity) => ({
    kind: 'activity',
    sourceId: activity.id,
    createdAt: activity.createdAt,
    sortIndex: activity.sortIndex,
    activity
  }))

  return [...messageItems, ...activityItems].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    return left.sourceId.localeCompare(right.sourceId)
  })
}

const isUserMessage = (item: TurnItem): boolean =>
  item.kind === 'message' && item.message.role === 'user'

// Resolves the flattened, ordered blocks for the single turn that contains turnMessageId. A turn runs
// from a user message up to (but excluding) the next user message — the span the reviewer reads. Blocks
// from other turns are never included. An unknown id yields an empty scope so callers can no-op safely.
export const resolveTurnScope = (
  session: PersistedChatSession,
  turnMessageId: string,
  artifactDigests: ReadonlyMap<string, string> = new Map()
): TurnScope => {
  const projection = resolveReviewTurnProjection(session, turnMessageId)
  const items = buildOrderedItems(projection.messages, projection.activities)
  const targetIndex = items.findIndex((item) => item.sourceId === turnMessageId)

  if (targetIndex === -1) {
    return { turnMessageId, blocks: [], artifactVersionIds: [] }
  }

  // Turn start = nearest user message at or before the target; fall back to the list head if the target
  // precedes any user message (e.g. a leading agent preamble).
  let startIndex = targetIndex
  while (startIndex > 0 && !isUserMessage(items[startIndex])) startIndex -= 1
  if (!isUserMessage(items[startIndex])) startIndex = 0

  // Turn end = the next user message after the start, exclusive; or the end of the transcript.
  let endIndex = startIndex + 1
  while (endIndex < items.length && !isUserMessage(items[endIndex])) endIndex += 1

  const turnItems = items.slice(startIndex, endIndex)

  const blocks: ScopeBlock[] = turnItems.map((item, blockIndex) => ({
    id: `${item.kind}:${item.sourceId}`,
    kind: item.kind,
    sourceId: item.sourceId,
    blockIndex,
    contentHash:
      item.kind === 'message'
        ? hashMessage(item.message, artifactDigests)
        : hashActivity(item.activity)
  }))

  const artifactVersionIds: string[] = []
  const uploadVersionIds = new Set(
    turnItems.flatMap((item) =>
      item.kind === 'message'
        ? (item.message.uploads ?? []).flatMap((upload) =>
            upload.versionId ? [upload.versionId] : []
          )
        : []
    )
  )
  for (const item of turnItems) {
    if (item.kind !== 'message') continue
    for (const artifactId of item.message.artifactIds ?? []) {
      // Legacy/imported Sessions may duplicate Upload Version ids into artifactIds. Uploads are
      // immutable input evidence, not generated Artifact Versions exposed by read_artifact.
      if (uploadVersionIds.has(artifactId)) continue
      if (!artifactVersionIds.includes(artifactId)) artifactVersionIds.push(artifactId)
    }
  }

  return {
    turnMessageId,
    ...(projection.agentFrameId ? { agentFrameId: projection.agentFrameId } : {}),
    ...(projection.messageBranchId ? { messageBranchId: projection.messageBranchId } : {}),
    blocks,
    artifactVersionIds
  }
}

// Reports whether a stored review scope no longer matches the freshly-resolved scope for the same turn.
// A review is stale when any block it audited has since changed, disappeared, or was added — including
// an artifact edit, which changes its producing message block's content hash (the digest is folded in
// by resolveTurnScopeWithArtifactDigests). Used at load time so the UI can flag a review whose verdict
// no longer describes the current turn instead of presenting a stale "No issues found" as current.
export const isTurnScopeStale = (stored: TurnScope, current: TurnScope): boolean => {
  if (stored.agentFrameId && current.agentFrameId && stored.agentFrameId !== current.agentFrameId) {
    return true
  }
  if (
    stored.messageBranchId &&
    current.messageBranchId &&
    stored.messageBranchId !== current.messageBranchId
  ) {
    return true
  }
  const hashesOf = (scope: TurnScope): string =>
    scope.blocks.map((block) => `${block.sourceId}:${block.contentHash}`).join('\n')

  return hashesOf(stored) !== hashesOf(current)
}
