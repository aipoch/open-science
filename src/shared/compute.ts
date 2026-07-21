// Shared compute-host types crossing the main <-> renderer IPC boundary.
//
// Phase 1 (issue 01) covers host record management only: the SQLite/Prisma layer owns ComputeHost
// rows (see src/main/compute). Probe/SSH execution and approvals land in later issues. Timestamps are
// normalized to epoch milliseconds at the repository boundary so the renderer treats them like other
// persisted timestamps. No credentials are ever stored — only an ssh alias and optional overrides.

// Host topology, inferred by probe in a later issue. Persisted so downstream issues can branch on it;
// Phase 1 never reads it for behavior.
export type ComputeHostShape = 'direct_ssh' | 'scheduler_cluster' | 'bridge_runner'

// Optional connection overrides layered on top of ~/.ssh/config (never credentials/keys). Stored as a
// JSON string in the DB column; parsed to this shape at the repository boundary.
export type SshOverrides = {
  user?: string
  port?: number
  identityFile?: string
}

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
  os?: string
  cpus?: number
  memMib?: number
  gpus?: ProbeGpu[]
  detectedScheduler?: 'slurm' | 'pbs' | 'lsf' | 'none'
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

// Add-form payload. displayName defaults to the alias; detailsDoc seeds the notes (author = user).
export type CreateComputeHostRequest = {
  sshAlias: string
  displayName?: string
  detailsDoc?: string
  sshOverrides?: SshOverrides
}

export type DeleteComputeHostRequest = {
  providerId: string
}

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
  error_code: 'host_unreachable' | 'timeout' | 'approval_denied'
  message: string
  retry_after_user_action: boolean
}

// The three approval scopes available in the compute approval card. 'deny' is the negative outcome.
// No 'global' scope per design.md §6 — deliberately omitted.
export type ComputeApprovalScope = 'once' | 'conversation' | 'project'
export type ComputeApprovalDecision = ComputeApprovalScope | 'deny'

// Approval request broadcast from main to the renderer for a compute:call_command invocation.
// provider_name is the human-readable display name; shape is the host topology string.
// For call_command: command_preview + command_full are set.
// For download: remote_path is set instead of command fields.
// For submit_job (Phase 3a): command_preview + command_full + submit_job-specific fields are set.
export type ComputeApprovalRequest = {
  id: string
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
}

// The job status values for the Phase 3a state machine. 'queued' is reserved for Phase 3c.
export type ComputeJobStatus = 'submitted' | 'running' | 'success' | 'failed' | 'timeout' | 'error'

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

// Result returned by submit_job (immediate, before dispatch completes). remote_workdir is
// deterministically computed from the job_id before any SSH connection is made.
export type SubmitJobResult = {
  job_id: string
  provider_id: string
  status: 'submitted'
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
export type JobSummary = {
  job_id: string
  provider_id: string
  // Human-readable host name, denormalized from ComputeHost.displayName at query time.
  display_name: string
  shape: string
  status: ComputeJobStatus
  intent: string
  created_at: number
  started_at: number | undefined
  finished_at: number | undefined
  exit_code: number | undefined
  error_code: string | undefined
  remote_workdir: string | undefined
  stdout_tail: string | undefined
  stderr_tail: string | undefined
}
