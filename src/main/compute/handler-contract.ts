import type {
  CancelComputeJobRequest,
  ComputeExecutionMode,
  ComputeHost,
  DetailsAuthor,
  ProbeResult,
  RetryComputeJobHarvestRequest,
  SetComputeJobRemoteCleanupRequest
} from '@aipoch/compute'
import type { ComputeJobDeletionOwner, ConcurrencyManager } from '@aipoch/compute/node'
import type {
  ChangeComputeHostAuthenticationRequest,
  ChangeComputeHostAuthenticationResult,
  ComputeApprovalDecision,
  ComputeApprovalRequest,
  ComputeHostDeletionStatus,
  ComputeJobAnalysisTransition,
  ComputeJobsListFilter,
  ComputeJobsPendingNotificationFilter,
  ComputePasswordCapability,
  CreateComputeHostRequest,
  CreatePasswordComputeHostRequest,
  CreatePasswordComputeHostResult,
  JobSummary,
  ResetPasswordComputeHostRequest,
  ResetPasswordComputeHostResult
} from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../../shared/remote-fs'
import type { DeleteComputeHostOptions } from './compute-host-deletion-owner'
import type { ComputeService } from './compute-service'
import type { ComputeConnectionBroker } from './connection-broker'

export type ComputeHandlers = {
  list: () => Promise<ComputeHost[]>
  get: (providerId: string) => Promise<ComputeHost | null>
  create: (request: CreateComputeHostRequest) => Promise<ComputeHost>
  createPassword: (
    request: CreatePasswordComputeHostRequest
  ) => Promise<CreatePasswordComputeHostResult>
  resetPassword: (
    request: ResetPasswordComputeHostRequest
  ) => Promise<ResetPasswordComputeHostResult>
  changeAuthentication: (
    request: ChangeComputeHostAuthenticationRequest
  ) => Promise<ChangeComputeHostAuthenticationResult>
  passwordCapability: () => Promise<ComputePasswordCapability>
  delete: (providerId: string, options?: DeleteComputeHostOptions) => Promise<void>
  deletionStatus: (providerId: string) => Promise<ComputeHostDeletionStatus>
  // Selectable Host aliases parsed from ~/.ssh/config (patterns and Match blocks excluded).
  sshConfigAliases: () => Promise<string[]>
  // Runs the probe bundle against the host and persists the result. Returns the ProbeResult.
  probe: (providerId: string) => Promise<ProbeResult>
  // Persisted instructions only; resource observations are exposed on the host's probeResult.
  // The read doc is the exact oldText baseline for a guarded replacement.
  detailsGet: (providerId: string) => Promise<{ doc: string }>
  detailsSave: (
    providerId: string,
    text: string,
    oldText: string,
    author: DetailsAuthor
  ) => Promise<void>
  // Scratch root: set path and mark pinned.
  scratchSet: (providerId: string, path: string) => Promise<void>
  // Scratch root: clear the override so probes may auto-detect it again.
  scratchClear: (providerId: string) => Promise<void>
  // Enforced concurrent job limit: set 1..500.
  concurrencySet: (providerId: string, limit: number) => Promise<void>
  executionModeSet: (providerId: string, executionMode: ComputeExecutionMode) => Promise<void>
  // Session-level concurrency control (Phase 3c, issue 04).
  setSessionConcurrencyLimit: (sessionId: string, limit: number) => Promise<void>
  getSessionConcurrencyStatus: (sessionId: string) => Promise<{
    session_limit: number | null
    active_count: number
    queued_count: number
    provider_ceilings: Record<string, number>
    queue_blocked_reason?: import('@aipoch/compute').ComputeQueueBlockedReason
  }>
  listDir: (providerId: string, path: string) => Promise<DirListing>
  download: (providerId: string, remotePath: string, dest: DownloadDest) => Promise<LocalFile>
  revealInFolder: (filePath: string) => Promise<void>
  // The compute service instance, exposed so the notebook RPC server can wire computeCall.
  computeService: ComputeService
  connectionBroker: ComputeConnectionBroker
  concurrencyManager?: ConcurrencyManager
  jobDeletionOwner?: ComputeJobDeletionOwner
  // Responds to a pending approval request from the renderer with a canonical app-owned scope.
  approvalRespond: (id: string, decision: ComputeApprovalDecision) => void
  approvalReplay: (id: string) => ComputeApprovalRequest | null
  approvalReplayPending: () => void
  approvalPauseSession: (sessionId: string) => void
  approvalResumeSession: (sessionId: string) => void
  approvalCancelSession: (sessionId: string) => void
  approvalCancelAll: () => void
  approvalCompleteGlobalCancellation: () => void
  approvalCompleteSessionCancellation: (sessionId: string) => void
  approvalBeginSessionDeletion: (sessionId: string) => void
  approvalFinishSessionDeletion: (sessionId: string, retained: boolean) => void
  // Returns either a Session feed or the bounded global non-terminal activity projection.
  jobsList: (filter: ComputeJobsListFilter) => Promise<JobSummary[]>
  jobsCancel: (
    request: CancelComputeJobRequest
  ) => Promise<import('@aipoch/compute').JobStatusResult>
  jobsRetryHarvest: (request: RetryComputeJobHarvestRequest) => Promise<void>
  jobsSetRemoteCleanup: (request: SetComputeJobRemoteCleanupRequest) => Promise<void>
  // Returns jobs with notifiedAt set and notificationConsumedAt null (issue 05 restart recovery).
  jobsPendingNotification: (filter: ComputeJobsPendingNotificationFilter) => Promise<JobSummary[]>
  // Marks the given job ids as notification-consumed. Idempotent (issue 05).
  jobsMarkConsumed: (sessionId: string, jobIds: string[]) => Promise<void>
  jobsTransitionAnalysis: (request: ComputeJobAnalysisTransition) => Promise<JobSummary[]>
}
