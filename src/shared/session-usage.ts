import {
  isHiddenControlMessage,
  isHumanUserMessage,
  type PersistedChatMessage,
  type PersistedChatSession
} from './session-persistence'

export type SessionUsageMessage = {
  message: PersistedChatMessage
  isRootFrame: boolean
  inherited: boolean
  runtimeSegmentId?: string
  parentMessageId?: string | null
}

export const sessionUsageMessages = (session: PersistedChatSession): SessionUsageMessage[] => {
  const graph = session.conversationGraph
  const messages: SessionUsageMessage[] = graph
    ? graph.messages.map((message) => ({
        message,
        isRootFrame: message.agentFrameId === graph.rootFrameId,
        inherited: !!message.usageOrigin,
        runtimeSegmentId: message.runtimeSegmentId,
        parentMessageId: message.parentMessageId
      }))
    : session.messages.map((message, index) => ({
        message,
        isRootFrame: true,
        inherited: !!message.usageOrigin,
        parentMessageId: session.messages[index - 1]?.id
      }))

  // Released branches predate usageOrigin. Their recorded snapshot head and its ancestry identify
  // inherited history without assuming message/call IDs are globally unique or relying on dates.
  const byId = new Map(messages.map((entry) => [entry.message.id, entry]))
  const visited = new Set<string>()
  let inheritedId = session.branchSource?.headMessageId
  while (inheritedId && !visited.has(inheritedId)) {
    visited.add(inheritedId)
    const entry = byId.get(inheritedId)
    if (!entry) break
    entry.inherited = true
    inheritedId = entry.parentMessageId ?? undefined
  }
  return messages
}

export type SessionUsageRun = { messageId: string; createdAt: number; reportedAt?: number }

export const sessionUsageRuns = (
  session: PersistedChatSession,
  messages: readonly SessionUsageMessage[] = sessionUsageMessages(session)
): SessionUsageRun[] => {
  const runs = new Map<string, SessionUsageRun>()
  const byId = new Map(messages.map((entry) => [entry.message.id, entry]))
  for (const { message, isRootFrame, inherited } of messages) {
    if (
      isRootFrame &&
      !inherited &&
      isHumanUserMessage(message) &&
      !isHiddenControlMessage(message) &&
      !message.delegatedCallerSource
    ) {
      runs.set(message.id, {
        messageId: message.id,
        createdAt: message.createdAt || session.createdAt
      })
    }
  }
  for (const { message, isRootFrame, inherited, parentMessageId } of messages) {
    if (!isRootFrame || inherited || message.role !== 'agent' || !message.turnUsage) continue
    let promptId = message.responseToMessageId
    if (!promptId) {
      // Legacy messages have no response identity. Follow their own branch ancestry and stop at
      // the first user message, including application/control prompts; never borrow another run.
      const visited = new Set<string>()
      let parentId = parentMessageId
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId)
        const parent = byId.get(parentId)
        if (!parent || !parent.isRootFrame) break
        if (parent.message.role === 'user') {
          promptId = parentId
          break
        }
        parentId = parent.parentMessageId
      }
    }
    const run = promptId ? runs.get(promptId) : undefined
    if (!run) continue
    const timestamp = message.completedAt ?? message.updatedAt ?? message.createdAt
    run.reportedAt = Math.min(run.reportedAt ?? timestamp, timestamp)
  }
  return [...runs.values()]
}
