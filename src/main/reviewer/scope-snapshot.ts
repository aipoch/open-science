import type { ReviewScopeSnapshotBlock, TurnScope } from '../../shared/reviewer'
import type { PersistedChatSession, PersistedToolActivity } from '../../shared/session-persistence'
import { resolveReviewTurnProjection } from './scope'

const extractToolContentText = (toolContent: unknown[] | undefined): string | undefined => {
  if (!Array.isArray(toolContent)) return undefined
  const text = toolContent.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    const nested =
      typeof record.content === 'object' && record.content !== null
        ? (record.content as Record<string, unknown>).text
        : undefined
    return typeof nested === 'string'
      ? [nested]
      : typeof record.text === 'string'
        ? [record.text]
        : []
  })
  return text.length > 0 ? text.join('\n') : undefined
}

const activityPayload = (activity: PersistedToolActivity): Record<string, unknown> => ({
  title: activity.title,
  status: activity.status,
  toolKind: activity.toolKind,
  rawInput: activity.rawInput,
  rawOutput: activity.rawOutput ?? extractToolContentText(activity.toolContent),
  terminalOutput: activity.terminalOutput,
  terminalExitCode: activity.terminalExitCode
})

const SECRET_KEY = /(authorization|cookie|credential|password|secret|token|api[_-]?key)/iu
const MAX_ARRAY_ENTRIES = 200
const MAX_OBJECT_ENTRIES = 200
const sanitizeText = (value: string): string => {
  if (/^data:[^;,]+;base64,/iu.test(value)) return '[omitted: embedded media]'
  if (value.length > 1_024 && /^[A-Za-z0-9+/\r\n]+={0,2}$/u.test(value)) {
    return '[omitted: encoded binary data]'
  }
  const withoutPaths = value
    .replace(/file:\/\/[^\s"'`]+/giu, '[path]')
    .replace(/(^|\s)\/(?:Users|home|private|tmp|var|etc|opt|workspace)\/[^\s"'`]+/gu, '$1[path]')
    .replace(/[A-Za-z]:\\[^\s"'`]+/gu, '[path]')
  return withoutPaths.length <= 64_000
    ? withoutPaths
    : `${withoutPaths.slice(0, 64_000)}\n…[truncated]`
}

const sanitizeValue = (value: unknown, depth = 0, key?: string): unknown => {
  if (depth > 12) return '[omitted: nesting limit]'
  if (key && SECRET_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') return sanitizeText(value)
  if (Array.isArray(value)) {
    const bounded = value
      .slice(0, MAX_ARRAY_ENTRIES)
      .map((entry) => sanitizeValue(entry, depth + 1))
    return value.length > MAX_ARRAY_ENTRIES
      ? [...bounded, `[omitted: ${value.length - MAX_ARRAY_ENTRIES} array entries]`]
      : bounded
  }
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value as Record<string, unknown>)
  const sanitized = Object.fromEntries(
    entries
      .slice(0, MAX_OBJECT_ENTRIES)
      .map(([key, entry]) => [key, sanitizeValue(entry, depth + 1, key)])
  )
  if (entries.length > MAX_OBJECT_ENTRIES) {
    sanitized.__omitted_entries__ = entries.length - MAX_OBJECT_ENTRIES
  }
  return sanitized
}

export const buildReviewScopeSnapshot = (
  session: PersistedChatSession,
  scope: TurnScope
): ReviewScopeSnapshotBlock[] => {
  const projection = resolveReviewTurnProjection(session, scope.turnMessageId)
  const messageMap = new Map(projection.messages.map((message) => [message.id, message]))
  const activityMap = new Map(projection.activities.map((activity) => [activity.id, activity]))

  return scope.blocks.map((block) => {
    const payload =
      block.kind === 'message'
        ? (() => {
            const message = messageMap.get(block.sourceId)
            return {
              role: message?.role,
              content: message?.content,
              artifactIds: message?.artifactIds
            }
          })()
        : (() => {
            const activity = activityMap.get(block.sourceId)
            return activity ? activityPayload(activity) : {}
          })()

    return {
      blockIndex: block.blockIndex,
      id: block.id,
      kind: block.kind,
      sourceId: block.sourceId,
      contentHash: block.contentHash,
      payload: sanitizeValue(payload) as Record<string, unknown>
    }
  })
}
