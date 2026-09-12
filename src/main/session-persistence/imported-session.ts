import {
  resolveActiveConversationMessages,
  projectConversationMessage
} from '../../shared/conversation-graph'
import { isDeepStrictEqual } from 'node:util'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'

export const IMPORTED_SESSION_READ_ONLY = 'Imported research history is read-only.'

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
  return JSON.parse(
    JSON.stringify({
      ...value,
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
  )
}

export const preserveImportedSession = (
  current: PersistedChatSession,
  candidate: PersistedChatSession
): PersistedChatSession => {
  if (!current.packageOrigin) return candidate
  const next = { ...candidate, packageOrigin: current.packageOrigin }
  if (
    next.conversationGraph &&
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(next.messages)),
      JSON.parse(
        JSON.stringify(
          resolveActiveConversationMessages(next.conversationGraph).map(projectConversationMessage)
        )
      )
    )
  )
    throw new Error(IMPORTED_SESSION_READ_ONLY)
  if (!isDeepStrictEqual(research(current), research(next)))
    throw new Error(IMPORTED_SESSION_READ_ONLY)
  return next
}
