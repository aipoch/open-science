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
import type { PendingElicitationRequest } from '../../shared/elicitation'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SessionPersistenceCoordinator } from '../session-persistence/coordinator'

type DurableContinuationSessions = Pick<SessionPersistenceCoordinator, 'loadSessionForContinuation'>

type DurableContinuationPreparation = Readonly<{
  provenanceContext: NonNullable<AcpPromptRequest['provenanceContext']>
  historyReplay?: SessionHistoryReplay
}>

type DurableElicitationContinuationPreparation = DurableContinuationPreparation &
  Readonly<{ request: PendingElicitationRequest }>

type DurableContinuationReplay = {
  descriptor: HistoryReplayDescriptor
  supportsImageInput: boolean
}

class AcpDurableContinuationContextOwner {
  constructor(private readonly sessions?: DurableContinuationSessions) {}

  async prepare(input: {
    projectId: string
    sessionId: string
    promptMessageId: string
    replay?: DurableContinuationReplay
  }): Promise<DurableContinuationPreparation> {
    const session = await this.loadSession(input.projectId, input.sessionId)
    return this.prepareFromSession(session, input.promptMessageId, input.replay)
  }

  async prepareElicitation(input: {
    projectId: string
    sessionId: string
    requestId: string
    toolCallId: string
    replay?: DurableContinuationReplay
  }): Promise<DurableElicitationContinuationPreparation> {
    const session = await this.loadSession(input.projectId, input.sessionId)
    const matches = (session.activities ?? []).filter(
      (activity) =>
        activity.id === input.toolCallId &&
        activity.elicitation?.state === 'pending' &&
        activity.elicitation.durable?.kind === 'agent-user-choice' &&
        activity.elicitation.durable.requestId === input.requestId
    )
    if (matches.length !== 1) {
      throw new Error('Durable elicitation no longer matches the pending Session activity.')
    }
    const activity = matches[0]
    const projection = activity.elicitation!
    const durable = projection.durable!
    const promptMessageId = activity.promptMessageId ?? durable.promptMessageId
    if (
      !promptMessageId ||
      (activity.promptMessageId !== undefined &&
        durable.promptMessageId !== undefined &&
        activity.promptMessageId !== durable.promptMessageId)
    ) {
      throw new Error('Durable elicitation has inconsistent prompt authority.')
    }
    const continuation = this.prepareFromSession(session, promptMessageId, input.replay)
    return {
      ...continuation,
      request: {
        requestId: durable.requestId,
        sessionId: session.id,
        toolCallId: activity.id,
        message: projection.message,
        fields: structuredClone(projection.fields),
        durable: structuredClone(durable)
      }
    }
  }

  private async loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession> {
    if (!this.sessions) throw new Error('Durable continuation Session authority is not available.')
    const session = await this.sessions.loadSessionForContinuation(projectId, sessionId)
    if (session.id !== sessionId || session.projectId !== projectId) {
      throw new Error('Durable continuation Session identity does not match its authority.')
    }
    return session
  }

  private prepareFromSession(
    session: PersistedChatSession,
    promptMessageId: string,
    replay?: DurableContinuationReplay
  ): DurableContinuationPreparation {
    const graph = session.conversationGraph
    const activeFrame = graph?.frames.find((frame) => frame.id === graph.activeFrameId)
    const activeBranch = graph?.branches.find((branch) => branch.id === activeFrame?.activeBranchId)
    const prompt =
      graph && activeFrame
        ? resolveMessageBranchPath(graph, activeFrame.activeBranchId).find(
            (message) => message.id === promptMessageId
          )
        : undefined
    if (
      !graph ||
      !activeFrame ||
      !activeBranch ||
      prompt?.role !== 'user' ||
      prompt.status !== 'complete' ||
      prompt.agentFrameId !== activeFrame.id ||
      prompt.introducedOnBranchId !== activeBranch.id ||
      !prompt.runtimeSegmentId
    ) {
      throw new Error('Durable continuation no longer matches the active Message Branch.')
    }

    return {
      provenanceContext: getActiveConversationContext(graph, promptMessageId),
      ...(replay
        ? {
            historyReplay: buildSessionHistoryReplay(
              session.messages,
              replay.descriptor,
              session.projectId,
              replay.supportsImageInput
            )
          }
        : {})
    }
  }
}

export { AcpDurableContinuationContextOwner }
export type {
  DurableContinuationPreparation,
  DurableContinuationSessions,
  DurableElicitationContinuationPreparation
}
