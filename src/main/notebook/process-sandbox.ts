import type { RequestNotebookNetworkAccessResult } from '../../shared/notebook'
import type { ShellRuntimeBinding } from '../../shared/notebook'
import type { WindowsNotebookRuntime } from './windows-notebook-runtime'
import type { NotebookLocalService } from '@aipoch/notebook-network-sandbox'
export type { NotebookLocalService } from '@aipoch/notebook-network-sandbox'

export type NotebookSandboxTarget =
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'wsl2'
      profileId: string
      distro: string
      user: string
    }>

export type NotebookSandboxCleanupReason = 'exit' | 'cancel' | 'timeout' | 'spawn-failed'

/**
 * Evidence about the child process owned by a sandbox request.
 *
 * `never-started` is stronger than a failed termination attempt: no child was
 * created, so releasing command resources cannot strand a process tree.
 * `termination-unknown` is deliberately conservative and keeps the owning
 * cleanup fence in place until the original owner supplies new proof.
 */
export type NotebookSandboxProcessState =
  'never-started' | 'started-and-reaped' | 'termination-unknown'

export type NotebookSandboxCleanupResult = Readonly<{
  processesTerminated: boolean
  processState?: NotebookSandboxProcessState
  networkClosed: boolean
  temporaryResourcesRemoved: boolean
  admission?: 'blocked' | 'independent-command-allowed'
}>

export type NotebookSandboxProcessOutcome = Readonly<{
  processesTerminated: boolean
  /** Explicit child lifecycle evidence. Omitted by older callers and inferred from the boolean. */
  processState?: NotebookSandboxProcessState
  /** Retained by the command owner; rechecks the same owned tree, never a replacement PID. */
  confirmTermination?: () => Promise<boolean>
}>

/** Attach lifecycle evidence while retaining the legacy termination projection. */
export const withNotebookSandboxProcessState = (
  outcome: Omit<NotebookSandboxProcessOutcome, 'processState'>,
  processState: NotebookSandboxProcessState
): NotebookSandboxProcessOutcome => {
  return { ...outcome, processState, processesTerminated: processState !== 'termination-unknown' }
}

export type NotebookSandboxInvocation = Readonly<{
  /** Trusted host capability; its identity must match this invocation's executionReference. */
  localService?: NotebookLocalService
  target?: NotebookSandboxTarget
  executable: string
  args: readonly string[]
  electronAsNode?: boolean
  env: NodeJS.ProcessEnv
  pathEnvironment?: NodeJS.ProcessEnv
  cwd: string
  commandText: string
  executionReference?: string
  sessionId: string
  projectId: string
  runtime: 'python' | 'r' | 'repl' | 'bash'
  /** Exact public hostnames granted only to this wrapped process. */
  allowedNetworkHosts?: readonly string[]
  localRpcSocketPath?: string
  inheritedFileDescriptorCount?: number
  // Package installers opt in so standard Windows mode can contain helpers in a native Job Object.
  superviseProcessTree?: boolean
  /** Native Windows host forwards its stdin into this private Shell control pipe. */
  windowsShellControlPipe?: string
  /** Transient R admission decision; launch must retain this protection requirement. */
  windowsProtectionRequired?: boolean
  /** A durable grant used for admission must still be authorized at launch. */
  windowsRuntimeAccessRequired?: boolean
  filesystem: Readonly<{
    readOnlyRoots: readonly string[]
    optionalReadOnlyRoots?: readonly string[]
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
  // Validates launch-bound evidence that no workload remains: never started or Job Object empty.
  confirmProcessTreeTermination?: () => Promise<boolean>
  requestProcessTreeTermination?: () => Promise<boolean>
  confirmProcessState?: () => Promise<NotebookSandboxProcessState>
  beginSpawn?: () => Readonly<{ started: () => void; notStarted: () => void }>
  beginExecution?: (request?: { commandText: string }) => () => void
  annotateStderr: (stderr: string, stdout?: string) => string
  cleanup: (
    reason: NotebookSandboxCleanupReason,
    processOutcome: NotebookSandboxProcessOutcome
  ) => Promise<NotebookSandboxCleanupResult>
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

export type NotebookNetworkAccessDecisionResult = RequestNotebookNetworkAccessResult

// The native UAC decision cancels preparation before any cell is dispatched.
export class NotebookRuntimeAccessCancelledError extends Error {
  constructor(
    message = 'R access authorization was cancelled. Automatic retries in this conversation will not prompt again. Use Authorize and verify in Runtimes to retry authorization.'
  ) {
    super(message)
    this.name = 'NotebookRuntimeAccessCancelledError'
  }
}

export type NotebookRuntimeAccessAdmission = Readonly<{
  windowsProtectionRequired: boolean
  windowsRuntimeAccessRequired: boolean
}>

export interface NotebookProcessSandbox {
  resolveWindowsRuntime?(request: {
    runtime: 'repl' | 'bash'
    binding?: ShellRuntimeBinding
    signal?: AbortSignal
  }): Promise<WindowsNotebookRuntime | null | undefined>
  ensureRuntimeAccess?(
    request: Pick<NotebookSandboxInvocation, 'runtime' | 'executable' | 'sessionId' | 'signal'>
  ): Promise<NotebookRuntimeAccessAdmission | void>
  wrap(invocation: NotebookSandboxInvocation): Promise<NotebookSandboxedSpawn>
  requestNetworkAccess?(
    request: NotebookNetworkAccessDecisionRequest
  ): Promise<NotebookNetworkAccessDecisionResult>
}
