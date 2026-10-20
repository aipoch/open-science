// Shared compute-host types crossing the main <-> renderer IPC boundary.
//
// Phase 1 (issue 01) covers host record management only: the SQLite/Prisma layer owns ComputeHost
// rows (see src/main/compute). Probe/SSH execution and approvals land in later issues. Timestamps are
// normalized to epoch milliseconds at the repository boundary so the renderer treats them like other
// persisted timestamps. Credentials are encrypted and stored separately; this projection exposes status only.

// Host topology, inferred by probe in a later issue. Persisted so downstream issues can branch on it;
// Phase 1 never reads it for behavior.
export type ComputeHostShape = 'direct_ssh' | 'scheduler_cluster' | 'bridge_runner'
export type ComputeExecutionMode = 'direct_ssh' | 'slurm'

// Optional connection overrides layered on top of ~/.ssh/config (never credentials/keys). Stored as a
// JSON string in the DB column; parsed to this shape at the repository boundary.
export type SshOverrides = {
  user?: string
  port?: number
  identityFile?: string
}

export type ComputeAuthenticationMode = 'ssh_config' | 'password'
export type ComputeCredentialStatus = 'configured' | 'missing' | 'unavailable'
export type ComputeAuthenticationErrorCode =
  | 'credential_required'
  | 'credential_unavailable'
  | 'secure_storage_unavailable'
  | 'authentication_failed'
  | 'credential_conflict'
  | 'credential_change_blocked_by_jobs'
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'host_unreachable'
  | 'timeout'
  | 'create_failed'
  | 'reset_failed'
  | 'unsupported_auth_configuration'

export type ComputeAuthenticationStatus = Readonly<{
  mode: ComputeAuthenticationMode
  credentialStatus: ComputeCredentialStatus
  revision: number
  lastVerifiedAt: number | undefined
}>

// One GPU model + how many of it a probe found. Part of the probe snapshot, not written in Phase 1.
export type ProbeGpu = {
  type: string
  count: number
}

// Structured probe snapshot (drives Last probe succeeded / Probe failed chrome). Written by the probe in a later
// issue; Phase 1 only reads it back if present.
export type ProbeResult = {
  ok: boolean
  probedAt: string
  exitCode: number | null
  errorTail: string | null
  authenticationCode?: ComputeAuthenticationErrorCode
  authenticationRevision?: number
  os?: string
  cpus?: number
  memMib?: number
  gpus?: ProbeGpu[]
  // Optional recent facts; missing in legacy snapshots means unknown, never current admission.
  sshConnected?: boolean
  commandExecutable?: boolean
  scratchPath?: string
  scratchWritable?: boolean
  // Required Slurm CLI presence plus a successful squeue query; not allocation/submission permission.
  schedulerAvailable?: boolean
  detectedScheduler?: 'slurm' | 'pbs' | 'lsf' | 'none'
}

// Complete details read at the compute-owner boundary. The document is always the exact persisted
// user/agent-authored text; structured resources remain independent probe metadata.
export type ComputeHostDetails = {
  doc: string
  probeResult: ProbeResult | undefined
}

// Who last wrote the details doc — the user (UI edit) or the agent (compute_details, later issue).
export type DetailsAuthor = 'user' | 'agent'

// A registered SSH compute host, normalized for the renderer.
export type ComputeHost = {
  id: string
  // "ssh:<alias>", unique across hosts.
  providerId: string
  displayName: string
  shape: ComputeHostShape
  // Absent only in legacy/in-memory callers; persisted Hosts always project direct_ssh or slurm.
  executionMode?: ComputeExecutionMode
  sshAlias: string
  sshOverrides: SshOverrides | undefined
  // Absent only in legacy/in-memory callers; persisted Hosts always project this status.
  authentication?: ComputeAuthenticationStatus
  scratchRoot: string | undefined
  scratchPinned: boolean
  concurrencyLimit: number | undefined
  probeResult: ProbeResult | undefined
  detailsDoc: string
  detailsUpdatedAt: number | undefined
  detailsUpdatedBy: DetailsAuthor | undefined
  createdAt: number
  updatedAt: number
}

// Compact Agent-facing discovery result. Large knowledge documents, detailed probe data,
// credentials, and renderer-only fields stay behind the dedicated details operation.
export type ComputeHostSummary = {
  provider_id: string
  display_name: string
  shape: ComputeHostShape
  execution_mode: ComputeExecutionMode
  status: 'last_probe_ok' | 'probe_failed' | 'not_probed'
}

export const COMPUTE_HOST_UNAVAILABLE_ERROR_CODE = 'host_unavailable' as const

// Deliberately does not distinguish a missing host from one hidden from the calling Session.
export class ComputeHostUnavailableError extends Error {
  readonly code = COMPUTE_HOST_UNAVAILABLE_ERROR_CODE

  constructor() {
    super('Compute Host is unavailable for this Session.')
    this.name = 'ComputeHostUnavailableError'
  }
}

export type ComputeProbeSnapshot = {
  ok: boolean
  probed_at: string
  exit_code: number | null
  error_tail: string | null
  os?: string
  cpus?: number
  mem_mib?: number
  gpus?: ProbeGpu[]
  detected_scheduler?: ProbeResult['detectedScheduler']
}

export const computeHostSummary = (host: ComputeHost): ComputeHostSummary => ({
  provider_id: host.providerId,
  display_name: host.displayName,
  shape: host.shape,
  execution_mode: host.executionMode ?? 'direct_ssh',
  status:
    host.probeResult === undefined
      ? 'not_probed'
      : host.probeResult.ok
        ? 'last_probe_ok'
        : 'probe_failed'
})

export const computeProbeSnapshot = (
  probeResult: ProbeResult | undefined
): ComputeProbeSnapshot | null =>
  probeResult
    ? {
        ok: probeResult.ok,
        probed_at: probeResult.probedAt,
        exit_code: probeResult.exitCode,
        error_tail: probeResult.errorTail,
        ...(probeResult.os !== undefined ? { os: probeResult.os } : {}),
        ...(probeResult.cpus !== undefined ? { cpus: probeResult.cpus } : {}),
        ...(probeResult.memMib !== undefined ? { mem_mib: probeResult.memMib } : {}),
        ...(probeResult.gpus !== undefined ? { gpus: probeResult.gpus } : {}),
        ...(probeResult.detectedScheduler !== undefined
          ? { detected_scheduler: probeResult.detectedScheduler }
          : {})
      }
    : null

export type ComputeJobRemoteCleanupDisposition = 'pending' | 'cleaned' | 'abandoned'

export type SetComputeJobRemoteCleanupRequest = Readonly<{
  jobId: string
  providerId: string
  projectId: string
  sessionId: string
  disposition: Exclude<ComputeJobRemoteCleanupDisposition, 'pending'>
}>

// Matches the UI character counter and the compute_details cap (32 KiB) in later issues.
export const DETAILS_DOC_MAX_LENGTH = 32768

// The single source of truth for the provider_id convention: "ssh:<alias>".
export const computeProviderId = (alias: string): string => `ssh:${alias.trim()}`

// Job status values, including concurrency-managed queued work.
export type ComputeJobStatus =
  'queued' | 'submitted' | 'running' | 'success' | 'failed' | 'timeout' | 'error'

export type ComputeJobIntegrityIssueCode =
  | 'unknown-status'
  | 'unknown-error-code'
  | 'sensitive-fields-unavailable'
  | 'malformed-remote-handle'
  | 'consumed-without-notification'
  | 'consumed-before-notified'
  | 'notified-before-terminal'

export type ComputeJobIntegrityIssue = Readonly<{
  jobId: string
  sessionId: string
  projectId: string
  code: ComputeJobIntegrityIssueCode
  disposition: 'quarantined' | 'needs-attention' | 'recovery-required'
  rawStatus: string
  rawErrorCode?: string
}>

// Additive logical projection. Existing clients can continue reading `status`; cancellation-aware
// clients use this field to distinguish durable intent from confirmed termination.
export type ComputeJobCancellationStatus = 'cancelling' | 'cancelled'
// A compute job record, normalized for cross-process sharing (main → renderer via IPC, main → repl
// via JSON RPC). Timestamps are epoch milliseconds; JSON columns are parsed at the repository
// boundary to their respective types.
export type ComputeJob = {
  // Read-side scheduling diagnostics; never persisted as a Job status.
  queue_blocked_reason?: ComputeQueueBlockedReason
  job_id: string
  provider_id: string
  shape: string
  execution_mode?: ComputeExecutionMode
  session_id: string
  project_id: string
  status: ComputeJobStatus
  // Additive compatibility diagnostics. Unknown persisted status values keep their raw spelling and
  // are quarantined from lifecycle scans; status remains the legacy closed projection for callers.
  raw_status?: string
  integrity_issues?: ComputeJobIntegrityIssue[]
  needs_attention?: boolean
  cancellation_status?: ComputeJobCancellationStatus
  intent: string
  command: string
  command_hash: string
  environment: string | undefined
  resource_request: string | undefined
  input_manifest: string | undefined
  producer_run_id?: string
  output_manifest: string | undefined
  harvest_config: string | undefined
  timeout_seconds: number | undefined
  remote_workdir: string | undefined
  remote_handle: string | undefined
  // Persisted independently from execution status so local history can outlive remote cleanup.
  remote_cleanup_disposition?: ComputeJobRemoteCleanupDisposition
  exit_code: number | undefined
  stdout_tail: string | undefined
  stderr_tail: string | undefined
  error_code: string | undefined
  // Set when a poll SSH connection fails; job status is NOT changed. Cleared on next successful poll.
  // retry_after_user_action is always true for this condition (design.md §8 boundary 2 / §11).
  // Optional: absent means no poll error has been recorded for this job.
  last_poll_error?: string
  // Phase 3b harvest fields (compute-harvest issue 01). All optional; null until Phase 3b fills them.
  // harvest_error: latest collection error; only harvested_at confirms collection is final.
  harvest_error?: string
  // left_on_remote: JSON string [{uri, size_mb, reason}] — files not downloaded from remote.
  left_on_remote?: string
  // notified_at: epoch ms when the compute_done notification was enqueued to the inbox.
  notified_at?: number
  // notification_consumed_at: epoch ms when wait_for_notification consumed the notification.
  notification_consumed_at?: number
  // Durable automatic-analysis lifecycle. Historical notified/unconsumed rows omit these fields and
  // are interpreted as pending; consumed historical rows remain successful compatibility records.
  created_at: number
  submitted_at: number | undefined
  started_at: number | undefined
  finished_at: number | undefined
  harvested_at: number | undefined
}

// Lightweight job status shape returned by attach_job().status() and the job_status computeCall op.
// Only the fields needed for the agent to track job progress are included.
export type JobStatusResult = {
  // Read-side scheduling diagnostics; never persisted as a Job status.
  queue_blocked_reason?: ComputeQueueBlockedReason
  job_id: string
  scheduler_job_id?: string
  error_code?: string
  last_poll_error?: string
  status: ComputeJobStatus
  // True only when this exact DB snapshot includes the final locally-harvested result. Provider
  // terminality can precede harvest, so callers must not infer finality from status alone.
  result_final: boolean
  cancellation_status?: ComputeJobCancellationStatus
  exit_code: number | undefined
  stdout_tail: string | undefined
  stderr_tail: string | undefined
  remote_workdir: string | undefined
  harvest_error: string | undefined
  // Agent-facing status reads remain pending because this projection omits harvested file lists.
  // Internal and renderer callers omit the marker.
  follow_up_delivery?: 'pending'
}

// Result returned by submit_job (immediate, before dispatch completes). remote_workdir is
// deterministically computed from the job_id before any SSH connection is made.
export type ComputeQueueBlockedReason =
  | 'runtime_stopped'
  | 'session_policy_unavailable'
  | 'session_policy_identity_conflict'
  | 'session_policy_missing'
  | 'session_policy_deleted'
  | 'session_policy_unsupported_version'
  | 'session_policy_invalid'

export type SubmitJobResult = {
  // Read-side scheduling diagnostics; never persisted as a Job status.
  queue_blocked_reason?: ComputeQueueBlockedReason
  job_id: string
  provider_id: string
  status: 'queued' | 'submitted'
  remote_workdir: string
}

export type CancelComputeJobRequest = Readonly<{
  jobId: string
  providerId: string
  sessionId: string
  projectId: string
}>

// Retries only unfinished local result collection for the original, fully scoped Job.
export type RetryComputeJobHarvestRequest = CancelComputeJobRequest

// Error codes for compute jobs (Phase 3a subset of spec §12).
export type ComputeJobErrorCode =
  | 'approval_denied'
  | 'host_unreachable'
  | 'dispatch_failed'
  | 'job_failed'
  | 'timeout'
  | 'process_vanished'
  | 'invalid_resources'
