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

export interface NotebookProcessSandbox {
  wrap(invocation: NotebookSandboxInvocation): Promise<NotebookSandboxedSpawn>
  requestNetworkAccess?(
    request: NotebookNetworkAccessDecisionRequest
  ): Promise<NotebookNetworkAccessDecisionResult>
}
