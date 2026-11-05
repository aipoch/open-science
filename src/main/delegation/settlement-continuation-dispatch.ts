import type { AcpPromptRequest } from '../../shared/acp'
import type { DelegationSettlementDispatch } from './delegation-settlement-wake-owner'
import { DelegateMessagePreAcceptanceError } from './execution-port'

type SettlementContinuationDispatchOptions = Readonly<{
  sendAppContinuationObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void
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
      }
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

export { createDelegationSettlementContinuationDispatch }
export type { SettlementContinuationDispatchOptions }
