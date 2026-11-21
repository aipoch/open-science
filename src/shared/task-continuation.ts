export type TaskContinuationIdentity = Readonly<{
  kind: 'plan' | 'permission' | 'question' | 'delegation_settlement'
  projectId: string
  sessionId: string
  attemptId: string
}>

export type TaskContinuationTracker = <Result extends { stopReason: string }>(
  identity: TaskContinuationIdentity & {
    originalPromptMessageId: string
    promptMessageId: string
    branchId?: string
  },
  send: (onProviderDispatched: () => void, taskRunId?: string) => Promise<Result>
) => Promise<Result>
