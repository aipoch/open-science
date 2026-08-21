import type { AcpPromptRequest } from '../../shared/acp'
import type { DelegationSettlementDispatch } from './delegation-settlement-wake-owner'

type SettlementContinuationDispatchOptions = Readonly<{
  sendAppContinuation(request: AcpPromptRequest): Promise<unknown>
  onPromptEnded(sessionId: string, promptId: string): Promise<void> | void
}>

const createDelegationSettlementContinuationDispatch =
  (
    options: SettlementContinuationDispatchOptions
  ): ((request: DelegationSettlementDispatch) => void) =>
  (request) => {
    const completion = options.sendAppContinuation({
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
        runtimeSegmentId: request.promptId
      }
    })
    const settle = (): Promise<void> | void =>
      options.onPromptEnded(request.sessionId, request.promptId)
    void completion.then(settle, settle)
  }

export { createDelegationSettlementContinuationDispatch }
export type { SettlementContinuationDispatchOptions }
