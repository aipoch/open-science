import type { AcpPromptRequest } from '../../shared/acp'
import type { DelegationSettlementDispatch } from './delegation-settlement-wake-owner'
import { DelegateMessagePreAcceptanceError } from './execution-port'
import {
  SettlementAdmissionError,
  type SettlementAdmission
} from '../../shared/runtime-session-admission'
import { createLogger, diagnosticErrorFields } from '../logger'

const log = createLogger('delegation')

type SettlementContinuationDispatchOptions = Readonly<{
  sendAppContinuationObserved(
    request: AcpPromptRequest,
    onProviderPromptAccepted: () => void,
    settlementAdmission: SettlementAdmission,
    validate?: () => void
  ): Promise<unknown>
  onPromptEnded(sessionId: string, promptId: string): Promise<void> | void
}>

const createDelegationSettlementContinuationDispatch =
  (
    options: SettlementContinuationDispatchOptions
  ): ((request: DelegationSettlementDispatch) => Promise<void>) =>
  async (request) => {
    let providerAccepted = false
    try {
      if (!request.rootBranchId || !request.rootBranchRevision) {
        throw new SettlementAdmissionError('missing-source-branch', 'invalidated')
      }
      await options.sendAppContinuationObserved(
        {
          sessionId: request.sessionId,
          text: request.text,
          suppressUserMessage: true,
          provenanceContext: {
            promptMessageId: request.originatingPromptId,
            originMessageId: request.originatingPromptId,
            rootFrameId: request.rootFrameId,
            agentFrameId: request.rootFrameId,
            messageBranchId: request.rootBranchId,
            messageBranchAncestry: [request.rootBranchId],
            messageAncestry: [request.originatingPromptId],
            runtimeSegmentId: request.runtimeSegmentId
          }
        },
        () => {
          providerAccepted = true
          log.info('Settlement provider accepted', {
            batchId: request.batchId,
            sessionId: request.sessionId,
            promptId: request.promptId
          })
        },
        {
          batchId: request.batchId,
          projectId: request.projectId,
          sessionId: request.sessionId,
          rootFrameId: request.rootFrameId,
          originatingPromptId: request.originatingPromptId,
          rootBranchId: request.rootBranchId,
          rootBranchRevision: request.rootBranchRevision,
          promptRuntimeSegmentId: request.runtimeSegmentId,
          items: request.items.map(({ frameId, attemptId, status }) => ({
            frameId,
            attemptId,
            status
          }))
        },
        request.validate
      )
    } catch (error) {
      if (!providerAccepted && error instanceof SettlementAdmissionError) {
        const report = error.disposition === 'retry' ? log.warn : log.info
        report(
          error.disposition === 'invalidated'
            ? 'Settlement invalidated'
            : 'Settlement admission rejected',
          {
            batchId: request.batchId,
            sessionId: request.sessionId,
            reason: error.reason,
            disposition: error.disposition,
            ...(error.disposition === 'retry' ? diagnosticErrorFields(error.cause ?? error) : {})
          }
        )
        if (error.disposition !== 'invalidated') throw error
      } else if (!providerAccepted && error instanceof DelegateMessagePreAcceptanceError) {
        log.warn('Settlement admission rejected', {
          batchId: request.batchId,
          sessionId: request.sessionId,
          reason: 'pre-dispatch-rejection',
          ...diagnosticErrorFields(error.cause ?? error)
        })
        throw error
      } else {
        log.warn('Settlement provider execution failed', {
          batchId: request.batchId,
          sessionId: request.sessionId,
          providerAccepted,
          ...diagnosticErrorFields(error)
        })
      }
    }
    log.info('Settlement terminal', {
      batchId: request.batchId,
      sessionId: request.sessionId,
      promptId: request.promptId,
      providerAccepted
    })
    try {
      await options.onPromptEnded(request.sessionId, request.promptId)
    } catch (error) {
      // Terminal cleanup must never turn a possibly dispatched batch into another model call.
      log.warn('Settlement terminal cleanup failed', {
        batchId: request.batchId,
        sessionId: request.sessionId,
        ...diagnosticErrorFields(error)
      })
    }
  }

export { createDelegationSettlementContinuationDispatch }
export type { SettlementContinuationDispatchOptions }
