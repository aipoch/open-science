// Shared compute-host types crossing the main <-> renderer IPC boundary.
//
// Phase 1 (issue 01) covers host record management only: the SQLite/Prisma layer owns ComputeHost
// rows (see src/main/compute). Probe/SSH execution and approvals land in later issues. Timestamps are
// normalized to epoch milliseconds at the repository boundary so the renderer treats them like other
// persisted timestamps. No credentials are ever stored — only an ssh alias and optional overrides.

// Host topology, inferred by probe in a later issue. Persisted so downstream issues can branch on it;
// Phase 1 never reads it for behavior.
export type ComputeHostShape = 'direct_ssh' | 'scheduler_cluster' | 'bridge_runner'

export type ComputeHostPreferenceValidationErrorCode = 'invalid_provider_id' | 'host_not_found'

export class ComputeHostPreferenceValidationError extends Error {
  constructor(
    readonly code: ComputeHostPreferenceValidationErrorCode,
    readonly providerId: string
  ) {
    super(
      code === 'invalid_provider_id'
        ? `Invalid Compute Host provider id: ${providerId}`
        : `Compute Host not found: ${providerId}`
    )
    this.name = 'ComputeHostPreferenceValidationError'
  }
}

// Optional connection overrides layered on top of ~/.ssh/config (never credentials/keys). Stored as a
// JSON string in the DB column; parsed to this shape at the repository boundary.
export type SshOverrides = {
  user?: string
  port?: number
  identityFile?: string
}

export type ComputeAuthenticationMode = 'ssh_config' | 'password'
export type ComputeCredentialStatus = 'configured' | 'missing' | 'unavailable'
export type ComputePasswordCapability = Readonly<{
  available: boolean
  reason?: 'unsupported_platform' | 'secure_storage_unavailable'
}>
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

// Structured probe snapshot (drives Connected / Probe failed chrome). Written by the probe in a later
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
  detectedScheduler?: 'slurm' | 'pbs' | 'lsf' | 'none'
}

// Complete details read at the compute-owner boundary. Renderer IPC deliberately projects only
// doc + isSkeleton, while agent RPC separately serializes probeResult to its public wire shape.
export type ComputeHostDetails = {
  doc: string
  isSkeleton: boolean
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
  status: 'connected' | 'probe_failed' | 'not_probed'
}

// Canonical Agent-facing catalog entry. Disabled hosts are omitted entirely; an enabled host is
// either an explicit execution target or an available fallback candidate for this Session.
export type AgentComputeHostSummary = ComputeHostSummary & {
  role: 'selected' | 'available'
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
  status:
    host.probeResult === undefined
      ? 'not_probed'
      : host.probeResult.ok
        ? 'connected'
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

// Add-form payload. displayName defaults to the alias; detailsDoc seeds the notes (author = user).
export type CreateComputeHostRequest = {
  sshAlias: string
  displayName?: string
  detailsDoc?: string
  sshOverrides?: SshOverrides
}

export type CreatePasswordComputeHostRequest = Omit<CreateComputeHostRequest, 'sshOverrides'> & {
  authenticationMode: 'password'
  username: string
  port: number
  password: string
  operationId: string
}

export type CreatePasswordComputeHostResult =
  | Readonly<{ ok: true; host: ComputeHost }>
  | Readonly<{ ok: false; errorCode: ComputeAuthenticationErrorCode }>

export type ResetPasswordComputeHostRequest = Readonly<{
  providerId: string
  password: string
  operationId: string
  expectedAuthenticationRevision: number
}>

export type ResetPasswordComputeHostResult =
  | Readonly<{ ok: true; host: ComputeHost }>
  | Readonly<{ ok: false; errorCode: ComputeAuthenticationErrorCode }>

export type ChangeComputeHostAuthenticationRequest = Readonly<{
  providerId: string
  expectedRevision: number
  operationId: string
  authenticationMode: ComputeAuthenticationMode
  // Absent in ssh_config mode: the User (and port fallback) then come from ~/.ssh/config.
  username?: string
  port: number
  identityFile?: string
  password?: string
}>

export type ChangeComputeHostAuthenticationResult =
  | Readonly<{ ok: true; host: ComputeHost }>
  | Readonly<{ ok: false; errorCode: ComputeAuthenticationErrorCode }>

export type DeleteComputeHostRequest = {
  providerId: string
}

export type ComputeHostDeletionStatus = Readonly<{ blockedByJobs: boolean }>

// Matches the UI character counter and the compute_details cap (32 KiB) in later issues.
export const DETAILS_DOC_MAX_LENGTH = 32768

// The single source of truth for the provider_id convention: "ssh:<alias>".
export const computeProviderId = (alias: string): string => `ssh:${alias.trim()}`

// Result returned by call_command / computeCall RPC. exit_code is null when the process was killed
// (e.g. timeout). truncated=true means at least one of stdout/stderr was capped at 64 KB.
export type ExecResult = {
  exit_code: number | null
  stdout: string
  stderr: string
  truncated: boolean
}

// Structured error payload for call_command failures. error_code identifies the failure class;
// retry_after_user_action=true means the system will NOT retry automatically — the user must fix
// an external condition first (e.g. SSH connectivity).
export type ComputeCallError = {
  error_code:
    | 'host_unreachable'
    | 'timeout'
    | 'approval_denied'
    | 'queue_full'
    | ComputeAuthenticationErrorCode
  message: string
  retry_after_user_action: boolean
}

// Broker-owned durable scopes. `conversation` remains the wire value for compatibility, but is
// presented and persisted as a Session grant; Agent ACP adapters still receive only allow-once.
export type ComputeApprovalScope = 'once' | 'conversation' | 'project' | 'global'
export type ComputeApprovalDecision = ComputeApprovalScope | 'deny'

// Approval request broadcast from main to the renderer for a compute:call_command invocation.
// provider_name is the human-readable display name; shape is the host topology string.
// For call_command: command_preview + command_full are set.
// For download: remote_path is set instead of command fields.
// For submit_job (Phase 3a): command_preview + command_full + submit_job-specific fields are set.
export type ComputeApprovalRequest = {
  id: string
  // Renderer-only ownership hint used to defer this dialog while its Session has Side chat open.
  // Main's approval broker remains authoritative and keeps the request pending.
  session_id?: string
  provider_id: string
  provider_name: string
  shape: string
  intent: string
  // call_command fields (present for op=call_command).
  command_preview?: string
  command_full?: string
  // download field (present for op=download).
  remote_path?: string
  // submit_job fields (present for op=submit_job, Phase 3a).
  inputs_summary?: string
  resources?: string
  timeout_seconds?: number
  remote_workdir?: string
  // Transient approval disclosure; this is never persisted as Compute Job state.
  willPersistUnencrypted?: boolean
}

// Job status values, including concurrency-managed queued work.
export type ComputeJobStatus =
  'queued' | 'submitted' | 'running' | 'success' | 'failed' | 'timeout' | 'error'

// A compute job record, normalized for cross-process sharing (main → renderer via IPC, main → repl
// via JSON RPC). Timestamps are epoch milliseconds; JSON columns are parsed at the repository
// boundary to their respective types.
export type ComputeJob = {
  job_id: string
  provider_id: string
  shape: string
  session_id: string
  project_id: string
  status: ComputeJobStatus
  intent: string
  command: string
  command_hash: string
  environment: string | undefined
  resource_request: string | undefined
  input_manifest: string | undefined
  output_manifest: string | undefined
  harvest_config: string | undefined
  timeout_seconds: number | undefined
  remote_workdir: string | undefined
  remote_handle: string | undefined
  exit_code: number | undefined
  stdout_tail: string | undefined
  stderr_tail: string | undefined
  error_code: string | undefined
  // Set when a poll SSH connection fails; job status is NOT changed. Cleared on next successful poll.
  // retry_after_user_action is always true for this condition (design.md §8 boundary 2 / §11).
  // Optional: absent means no poll error has been recorded for this job.
  last_poll_error?: string
  // Phase 3b harvest fields (compute-harvest issue 01). All optional; null until Phase 3b fills them.
  // harvest_error: non-null means the harvest completed but with errors (harvest_failed outcome).
  harvest_error?: string
  // left_on_remote: JSON string [{uri, size_mb, reason}] — files not downloaded from remote.
  left_on_remote?: string
  // notified_at: epoch ms when the compute_done notification was enqueued to the inbox.
  notified_at?: number
  // notification_consumed_at: epoch ms when wait_for_notification consumed the notification.
  notification_consumed_at?: number
  created_at: number
  submitted_at: number | undefined
  started_at: number | undefined
  finished_at: number | undefined
  harvested_at: number | undefined
}

// Lightweight job status shape returned by attach_job().status() and the job_status computeCall op.
// Only the fields needed for the agent to track job progress are included.
export type JobStatusResult = {
  job_id: string
  status: ComputeJobStatus
  exit_code: number | undefined
  stdout_tail: string | undefined
  stderr_tail: string | undefined
  remote_workdir: string | undefined
}

// Full job result shape returned by attach_job().result() (spec §11.4, design §9).
// File lists are workspace-relative paths (e.g. "hpc/<jobId>/featured/out.result").
// In non-terminal states or before harvest completes, file fields are empty arrays.
export type JobResult = {
  job_id: string
  status: ComputeJobStatus
  exit_code: number | undefined
  // Workspace-relative paths of featured output files (hpc/<jobId>/featured/*).
  featured_files: string[]
  // Workspace-relative paths of hidden output files (hpc/<jobId>/hidden/*).
  hidden_files: string[]
  // featured_files + hidden_files combined, featured first.
  output_files: string[]
  // Files not downloaded from the remote workdir (JSON [{uri,size_mb,reason}]).
  left_on_remote: Array<{ uri: string; size_mb: number; reason: string }>
  // Remote workdir path; preserved even on harvest_failed so the user can manually retrieve files.
  remote_workdir: string | undefined
  stdout_tail: string | undefined
  stderr_tail: string | undefined
}

// Result returned by submit_job (immediate, before dispatch completes). remote_workdir is
// deterministically computed from the job_id before any SSH connection is made.
export type SubmitJobResult = {
  job_id: string
  provider_id: string
  status: 'queued' | 'submitted'
  remote_workdir: string
}

// Error codes for compute jobs (Phase 3a subset of spec §12).
export type ComputeJobErrorCode =
  | 'approval_denied'
  | 'host_unreachable'
  | 'dispatch_failed'
  | 'job_failed'
  | 'timeout'
  | 'process_vanished'

// Lightweight job summary returned by the renderer IPC `compute:jobs:list` and broadcast via
// `compute:job-updated`. Contains the fields the UI needs for badge + job feed display. The host
// display_name is denormalized here so the renderer never needs a separate host lookup.
// Shape defined in design.md §9 and issue 05 Interfaces.
// Phase 3b: notification payload fields (spec §11.3) are embedded here so the renderer can
// display the done card and decide whether to trigger an analysis turn (issue 05/07).
export type JobSummary = {
  job_id: string
  provider_id: string
  // Human-readable host name, denormalized from ComputeHost.displayName at query time.
  display_name: string
  shape: string
  // Session the job was submitted in — needed for the renderer store to filter by active session.
  session_id: string
  status: ComputeJobStatus
  intent: string
  created_at: number
  started_at: number | undefined
  finished_at: number | undefined
  exit_code: number | undefined
  error_code: string | undefined
  last_poll_error?: string
  remote_workdir: string | undefined
  stdout_tail: string | undefined
  stderr_tail: string | undefined
  // Phase 3b: inbox timestamps — renderer uses these to decide whether to start an analysis turn.
  notified_at: number | undefined
  notification_consumed_at: number | undefined
  // Phase 3b: compute_done payload fields (spec §11.3). Present when notified_at is set.
  featured_files?: string[]
  featured_file_count?: number
  left_on_remote_count?: number
  left_on_remote?: Array<{ uri: string; size_mb: number; reason: string }>
  harvest_error?: string
}

// The existing per-Session feed supports workspace history. The non-terminal variant is a bounded
// cross-Session query used to hydrate renderer-lifetime activity after startup or recovery.
export type ComputeJobsListFilter =
  Readonly<{ sessionId: string; status?: string[] }> | Readonly<{ nonTerminal: true }>

export type ComputeJobsPendingNotificationFilter = string | Readonly<{ allSessions: true }>
