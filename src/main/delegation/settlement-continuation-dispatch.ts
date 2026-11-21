import type { AcpPromptRequest } from '../../shared/acp'
import {
  withDelegationSettlementPrompt,
  withTaskPromptOwner,
  type TaskContinuationTracker
} from '../../shared/task-continuation'
import type { DelegationSettlementDispatch } from './delegation-settlement-wake-owner'
import { DelegateMessagePreAcceptanceError } from './execution-port'

type SettlementContinuationDispatchOptions = Readonly<{
  sendAppContinuationObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void
  ): Promise<{ stopReason: string }>
  trackTaskContinuation?: TaskContinuationTracker
  onPromptEnded(sessionId: string, promptId: string): Promise<void> | void
}>

const createDelegationSettlementContinuationDispatch =
  (
    options: SettlementContinuationDispatchOptions
  ): ((request: DelegationSettlementDispatch) => Promise<void>) =>
  async (request) => {
    let providerAccepted = false
    let untrackedPreAcceptanceFailure = false
    const send = async (
      onProviderDispatched?: () => void,
      taskRunId?: string
    ): Promise<{ stopReason: string }> => {
      const prompt: AcpPromptRequest = {
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
      }
      try {
        return await options.sendAppContinuationObserved(
          taskRunId
            ? withDelegationSettlementPrompt(withTaskPromptOwner(prompt, taskRunId))
            : prompt,
          () => {
            providerAccepted = true
            onProviderDispatched?.()
          }
        )
      } catch (error) {
        untrackedPreAcceptanceFailure =
          !taskRunId && !providerAccepted && error instanceof DelegateMessagePreAcceptanceError
        throw error
      }
    }
    try {
      if (options.trackTaskContinuation) {
        await options.trackTaskContinuation(
          {
            kind: 'delegation_settlement',
            projectId: request.projectId,
            sessionId: request.sessionId,
            attemptId: request.promptId,
            originalPromptMessageId: request.originatingPromptId,
            promptMessageId: request.originatingPromptId,
            branchId: request.rootBranchId
          },
          send
        )
      } else await send()
    } catch (error) {
      // Once tracked, the durable receipt owns any failure. Retrying with a fresh wake ID
      // would make an uncertain provider outcome indistinguishable from a new turn.
      if (untrackedPreAcceptanceFailure) throw error
    }
    await Promise.resolve(options.onPromptEnded(request.sessionId, request.promptId)).catch(
      () => undefined
    )
  }

export { createDelegationSettlementContinuationDispatch }
export type { SettlementContinuationDispatchOptions }
