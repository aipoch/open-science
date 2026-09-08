import type { AcpPromptRequest } from '../../shared/acp'
import { getActiveConversationContext } from '../../shared/conversation-graph'
import {
  isAgentResultDeliveryAttribution,
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'

type PersistedDeliveryMessage = Readonly<{
  id: string
  role: 'user' | 'agent'
  status: string
  responseToMessageId?: string
  attribution?: unknown
}>

const buildAgentResultContinuationPrompt = (
  session: PersistedChatSession,
  request: Readonly<{ sessionId: string; text: string; continuationMessageId: string }>
): AcpPromptRequest => {
  const graph = materializeSessionConversationGraph(session).conversationGraph
  if (!graph) throw new Error('Background result continuation has no Conversation graph.')
  return {
    sessionId: request.sessionId,
    text: request.text,
    provenanceContext: getActiveConversationContext(graph, request.continuationMessageId)
  }
}

const hasSavedAgentResultContinuation = (
  messages: readonly PersistedDeliveryMessage[],
  request: Readonly<{ continuationMessageId: string; deliveryIds: readonly string[] }>
): boolean => {
  const prompt = messages.find(
    (message) =>
      message.role === 'user' &&
      message.id === request.continuationMessageId &&
      isAgentResultDeliveryAttribution(message.attribution)
  )
  if (!prompt || !isAgentResultDeliveryAttribution(prompt.attribution)) return false
  const attribution = prompt.attribution
  if (
    attribution.deliveryIds.length !== request.deliveryIds.length ||
    !request.deliveryIds.every((deliveryId) => attribution.deliveryIds.includes(deliveryId))
  )
    return false
  return messages.some(
    (message) =>
      message.role === 'agent' &&
      message.responseToMessageId === request.continuationMessageId &&
      message.status === 'complete'
  )
}

export { buildAgentResultContinuationPrompt, hasSavedAgentResultContinuation }
