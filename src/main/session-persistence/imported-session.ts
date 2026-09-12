import {
  resolveActiveConversationMessages,
  projectConversationMessage
} from '../../shared/conversation-graph'
import { DEFAULT_PERMISSION_PROFILE } from '../../shared/permission-profiles'
import { isDeepStrictEqual } from 'node:util'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'

export const IMPORTED_SESSION_READ_ONLY = 'Imported research history is read-only.'

// Preserve JSON comparison semantics for persisted data without copying transcript strings into
// serialized buffers. Undefined object fields disappear; undefined array entries become null.
const comparisonValue = (value: unknown): unknown => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return undefined
  if (typeof value === 'bigint') throw new TypeError('Session data must be JSON serializable.')
  if (typeof value === 'number') return Number.isFinite(value) ? (value === 0 ? 0 : value) : null
  if (value === null || typeof value !== 'object') return value
  // Session fields are plain JSON; retain the previous behavior for Date-like values at ingress.
  if ('toJSON' in value && typeof value.toJSON === 'function')
    return comparisonValue(value.toJSON())
  if (Array.isArray(value)) return Array.from(value, (entry) => comparisonValue(entry) ?? null)
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const normalized = comparisonValue(entry)
      return normalized === undefined ? [] : [[key, normalized]]
    })
  )
}

// Browsing a branch and organizing a Session may update view preferences. Research content and
// execution authority remain immutable; source bytes are retained separately in the import receipt.
const research = (session: PersistedChatSession): unknown => {
  const { title, pinned, archivedAt, revision, updatedAt, filesRevision, ...value } =
    session.conversationGraph ? materializeSessionConversationGraph(session) : session
  void title
  void pinned
  void archivedAt
  void revision
  void updatedAt
  void filesRevision
  return comparisonValue({
    ...value,
    // Hydration makes these existing defaults explicit without changing research content.
    description: value.description ?? '',
    permissionProfile: value.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
    ...(value.conversationGraph
      ? {
          messages: undefined,
          activities: undefined,
          activityGroups: undefined,
          conversationGraph: {
            ...value.conversationGraph,
            activeFrameId: undefined,
            branches: value.conversationGraph.branches.map((branch) => ({
              ...branch,
              updatedAt: undefined
            })),
            frames: value.conversationGraph.frames.map((frame) => ({
              ...frame,
              activeBranchId: undefined
            }))
          }
        }
      : {})
  })
}

export const preserveImportedSession = (
  current: PersistedChatSession,
  candidate: PersistedChatSession
): PersistedChatSession => {
  if (!current.packageOrigin) return candidate
  const next = {
    ...candidate,
    packageOrigin: current.packageOrigin,
    // Renderer projections omit Main-owned runtime context; omission cannot erase it.
    ...(current.runtimeContext && candidate.runtimeContext === undefined
      ? { runtimeContext: current.runtimeContext }
      : {})
  }
  if (
    next.conversationGraph &&
    !isDeepStrictEqual(
      comparisonValue(next.messages),
      comparisonValue(
        resolveActiveConversationMessages(next.conversationGraph).map(projectConversationMessage)
      )
    )
  )
    throw new Error(IMPORTED_SESSION_READ_ONLY)
  if (!isDeepStrictEqual(research(current), research(next)))
    throw new Error(IMPORTED_SESSION_READ_ONLY)
  return next
}
