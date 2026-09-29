import type {
  ResearchSubmissionClaim,
  ResearchSubmissionClaimRequest,
  ResearchSubmissionFinishRequest,
  ResearchSubmission
} from '../../../../shared/research-submission'
import type {
  SendWorkspaceMessageIntent,
  SendWorkspaceMessageResult
} from '../acp/useWorkspaceAgentRuntime'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
export type ResearchSubmissionDispatchPorts = {
  writer: () => Promise<ResearchSubmissionClaimRequest | undefined>
  claim: (request: ResearchSubmissionClaimRequest) => Promise<ResearchSubmissionClaim>
  finish: (request: ResearchSubmissionFinishRequest) => Promise<ResearchSubmission>
  hydrate: (session: PersistedChatSession) => void
  send: (intent: SendWorkspaceMessageIntent) => Promise<SendWorkspaceMessageResult | undefined>
}
// One pass never retries a claimed prompt. After an ambiguous transport failure, the main journal
// remains sending until takeover/restart makes it uncertain; it cannot quietly call the model twice.
export class ResearchSubmissionDispatcher {
  private pending?: Promise<void>
  constructor(private readonly ports: ResearchSubmissionDispatchPorts) {}
  tick(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = this.dispatch().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
  private async dispatch(): Promise<void> {
    const writer = await this.ports.writer()
    if (!writer) return
    const claimed = await this.ports.claim(writer)
    if (!claimed) return
    const { submission, session } = claimed
    if (!submission.claimToken || !submission.discussionSessionId) return
    let result: SendWorkspaceMessageResult | undefined
    let error: string | undefined
    try {
      this.ports.hydrate(session)
      result = await this.ports.send({
        ...submission.payload,
        projectId: submission.projectId,
        sessionId: submission.discussionSessionId,
        messageId: submission.messageId,
        requireExistingSession: true,
        preserveSelection: true
      })
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 4000)
    }
    await this.ports.finish({
      ...writer,
      id: submission.id,
      claimToken: submission.claimToken,
      disposition:
        result?.messageId === submission.messageId &&
        result.sessionId === submission.discussionSessionId
          ? 'accepted'
          : 'failed',
      ...(error ? { error } : {})
    })
  }
}
