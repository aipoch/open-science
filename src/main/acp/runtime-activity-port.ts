import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { AcpPromptRequest } from '../../shared/acp'
import type { MessageAttribution } from '../../shared/session-message-contract'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import type { AcpProviderPromptExecutor } from './provider-prompt-executor'
import type {
  ReviewerSessionDisposition,
  ReviewerSessionRequest,
  ReviewerSessionResult
} from './reviewer-session-owner'

export type AcpRuntimeActivityPort = {
  buildReviewerSession(request: ReviewerSessionRequest): Promise<ReviewerSessionResult>
  // Disposes an ephemeral reviewer session and unregisters it from the auto-approve set. Safe to call
  // even if the session was never registered (e.g. it failed before start). Returns the gate rejection
  // count plus whether a bridged reviewer request actually hit its trusted session scope. The reads and
  // clears are atomic here so callers need no capture-before-dispose ordering.
  disposeReviewerSession(
    session: import('@agentclientprotocol/sdk').ActiveSession
  ): ReviewerSessionDisposition
  sendPrompt(
    request: AcpPromptRequest,
    promptAttemptId?: string,
    onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>,
    runtimeReviewOwner?: 'task' | 'renderer'
  ): Promise<PromptResponse>
  sendApplicationPrompt(
    request: AcpPromptRequest,
    attribution: MessageAttribution,
    options?: {
      promptAttemptId?: string
      // Runs under prompt ownership, before prompt events, Artifact opening or provider dispatch.
      // Throwing rejects this application turn without emitting a user-visible prompt.
      onPromptAdmitted?: () => Promise<AcpPromptRequest['provenanceContext']>
    }
  ): Promise<PromptResponse>
  captureBackend(): AcpBackendGenerationView
  beginProviderTurnObservation(input: {
    providerSessionId: string
    cwd: string
  }): ReturnType<AcpProviderPromptExecutor['beginObservation']>
}
