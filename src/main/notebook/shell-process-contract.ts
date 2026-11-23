import type { NotebookExecutionRecovery } from '../../shared/execution-recovery'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import type { NotebookRunStatus, ShellRuntimeBinding } from '../../shared/notebook'

export type NotebookShellResult = {
  kernelDispatched?: boolean
  executionStarted?: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  // Foreground results carry the recorded outcome when there is no numeric exit code.
  status?: NotebookRunStatus
  cwd?: string
  cwdBefore?: string
  truncated?: boolean
  cancelled?: boolean
  // Private evidence from the command deadline and process owner.
  timedOut?: true
  ownedTreeReaped?: boolean
  runtimeStatus?: 'unavailable'
  recovery?: NotebookExecutionRecovery
  errorCode?:
    'shell-runtime-unavailable' | 'shell-cleanup-incomplete' | 'shell-network-transport-unsupported'
}

export type NotebookShellProcessRequest = {
  executionAdmission?: import('./execution-admission').NotebookExecutionAdmission
  laneKey?: string
  runId?: string
  command: string
  cwd: string
  handoffDir: string
  runtimeRoot: string
  notebookSessionRoot?: string
  inputRoot?: string
  protectedDirs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  executionReference?: string
  sessionId: string
  projectId: string
  timeoutMs?: number
  signal?: AbortSignal
  runtimeBinding?: ShellRuntimeBinding
  grantedRoots?: readonly GrantedLocalRoot[]
}
