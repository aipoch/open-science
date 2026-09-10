export type NotebookSandboxInvocation = Readonly<{
  executable: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  commandText: string
  sessionId: string
  projectId: string
  runtime: 'python' | 'r' | 'repl' | 'bash'
  localRpcSocketPath?: string
  inheritedFileDescriptorCount?: number
  filesystem: Readonly<{
    readOnlyRoots: readonly string[]
    readWriteRoots: readonly string[]
    deniedReadRoots: readonly string[]
    deniedWriteRoots: readonly string[]
  }>
  signal?: AbortSignal
}>

export type NotebookSandboxedSpawn = Readonly<{
  executable: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  // Only the native protected Windows host provides kill-on-close descendant containment.
  windowsJobObject?: true
  beginExecution?: () => () => void
  annotateStderr: (stderr: string) => string
  cleanup: () => void
}>

export type NotebookNetworkAccessDecisionRequest = Readonly<{
  sessionId: string
  projectId: string
  hostname: string
  reason: string
  runtime?: NotebookSandboxInvocation['runtime']
  command?: string
  signal?: AbortSignal
}>

export type NotebookNetworkAccessDecisionResult = Readonly<{
  hostname: string
  status: 'alreadyAllowed' | 'allowedOnce' | 'alwaysAllowed' | 'denied' | 'blocked' | 'unavailable'
}>

// The native UAC decision cancels preparation before any cell is dispatched.
export class NotebookRuntimeAccessCancelledError extends Error {
  constructor(
    message = 'R access authorization was cancelled. Automatic retries in this conversation will not prompt again. Use Authorize and verify in Runtimes to retry authorization.'
  ) {
    super(message)
    this.name = 'NotebookRuntimeAccessCancelledError'
  }
}

export interface NotebookProcessSandbox {
  ensureRuntimeAccess?(
    request: Pick<NotebookSandboxInvocation, 'runtime' | 'executable' | 'sessionId' | 'signal'>
  ): Promise<void>
  wrap(invocation: NotebookSandboxInvocation): Promise<NotebookSandboxedSpawn>
  requestNetworkAccess?(
    request: NotebookNetworkAccessDecisionRequest
  ): Promise<NotebookNetworkAccessDecisionResult>
}
