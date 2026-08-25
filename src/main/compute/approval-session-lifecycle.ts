type SessionApprovalLifecycleCallbacks = {
  onSessionTurnStarted?: (sessionId: string, turnToken: string) => void
  onSessionTurnEnded?: (sessionId: string, turnToken: string) => void
  onSkillImportAttachmentEligible?: (
    sessionId: string,
    turnToken: string,
    attachmentUri: string
  ) => void
  onSessionCancellationRequested?: (sessionId: string) => void
  onSessionUnavailable?: (sessionId: string) => void
  onAllSessionsCancellationRequested?: () => void
}

type ComputeApprovalLifecycleHandlers = {
  approvalCancelSession: (sessionId: string) => void
  approvalCompleteSessionCancellation: (sessionId: string) => void
  approvalCancelAll: () => void
}

export const bindComputeApprovalSessionLifecycle = (
  callbacks: SessionApprovalLifecycleCallbacks,
  compute: ComputeApprovalLifecycleHandlers
): SessionApprovalLifecycleCallbacks => ({
  ...callbacks,
  onSessionTurnStarted: (sessionId, turnToken) => {
    compute.approvalCompleteSessionCancellation(sessionId)
    callbacks.onSessionTurnStarted?.(sessionId, turnToken)
  },
  onSessionCancellationRequested: (sessionId) => {
    compute.approvalCancelSession(sessionId)
    callbacks.onSessionCancellationRequested?.(sessionId)
  },
  onSessionUnavailable: (sessionId) => {
    compute.approvalCancelSession(sessionId)
    callbacks.onSessionUnavailable?.(sessionId)
  },
  onAllSessionsCancellationRequested: () => {
    compute.approvalCancelAll()
    callbacks.onAllSessionsCancellationRequested?.()
  }
})
