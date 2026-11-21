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
