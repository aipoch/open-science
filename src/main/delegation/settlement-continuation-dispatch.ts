import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AcpPromptRequest } from '../../shared/acp'
import type { DelegationSettlementDispatch } from './delegation-settlement-wake-owner'
import { DelegateMessagePreAcceptanceError } from './execution-port'

type SettlementContinuationDispatchOptions = Readonly<{
  sendAppContinuationObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void,
    settlement: DelegationSettlementDispatch
  ): Promise<unknown>
  onPromptEnded(sessionId: string, promptId: string): Promise<void> | void
}>

const createDelegationSettlementContinuationDispatch =
  (
    options: SettlementContinuationDispatchOptions
  ): ((request: DelegationSettlementDispatch) => Promise<void>) =>
  async (request) => {
    let providerAccepted = false
    const completion = options.sendAppContinuationObserved(
      {
        sessionId: request.sessionId,
        text: request.text,
        suppressUserMessage: true,
        provenanceContext: {
          promptMessageId: request.originatingPromptId,
          originMessageId: request.originatingPromptId,
          rootFrameId: request.rootFrameId,
          agentFrameId: request.rootFrameId,
          ...(request.rootBranchId
            ? {
                messageBranchId: request.rootBranchId,
                messageBranchAncestry: [request.rootBranchId]
              }
            : {}),
          messageAncestry: [request.originatingPromptId],
          runtimeSegmentId: request.runtimeSegmentId
        }
      },
      () => {
        providerAccepted = true
      },
      request
    )
    try {
      await completion
    } catch (error) {
      if (!providerAccepted && error instanceof DelegateMessagePreAcceptanceError) throw error
    }
    await Promise.resolve(options.onPromptEnded(request.sessionId, request.promptId)).catch(
      () => undefined
    )
  }

// Main re-arms the originating turn only after root dispatch admission; renderer metadata saves
// cannot create this authority, and a newer user run or switched Branch must keep it parked.
const admitDelegationSettlement = (
  session: PersistedChatSession,
  request: DelegationSettlementDispatch,
  now = Date.now()
): PersistedChatSession => {
  const graph = session.conversationGraph
  const root = graph?.frames.find(({ id }) => id === request.rootFrameId)
  const prompt =
    graph &&
    resolveActiveConversationMessages(graph).find(({ id }) => id === request.originatingPromptId)
  if (
    session.id !== request.sessionId ||
    session.projectId !== request.projectId ||
    session.archivedAt !== undefined ||
    session.activeRun ||
    session.promptPreparation ||
    session.status !== 'idle' ||
    graph?.rootFrameId !== request.rootFrameId ||
    graph.activeFrameId !== request.rootFrameId ||
    root?.activeBranchId !== request.rootBranchId ||
    prompt?.role !== 'user' ||
    prompt.runtimeSegmentId !== request.runtimeSegmentId
  )
    throw new DelegateMessagePreAcceptanceError(
      'Delegation settlement no longer has an idle active root turn.'
    )
  const startedAt = Math.max(now, (session.runtimeTranscriptLastRun?.startedAt ?? 0) + 1)
  return {
    ...session,
    status: 'running',
    activeRun: { promptMessageId: request.originatingPromptId, startedAt },
    updatedAt: Math.max(startedAt, session.updatedAt)
  }
}

export { createDelegationSettlementContinuationDispatch, admitDelegationSettlement }
export type { SettlementContinuationDispatchOptions }
