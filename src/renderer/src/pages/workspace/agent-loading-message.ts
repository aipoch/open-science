import type { ChatSession } from '@/stores/session-store'
import { isActivityActive } from './workspace-conversation-items'

type TimelinePosition = {
  updatedAt: number
  sortIndex?: number
}

type AgentLoadingPhase = 'hidden' | 'thinking' | 'interacting-with-tools'

const isLaterThan = (candidate: TimelinePosition, reference: TimelinePosition): boolean => {
  if (candidate.updatedAt !== reference.updatedAt) return candidate.updatedAt > reference.updatedAt
  return (candidate.sortIndex ?? -1) > (reference.sortIndex ?? -1)
}

const findLatest = <T extends TimelinePosition>(items: T[]): T | undefined =>
  items.reduce<T | undefined>(
    (latest, item) => (!latest || isLaterThan(item, latest) ? item : latest),
    undefined
  )

// The transient row belongs to the active request, not persisted history. Text output owns the
// transcript, while tool activity and the silent gaps around it use their own indicator phases.
const getAgentLoadingPhase = (session: ChatSession | undefined): AgentLoadingPhase => {
  if (!session) return 'hidden'

  const hasLocalRun =
    Boolean(session.activeRun) &&
    (session.status === 'running' || session.status === 'waiting-permission')
  if (!hasLocalRun && !session.agentPromptInFlight) return 'hidden'

  const latestUserPromptId = session.messages.findLast((message) => message.role === 'user')?.id
  const promptMessageId = session.activeRun?.promptMessageId ?? latestUserPromptId
  const prompt = promptMessageId
    ? session.messages.find((message) => message.id === promptMessageId)
    : undefined
  const currentRunTools = (session.activities ?? []).filter((activity) => {
    if (!promptMessageId || !prompt) return false
    return activity.promptMessageId
      ? activity.promptMessageId === promptMessageId
      : isLaterThan(activity, prompt)
  })

  // Any live tool in the current request takes precedence over the surrounding thinking gaps.
  if (currentRunTools.some(isActivityActive)) return 'interacting-with-tools'
  if (session.status === 'waiting-permission') return 'interacting-with-tools'
  if (session.awaitingFirstAgentOutput) return 'thinking'
  if (!session.activeRun) return 'hidden'

  const promptIndex = session.messages.findIndex((message) => message.id === promptMessageId)

  if (promptIndex === -1) return 'hidden'

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

  if (!latestVisibleOutput) return 'thinking'

  const latestTool = findLatest(currentRunTools)

  return latestTool && isLaterThan(latestTool, latestVisibleOutput) ? 'thinking' : 'hidden'
}

export { getAgentLoadingPhase }
export type { AgentLoadingPhase }
