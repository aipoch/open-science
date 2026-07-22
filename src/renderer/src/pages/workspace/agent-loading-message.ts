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

// The loading row is derived UI state: it belongs to the active run, not persisted history. A
// permission wait is still mid-run (the turn resumes on the decision), so the row stays visible
// alongside the approval controls instead of leaving the transcript looking frozen.
const shouldShowAgentLoadingMessage = (session: ChatSession | undefined): boolean => {
  if (!session || !session.activeRun) return false
  if (session.status !== 'running' && session.status !== 'waiting-permission') return false

  const promptIndex = session.messages.findIndex(
    (message) => message.id === session.activeRun?.promptMessageId
  )

  if (promptIndex === -1) return false

  return !hasVisibleAgentMessageAfterPrompt(session, promptIndex)
}

export { shouldShowAgentLoadingMessage }
