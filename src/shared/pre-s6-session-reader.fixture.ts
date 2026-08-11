import type { PersistedMessageNode } from './conversation-graph'
import type { PersistedChatMessage, PersistedChatSession } from './session-persistence'

/**
 * Project-owned behavioral snapshot of the fc3f4151 reader/save boundary. That reader rebuilt
 * every Message from its strict allowlist and therefore discarded unknown Message fields while
 * preserving the unchanged Session, Graph, and delegated-runtime envelopes.
 *
 * Keep this independent from normalizeSessionFile: using the current reader here would let a
 * future schema change silently rewrite the rollback evidence it is meant to freeze.
 */
const preS6ReaderSave = (input: PersistedChatSession): PersistedChatSession => {
  if (input.conversationGraph && input.conversationGraph.schemaVersion !== 1) {
    throw new Error('Pre-S6 reader rejected the Session fixture.')
  }

  const legacyMessage = <Message extends PersistedChatMessage | PersistedMessageNode>(
    message: Message
  ): Message => {
    const saved = structuredClone(message)
    delete saved.structuredOutputEvidence
    delete saved.structuredOutputEvidenceInvalid
    return saved
  }

  return {
    ...structuredClone(input),
    messages: input.messages.map(legacyMessage),
    ...(input.conversationGraph
      ? {
          conversationGraph: {
            ...structuredClone(input.conversationGraph),
            messages: input.conversationGraph.messages.map(legacyMessage)
          }
        }
      : {})
  }
}

export { preS6ReaderSave }
