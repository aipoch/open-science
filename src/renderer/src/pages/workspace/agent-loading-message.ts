import {
  projectSessionActionability,
  type ChatMessage,
  type ChatSession,
  type ToolActivity
} from '@/stores/session-store'

type TimelinePosition = {
  updatedAt: number
  sortIndex?: number
}

type AgentLoadingPhase =
  'hidden' | 'thinking' | 'interacting-with-tools' | 'waiting-for-approval' | 'waiting-for-response'

const isLaterThan = (candidate: TimelinePosition, reference: TimelinePosition): boolean => {
  if (candidate.updatedAt !== reference.updatedAt) return candidate.updatedAt > reference.updatedAt
  return (candidate.sortIndex ?? -1) > (reference.sortIndex ?? -1)
}

const findLatest = <T extends TimelinePosition>(items: T[]): T | undefined =>
  items.reduce<T | undefined>(
    (latest, item) => (!latest || isLaterThan(item, latest) ? item : latest),
    undefined
  )

// The transcript row projection keeps a prepared Notebook call static, but the Activity Stream still
// reports the provider-owned tool interaction. Settled permission dispositions are no longer active.
const isCurrentToolActive = (activity: ToolActivity): boolean =>
  (activity.status === 'pending' || activity.status === 'in_progress') &&
  activity.toolDisposition === undefined

const getCurrentRunTimeline = (
  session: ChatSession
): { prompt: ChatMessage | undefined; tools: ToolActivity[] } => {
  const latestUserPromptId = session.messages.findLast((message) => message.role === 'user')?.id
  const promptMessageId = session.activeRun?.promptMessageId ?? latestUserPromptId
  const prompt = promptMessageId
    ? session.messages.find((message) => message.id === promptMessageId)
    : undefined
  const tools = (session.activities ?? []).filter((activity) => {
    if (!promptMessageId || !prompt) return false
    return activity.promptMessageId
      ? activity.promptMessageId === promptMessageId
      : isLaterThan(activity, prompt)
  })

  return { prompt, tools }
}

// Uses timeline-owned timestamps so navigating away from a live Session cannot restart its clock.
// A terminal tool update begins the next silent thinking span, matching the visible phase change.
const getAgentThinkingStartedAt = (session: ChatSession | undefined): number | undefined => {
  if (!session) return undefined

  const { prompt, tools } = getCurrentRunTimeline(session)
  const latestTool = findLatest(tools)
  const runStartedAt = session.activeRun?.startedAt ?? prompt?.createdAt

  if (runStartedAt === undefined) return latestTool?.updatedAt
  return Math.max(runStartedAt, latestTool?.updatedAt ?? runStartedAt)
}

// The transient row belongs to the active request, not persisted history. User waits and live tools
// own their distinct phases. Visible Agent output is still partial until the run terminates, so it
// must not hide the only liveness signal during a silent gap before the next tool or text update.
const getAgentLoadingPhase = (session: ChatSession | undefined): AgentLoadingPhase => {
  if (!session) return 'hidden'
  const actionability = projectSessionActionability(session)
  if (actionability.waitReason === 'waiting-for-user') return 'waiting-for-response'
  if (
    actionability.waitReason === 'waiting-permission' ||
    actionability.waitReason === 'waiting-plan-approval'
  ) {
    return 'waiting-for-approval'
  }

  const hasLocalRun = Boolean(session.activeRun) && actionability.activity === 'running'
  if (!hasLocalRun && !session.agentPromptInFlight) return 'hidden'

  const { prompt, tools: currentRunTools } = getCurrentRunTimeline(session)
  const promptMessageId = session.activeRun?.promptMessageId ?? prompt?.id

  // Any live tool in the current request takes precedence over the surrounding thinking gaps.
  if (currentRunTools.some(isCurrentToolActive)) {
    return 'interacting-with-tools'
  }
  if (session.awaitingFirstAgentOutput) return 'thinking'
  if (!session.activeRun) return 'hidden'

  const promptIndex = session.messages.findIndex((message) => message.id === promptMessageId)

  if (promptIndex === -1) return 'hidden'

  return 'thinking'
}

export { getAgentLoadingPhase, getAgentThinkingStartedAt }
export type { AgentLoadingPhase }
