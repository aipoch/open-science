import type { ChatSession } from '@/stores/session-store'

const hasVisibleAgentMessageAfterPrompt = (session: ChatSession, promptIndex: number): boolean =>
  session.messages
    .slice(promptIndex + 1)
    .some(
      (message) =>
        message.role === 'agent' &&
        message.responseToMessageId === session.activeRun?.promptMessageId &&
        (message.content.trim().length > 0 || Boolean(message.images?.length))
    )

// The loading row is derived UI state: it belongs to the active run, not persisted history.
const shouldShowAgentLoadingMessage = (session: ChatSession | undefined): boolean => {
  if (!session || session.status !== 'running' || !session.activeRun) return false

  const promptIndex = session.messages.findIndex(
    (message) => message.id === session.activeRun?.promptMessageId
  )

  if (promptIndex === -1) return false

  return !hasVisibleAgentMessageAfterPrompt(session, promptIndex)
}

export { shouldShowAgentLoadingMessage }
