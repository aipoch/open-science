import { createHash } from 'node:crypto'

import type {
  PersistedChatMessage,
  PersistedChatSession,
  PersistedToolActivity
} from '../../shared/session-persistence'
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
const buildOrderedItems = (session: PersistedChatSession): TurnItem[] => {
  const messageItems: TurnItem[] = session.messages.map((message, index) => ({
    kind: 'message',
    sourceId: message.id,
    createdAt: message.createdAt,
    sortIndex: index,
    message
  }))
  const activityItems: TurnItem[] = (session.activities ?? []).map((activity) => ({
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
  const items = buildOrderedItems(session)
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
  for (const item of turnItems) {
    if (item.kind !== 'message') continue
    for (const artifactId of item.message.artifactIds ?? []) {
      if (!artifactVersionIds.includes(artifactId)) artifactVersionIds.push(artifactId)
    }
  }

  return { turnMessageId, blocks, artifactVersionIds }
}
