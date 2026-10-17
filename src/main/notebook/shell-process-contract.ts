import type { ManagedShellExecutionCapability } from './managed-shell-execution'
import type { NotebookExecutionRecovery } from '../../shared/execution-recovery'
import type { GrantedLocalRoot } from '../../shared/local-fs'
import type { ShellRuntimeBinding } from '../../shared/notebook'

export type NotebookShellResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  cwd?: string
  cwdBefore?: string
  truncated?: boolean
  cancelled?: boolean
  // Runtime-private cleanup evidence. Public adapters project only the legacy result fields.
  ownedTreeReaped?: boolean
  runtimeStatus?: 'unavailable'
  recovery?: NotebookExecutionRecovery
  errorCode?:
    'shell-runtime-unavailable' | 'shell-cleanup-incomplete' | 'shell-network-transport-unsupported'
}

export type NotebookShellProcessRequest = {
  /** Main-only authority; never accepted by a public request schema. */
  managedExecution?: ManagedShellExecutionCapability
  executionInvocationId?: string
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
