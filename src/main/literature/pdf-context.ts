import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { MessagePdfContextSnapshot } from '../../shared/session-persistence'
import type { SessionCatalog } from '../session-persistence/coordinator'

// Resolve the persisted prompt on the active conversation, never a stale flat message list.
export const resolveCurrentPdfContext = async (
  sessions: Pick<SessionCatalog, 'loadSessionForContinuation'>,
  request: { projectId: string; sessionId: string; promptMessageId: string }
): Promise<MessagePdfContextSnapshot> => {
  const session = await sessions.loadSessionForContinuation(request.projectId, request.sessionId)
  const messages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  const message = messages.find(({ id }) => id === request.promptMessageId)
  const context = message?.role === 'user' ? message.pdfContext : undefined
  if (!context) {
    throw new Error(
      'NO_LINKED_PDF_CONTEXT: The current message has no linked PDF context snapshot.'
    )
  }
  return context
}
