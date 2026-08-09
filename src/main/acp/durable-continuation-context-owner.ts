import type { AcpPromptRequest } from '../../shared/acp'
import {
  getActiveConversationContext,
  resolveMessageBranchPath
} from '../../shared/conversation-graph'
import type { HistoryReplayDescriptor } from '../../shared/history-preamble'
import {
  buildSessionHistoryReplay,
  type SessionHistoryReplay
} from '../../shared/session-history-replay'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'

type DurableContinuationSessions = Pick<
  SessionPersistenceCoordinator,
  'loadSessionForContinuation'
>

type DurableContinuationPreparation = Readonly<{
  provenanceContext: NonNullable<AcpPromptRequest['provenanceContext']>
  historyReplay?: SessionHistoryReplay
}>

class AcpDurableContinuationContextOwner {
  constructor(private readonly sessions?: DurableContinuationSessions) {}

  async prepare(input: {
    projectId: string
    sessionId: string
    promptMessageId: string
    replay?: { descriptor: HistoryReplayDescriptor; supportsImageInput: boolean }
  }): Promise<DurableContinuationPreparation> {
    if (!this.sessions) throw new Error('Durable continuation Session authority is not available.')

    const session = await this.sessions.loadSessionForContinuation(
      input.projectId,
      input.sessionId
    )
    const prompt = session.messages.find((message) => message.id === input.promptMessageId)
    const graph = session.conversationGraph
    const activeFrame = graph?.frames.find((frame) => frame.id === graph.activeFrameId)
    const activeMessageIds =
      graph && activeFrame
        ? new Set(resolveMessageBranchPath(graph, activeFrame.activeBranchId).map(({ id }) => id))
        : undefined
    if (
      session.id !== input.sessionId ||
      session.projectId !== input.projectId ||
      prompt?.role !== 'user' ||
      !graph ||
      !activeMessageIds?.has(input.promptMessageId)
    ) {
      throw new Error('Durable continuation no longer matches the active Message Branch.')
    }

    return {
      provenanceContext: getActiveConversationContext(graph, input.promptMessageId),
      ...(input.replay
        ? {
            historyReplay: buildSessionHistoryReplay(
              session.messages,
              input.replay.descriptor,
              session.projectId,
              input.replay.supportsImageInput
            )
          }
        : {})
    }
  }
}

export { AcpDurableContinuationContextOwner }
export type { DurableContinuationPreparation, DurableContinuationSessions }
