import { parseNestedDelegateInvocationId } from './delegated-caller-source'
import {
  createLinearConversationGraph,
  materializeNestedDelegateActivities,
  projectConversationMessage,
  resolveActiveConversationMessages,
  synchronizeActiveConversationActivities,
  synchronizeActiveConversationMessages,
  type PersistedConversationGraph
} from './conversation-graph'
import type {
  MaterializedPersistedChatSession,
  PersistedChatSession
} from './session-persistence/session'
import type { PersistedToolActivity } from './session-persistence/message'

export type ConversationGraphMaterializationPhase = 'create' | 'messages' | 'activities'

export class ConversationGraphMaterializationError extends Error {
  readonly phase: ConversationGraphMaterializationPhase
  override readonly cause: unknown

  constructor(phase: ConversationGraphMaterializationPhase, cause: unknown) {
    super('Conversation graph materialization failed.')
    this.name = 'ConversationGraphMaterializationError'
    this.phase = phase
    this.cause = cause
  }
}

const materializeGraphPhase = <Result>(
  phase: ConversationGraphMaterializationPhase,
  operation: () => Result
): Result => {
  try {
    return operation()
  } catch (error) {
    throw new ConversationGraphMaterializationError(phase, error)
  }
}

export const projectActiveNestedDelegateActivities = (
  graph: PersistedConversationGraph
): PersistedToolActivity[] => {
  const activeMessageIds = new Set(resolveActiveConversationMessages(graph).map(({ id }) => id))
  return graph.activities.flatMap(
    ({ agentFrameId, messageBranchId, runtimeSegmentId, ...activity }) => {
      void agentFrameId
      void messageBranchId
      void runtimeSegmentId
      return parseNestedDelegateInvocationId(activity.id) !== undefined &&
        activeMessageIds.has(activity.promptMessageId)
        ? [activity]
        : []
    }
  )
}

export const materializeSessionConversationGraph = (
  session: PersistedChatSession
): MaterializedPersistedChatSession => {
  const messageGraph = session.conversationGraph
    ? materializeGraphPhase('messages', () =>
        synchronizeActiveConversationMessages(
          session.conversationGraph!,
          session.messages,
          session.updatedAt
        )
      )
    : materializeGraphPhase('create', () =>
        createLinearConversationGraph({
          sessionId: session.id,
          messages: session.messages,
          frameworkId: session.agentFrameworkId,
          providerId: session.agentConfiguration?.providerId,
          backendId: session.agentBackendId,
          model: session.agentModel,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        })
      )
  const graph = materializeGraphPhase('activities', () =>
    materializeNestedDelegateActivities(
      synchronizeActiveConversationActivities(
        messageGraph,
        session.activities ?? [],
        session.activityGroups ?? []
      )
    )
  )
  const nestedDelegateActivities = projectActiveNestedDelegateActivities(graph)
  const activityIds = new Set((session.activities ?? []).map(({ id }) => id))
  return {
    ...session,
    conversationGraph: graph,
    messages: resolveActiveConversationMessages(graph).map(projectConversationMessage),
    activities: [
      ...(session.activities ?? []),
      ...nestedDelegateActivities.filter(({ id }) => !activityIds.has(id))
    ]
  }
}
