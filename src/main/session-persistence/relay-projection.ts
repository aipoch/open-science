import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'

const mergeRelay = (
  authoritative: PersistedChatMessage,
  submitted: PersistedChatMessage | undefined
): PersistedChatMessage => ({
  ...authoritative,
  eventIds: [...new Set([...authoritative.eventIds, ...(submitted?.eventIds ?? [])])]
})

// Main owns delivered Side chat relay content and identity, while Renderer owns append-only delivery
// evidence and the active Branch projection. Preserve both without reviving an inactive relay in the
// flat compatibility transcript after an edit or Branch switch.
export const mergeMainOwnedRelayProjection = (
  submitted: PersistedChatSession,
  authoritative: PersistedChatSession | undefined
): Pick<PersistedChatSession, 'messages' | 'conversationGraph'> => {
  const relays =
    authoritative?.messages.filter(
      (message) =>
        message.relayedFrom?.kind === 'side-chat' && message.relayedFrom.direction === 'to-main'
    ) ?? []
  if (relays.length === 0) {
    return { messages: [...submitted.messages], conversationGraph: submitted.conversationGraph }
  }

  const relaysById = new Map(relays.map((message) => [message.id, message]))
  const graph = submitted.conversationGraph
  const graphMessagesById = new Map(graph?.messages.map((message) => [message.id, message]) ?? [])
  const activeMessageIds = graph
    ? new Set(resolveActiveConversationMessages(graph).map((message) => message.id))
    : undefined
  const submittedMessagesById = new Map(submitted.messages.map((message) => [message.id, message]))
  const messages = [
    ...submitted.messages.filter((message) => !relaysById.has(message.id)),
    ...relays.flatMap((relay) =>
      graphMessagesById.has(relay.id) && !activeMessageIds?.has(relay.id)
        ? []
        : [mergeRelay(relay, submittedMessagesById.get(relay.id))]
    )
  ]
  const conversationGraph = graph
    ? {
        ...graph,
        messages: graph.messages.map((message) => {
          const relay = relaysById.get(message.id)
          return relay ? { ...message, ...mergeRelay(relay, message) } : message
        })
      }
    : undefined
  return { messages, conversationGraph }
}
