import type { PersistedChatMessage } from './message'
import type { PersistedChatSession } from './session'

type TurnMessage = Pick<PersistedChatMessage, 'id' | 'role' | 'relayedFrom' | 'responseToMessageId'>

// A turn is anchored by the user message Main admitted as an independent prompt. Routed replies
// (steering, answered questions) carry responseToMessageId and stay inside their owning turn;
// advisory Side chat relays never own one. Hidden controls ARE anchors: callers must pick the
// latest anchor first and only then hide it, or a legacy outcome would migrate to an older turn.
export const isTurnAnchor = (
  message: Pick<TurnMessage, 'role' | 'relayedFrom' | 'responseToMessageId'>
): boolean => message.role === 'user' && !message.relayedFrom && !message.responseToMessageId

export const latestTurnAnchor = <T extends TurnMessage>(messages: readonly T[]): T | undefined =>
  messages.findLast(isTurnAnchor)

const endsTurnInterval = (message: TurnMessage): boolean =>
  message.role === 'user' && (Boolean(message.relayedFrom) || !message.responseToMessageId)

// Messages owned by an anchor's interval: everything after it up to the next user message that is
// not one of its routed replies. A relay or later prompt ends the interval; a reply does not.
export const turnAnchorInterval = <T extends TurnMessage>(
  messages: readonly T[],
  anchorId: string
): T[] => {
  const anchorIndex = messages.findIndex(({ id }) => id === anchorId)
  if (anchorIndex < 0) return []
  const interval: T[] = []
  for (const message of messages.slice(anchorIndex + 1)) {
    if (endsTurnInterval(message)) break
    interval.push(message)
  }
  return interval
}

// True when the message is the latest anchor or one of its routed replies.
export const isInLatestTurn = <T extends TurnMessage>(
  messages: readonly T[],
  messageId: string
): boolean => {
  const anchor = latestTurnAnchor(messages)
  return (
    anchor !== undefined &&
    (anchor.id === messageId ||
      turnAnchorInterval(messages, anchor.id).some(({ id }) => id === messageId))
  )
}

// A fork's turns up to its head are history copied from another Session. The head can be a hidden
// control, so ownership is "at or before the head", never "equals the last visible message".
// With a Conversation Graph the head's ancestry decides: an edit can move the active path off the
// head, and the edited prompt is a new turn. Forks without a recorded head keep live semantics.
export const isInheritedForkTurn = (
  session: Pick<PersistedChatSession, 'forkHeadMessageId' | 'messages' | 'conversationGraph'>,
  promptMessageId: string
): boolean => {
  const headId = session.forkHeadMessageId
  if (!headId) return false
  const graphMessages = session.conversationGraph?.messages
  if (graphMessages) {
    const parentById = new Map(
      graphMessages.map(({ id, parentMessageId }) => [id, parentMessageId] as const)
    )
    const seen = new Set<string>()
    for (
      let currentId: string | undefined = parentById.has(headId) ? headId : undefined;
      currentId && !seen.has(currentId);
      currentId = parentById.get(currentId)
    ) {
      if (currentId === promptMessageId) return true
      seen.add(currentId)
    }
    return false
  }
  const headIndex = session.messages.findIndex(({ id }) => id === headId)
  const promptIndex = session.messages.findIndex(({ id }) => id === promptMessageId)
  return headIndex >= 0 && promptIndex >= 0 && promptIndex <= headIndex
}
