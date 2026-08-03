import type { ChatSession } from '@/stores/session-store'

type TimelinePosition = {
  updatedAt: number
  sortIndex?: number
}

const isLaterThan = (candidate: TimelinePosition, reference: TimelinePosition): boolean => {
  if (candidate.updatedAt !== reference.updatedAt) return candidate.updatedAt > reference.updatedAt
  return (candidate.sortIndex ?? -1) > (reference.sortIndex ?? -1)
}

const findLatest = <T extends TimelinePosition>(items: T[]): T | undefined =>
  items.reduce<T | undefined>(
    (latest, item) => (!latest || isLaterThan(item, latest) ? item : latest),
    undefined
  )

// The loading row belongs to the active run, not persisted history. Each tool starts a fresh wait
// phase: visible Agent output hides the row until a later tool leaves the Agent working again.
const shouldShowAgentLoadingMessage = (session: ChatSession | undefined): boolean => {
  if (session?.awaitingFirstAgentOutput) return true
  if (!session || !session.activeRun) return false
  if (session.status !== 'running' && session.status !== 'waiting-permission') return false

  const promptIndex = session.messages.findIndex(
    (message) => message.id === session.activeRun?.promptMessageId
  )

  if (promptIndex === -1) return false

  const prompt = session.messages[promptIndex]
  const promptMessageId = session.activeRun.promptMessageId
  const latestVisibleOutput = findLatest(
    session.messages
      .slice(promptIndex + 1)
      .filter(
        (message) =>
          message.role === 'agent' &&
          message.responseToMessageId === promptMessageId &&
          (message.content.trim().length > 0 || Boolean(message.images?.length))
      )
  )

  if (!latestVisibleOutput) return true

  const latestTool = findLatest(
    (session.activities ?? []).filter((activity) =>
      activity.promptMessageId
        ? activity.promptMessageId === promptMessageId
        : isLaterThan(activity, prompt)
    )
  )

  return Boolean(latestTool && isLaterThan(latestTool, latestVisibleOutput))
}

export { shouldShowAgentLoadingMessage }
