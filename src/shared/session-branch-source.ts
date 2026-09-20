import type { PersistedChatSession } from './session-persistence'

export const createSessionBranchSource = (
  source: Pick<PersistedChatSession, 'id' | 'conversationGraph'>,
  headMessageId?: string
): NonNullable<PersistedChatSession['branchSource']> => {
  const graph = source.conversationGraph
  const frame = graph?.frames.find((candidate) => candidate.id === graph.activeFrameId)
  const branch = graph?.branches.find((candidate) => candidate.id === frame?.activeBranchId)

  return {
    sessionId: source.id,
    ...(frame ? { agentFrameId: frame.id } : {}),
    ...(branch ? { messageBranchId: branch.id } : {}),
    ...((headMessageId ?? branch?.headMessageId)
      ? { headMessageId: headMessageId ?? branch?.headMessageId }
      : {})
  }
}
