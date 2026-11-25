export type TaskContinuationIdentity = Readonly<{
  kind: 'plan' | 'permission' | 'question' | 'delegation_settlement'
  projectId: string
  sessionId: string
  attemptId: string
}>

export type TaskContinuationTracker = <Result extends { stopReason: string }>(
  identity: TaskContinuationIdentity & {
    originalPromptMessageId: string
    originalRunId?: string
    promptMessageId: string
    branchId?: string
  },
  send: (onProviderDispatched: () => void, taskRunId?: string) => Promise<Result>
) => Promise<Result>

// Main attaches this to the dispatched prompt. JSON and IPC callers cannot supply it.
const taskPromptOwner = Symbol('taskPromptOwner')

export const withTaskPromptOwner = <Request extends object>(
  request: Request,
  runId?: string
): Request => (runId ? { ...request, [taskPromptOwner]: runId } : request)

export const taskPromptOwnerOf = (request: object): string | undefined =>
  (request as { [taskPromptOwner]?: string })[taskPromptOwner]

const delegationSettlementPrompt = Symbol('delegationSettlementPrompt')

export const withDelegationSettlementPrompt = <Request extends object>(
  request: Request
): Request => ({ ...request, [delegationSettlementPrompt]: true })

export const isDelegationSettlementPrompt = (request: object): boolean =>
  (request as { [delegationSettlementPrompt]?: boolean })[delegationSettlementPrompt] === true

export class DelegationSettlementAdmissionError extends Error {
  static readonly scopeChangedMessage =
    'The parent prompt, Message Branch, or Runtime Segment is no longer current. Check the original interaction and current Session before continuing.'

  constructor(reason: 'scope_changed' | 'network_approval_pending' = 'scope_changed') {
    super(
      reason === 'network_approval_pending'
        ? 'The Session is waiting for network approval. Review the pending request before continuing.'
        : DelegationSettlementAdmissionError.scopeChangedMessage
    )
    this.name = 'DelegationSettlementAdmissionError'
  }
}
