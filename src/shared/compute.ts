import type {
  ComputeAuthenticationErrorCode,
  ComputeAuthenticationMode,
  ComputeExecutionMode,
  ComputeHost,
  ComputeHostSummary,
  ComputeJobCancellationStatus,
  ComputeJobIntegrityIssue,
  ComputeJobStatus,
  ComputeQueueBlockedReason,
  ComputeJob as ExecutionJob,
  AgentJobStatus,
  AgentJobCancellation,
  JobError,
  SshOverrides
} from '@aipoch/compute'

/** Host-owned evidence and automatic-analysis extensions of the execution snapshot. */
export type ComputeJob = ExecutionJob & {
  file_evidence?: import('./execution-file-evidence').ExecutionFileEvidenceSummary
  analysis_state?: ComputeJobAnalysisState
  analysis_message_id?: string
  analysis_updated_at?: number
}

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
export type ComputePasswordCapability = Readonly<{
  available: boolean
  reason?: 'unsupported_platform' | 'secure_storage_unavailable'
}>

// Canonical Agent-facing catalog entry. Disabled hosts are omitted entirely; an enabled host is
// either an explicit execution target or an available fallback candidate for this Session.
export type AgentComputeHostSummary = ComputeHostSummary & {
  role: 'selected' | 'available'
}

export type KubernetesTargetConfig = Readonly<{
  displayName: string
  context: string
  namespace: string
  image: string
  transferImage: string
  sizeMiB: number
}>
export type KubernetesTarget = KubernetesTargetConfig & Readonly<{ id: string; providerId: string }>

export type HostedTargetConfig = Readonly<{
  displayName: string
  namespace: string
  image: string
  flavor: string
  bucket: string
  timeoutSeconds: number
}>
export type HostedTarget = HostedTargetConfig & Readonly<{ id: string; providerId: string }>

export type RayTargetConfig = Readonly<{
  displayName: string
  endpoint: string
  sharedRoot: string
  remoteRoot: string
  cpus: number
  gpus: number
}>
export type RayTarget = RayTargetConfig & Readonly<{ id: string; providerId: string }>

export type ModalTargetConfig = Readonly<{
  displayName: string
  environmentName: string
  appName: string
  image: string
  cpus: number
  memoryMiB: number
  gpu?: string
}>
export type ModalTarget = ModalTargetConfig & Readonly<{ id: string; providerId: string }>
export type ExternalComputeTarget = KubernetesTarget | HostedTarget | RayTarget | ModalTarget
export type ExternalComputeTargetConfig =
  KubernetesTargetConfig | HostedTargetConfig | RayTargetConfig | ModalTargetConfig

export type ExternalComputeMode = Exclude<ComputeExecutionMode, 'direct_ssh' | 'slurm'>

export const externalComputeMode = (providerId: string): ExternalComputeMode | undefined => {
  if (providerId.startsWith('kubernetes:')) return 'kubernetes'
  if (providerId.startsWith('hf-jobs:')) return 'hugging_face_jobs'
  if (providerId.startsWith('ray:')) return 'ray_jobs'
  if (providerId.startsWith('modal:')) return 'modal_sandbox'
  return undefined
}

export const isComputeProviderId = (value: unknown): value is string =>
  typeof value === 'string' &&
  ((value.startsWith('ssh:') && value.length > 4) ||
    /^(?:kubernetes|hf-jobs|ray|modal):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value
    ))

// Add-form payload. displayName defaults to the alias; detailsDoc seeds the notes (author = user).
export type CreateComputeHostRequest = {
  sshAlias: string
  displayName?: string
  detailsDoc?: string
  sshOverrides?: SshOverrides
  executionMode?: ComputeExecutionMode
}

export type SetComputeHostExecutionModeRequest = Readonly<{
  providerId: string
  executionMode: ComputeExecutionMode
}>

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
  // Absent overrides in ssh_config mode inherit User and Port from ~/.ssh/config.
  username?: string
  port?: number
  identityFile?: string
  password?: string
}>

export type ChangeComputeHostAuthenticationResult =
  | Readonly<{ ok: true; host: ComputeHost }>
  | Readonly<{ ok: false; errorCode: ComputeAuthenticationErrorCode }>

export type DeleteComputeHostRequest = {
  providerId: string
}

export type ManualStagedCleanup =
  | Readonly<{ kind: 'hugging_face_jobs'; bucket: string; prefix: string }>
  | Readonly<{ kind: 'modal_sandbox'; environmentName: string; volumeId: string }>

export type ComputeHostDeletionBlocker = Readonly<{
  manualStagedCleanup?: ManualStagedCleanup
  modalCreationUnconfirmed?: true
  jobId: string
  projectId: string
  sessionId: string
  status: ComputeJobStatus
  cancellationStatus?: ComputeJobCancellationStatus
  errorCode?: string
  // Optional for additive compatibility; absence fails closed for terminal cleanup.
  harvested?: boolean
  intent: string
  createdAt: number
}>

export type ComputeHostDeletionStatus = Readonly<{
  blockedByJobs: boolean
  // Optional for additive compatibility with older desktop/web clients.
  blockingJobs?: ComputeHostDeletionBlocker[]
}>

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
    | 'invalid_resources'
    | ComputeAuthenticationErrorCode
  message: string
  retry_after_user_action: boolean
}

// Broker-owned durable scopes. Legacy clients may still submit `conversation`; transport adapters
// normalize it to `session` before the decision enters the broker.
export type ComputeApprovalScope = 'once' | 'session' | 'project' | 'global'
export type ComputeApprovalDecision = ComputeApprovalScope | 'deny'
export type ComputeApprovalDecisionInput = ComputeApprovalDecision | 'conversation'

export const normalizeComputeApprovalDecision = (
  decision: ComputeApprovalDecisionInput
): ComputeApprovalDecision => (decision === 'conversation' ? 'session' : decision)

export type ComputeApprovalOperation = 'call_command' | 'submit_job' | 'download'

type ComputeApprovalRequestBase = {
  provider_id: string
  provider_name: string
  shape: string
  intent: string
  // Transient approval disclosure; this is never persisted as Compute Job state.
  willPersistUnencrypted?: boolean
}

// Operation-specific disclosure broadcast from main to the renderer. The discriminator keeps a
// malformed optional-field bag from silently presenting the wrong authorization object.
export type ComputeApprovalRequestInfo = ComputeApprovalRequestBase &
  (
    | {
        operation: 'call_command'
        command_preview: string
        command_full: string
      }
    | {
        operation: 'download'
        remote_path: string
      }
    | {
        operation: 'submit_job'
        command_preview: string
        command_full: string
        kubernetes?: {
          context: string
          namespace: string
          endpoint: string
          image: string
          transferImage: string
          sizeMiB: number
          inputFiles: { source: string; destination: string; sizeBytes: number; sha256: string }[]
          outputManifest?: string
          harvestConfig?: string
        }
        hosted?: {
          namespace: string
          image: string
          flavor: string
          bucket: string
          runId: string
          rateMicroUsdPerMinute: number
          inputFiles: { source: string; destination: string; sizeBytes: number; sha256: string }[]
          outputManifest?: string
          harvestConfig?: string
        }
        ray?: {
          endpoint: string
          sessionName: string
          cpus: number
          gpus: number
          sharedRoot: string
          remoteRoot: string
          inputFiles: { source: string; destination: string; sizeBytes: number; sha256: string }[]
          outputManifest?: string
          harvestConfig?: string
        }
        modal?: {
          environmentName: string
          appName: string
          appId: string
          image: string
          cpus: number
          memoryMiB: number
          gpu?: string
          inputFiles: { source: string; destination: string; sizeBytes: number; sha256: string }[]
          outputManifest?: string
          harvestConfig?: string
        }
        execution_mode?: ComputeExecutionMode
        environment?: string
        inputs_summary?: string
        resources?: string
        timeout_seconds: number
        remote_workdir: string
      }
  )

export type ComputeApprovalRequest = ComputeApprovalRequestInfo & {
  id: string
  // Renderer-only ownership hint used to defer this dialog while its Session has Side chat open.
  // Main's approval broker remains authoritative and keeps the request pending.
  session_id?: string
}

export type ComputeJobAnalysisState = 'dispatched' | 'succeeded' | 'failed' | 'cancelled'

export type ComputeJobAnalysisTransition = Readonly<{
  sessionId: string
  jobIds: string[]
  messageId: string
  state: ComputeJobAnalysisState
}>

// Full job result shape returned by attach_job().result() (spec §11.4, design §9).
// File lists are workspace-relative paths (e.g. "hpc/<jobId>/featured/out.result").
// In non-terminal states or before harvest completes, file fields are empty arrays.
export type JobResult = {
  // Read-side scheduling diagnostics; never persisted as a Job status.
  queue_blocked_reason?: ComputeQueueBlockedReason
  job_id: string
  // Notebook Run that submitted this job. Pass it as producerRunId when publishing a harvested
  // local file so cross-turn provenance resolves to the actual producing execution.
  producer_run_id?: string
  scheduler_job_id?: string
  error?: JobError
  last_poll_error?: string
  status: AgentJobStatus
  // Mirrors the exact snapshot returned by this read; avoids a second-read TOCTOU when deciding
  // whether an Agent has observed the durable final result.
  result_final: boolean
  cancellation?: AgentJobCancellation
  exit_code: number | undefined
  // Absolute canonical Notebook Session root. Join workspace-relative output paths to this root
  // before passing a harvested file to write_artifact_file as an absolute localPath.
  local_output_root?: string
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
  harvest_error: string | undefined
  // See JobStatusResult.follow_up_delivery. `suppressed` means this read won; `committed` means
  // automatic delivery had already crossed its dispatch fence.
  follow_up_delivery?: 'pending' | 'suppressed' | 'committed'
}

// Lightweight job summary returned by the renderer IPC `compute:jobs:list` and broadcast via
// `compute:job-updated`. Contains the fields the UI needs for badge + job feed display. The host
// display_name is denormalized here so the renderer never needs a separate host lookup.
// Shape defined in design.md §9 and issue 05 Interfaces.
// Phase 3b: notification payload fields (spec §11.3) are embedded here so the renderer can
// display the done card and decide whether to trigger an analysis turn (issue 05/07).
export type JobSummary = {
  manualStagedCleanup?: ManualStagedCleanup
  // Read-side scheduling diagnostics; never persisted as a Job status.
  queue_blocked_reason?: ComputeQueueBlockedReason
  job_id: string
  scheduler_job_id?: string
  provider_id: string
  // Human-readable host name, denormalized from ComputeHost.displayName at query time.
  display_name: string
  shape: string
  execution_mode?: ComputeExecutionMode
  // Session the job was submitted in — needed for the renderer store to filter by active session.
  session_id: string
  project_id?: string
  status: ComputeJobStatus
  raw_status?: string
  integrity_issues?: ComputeJobIntegrityIssue[]
  needs_attention?: boolean
  cancellation_status?: ComputeJobCancellationStatus
  cancellation_error?: JobError
  cancellation_revision?: number
  intent: string
  created_at: number
  started_at: number | undefined
  finished_at: number | undefined
  exit_code: number | undefined
  error_code: string | undefined
  error_message?: string
  last_poll_error?: string
  remote_workdir: string | undefined
  stdout_tail: string | undefined
  stderr_tail: string | undefined
  // Phase 3b: inbox timestamps — renderer uses these to decide whether to start an analysis turn.
  notified_at: number | undefined
  notification_consumed_at: number | undefined
  analysis_state?: ComputeJobAnalysisState
  analysis_message_id?: string
  analysis_updated_at?: number
  // Phase 3b: compute_done payload fields (spec §11.3). Present when notified_at is set.
  featured_files?: string[]
  hidden_files?: string[]
  featured_file_count?: number
  left_on_remote_count?: number
  left_on_remote?: Array<{ uri: string; size_mb: number; reason: string }>
  harvest_error?: string
  // A terminal provider status can precede local harvest. Direct Agent reads may only acknowledge
  // delivery after this marker is present, when the returned file/result projection is final.
  harvested_at?: number
  // Read-side marker derived from the durable Agent Result Delivery ledger. When present, the
  // renderer must not start the legacy completion-analysis path for this Job.
  result_delivery_path?: 'agent-result-delivery'
}

// The existing per-Session feed supports workspace history. The non-terminal variant is a bounded
// cross-Session query used to hydrate renderer-lifetime activity after startup or recovery.
export type ComputeJobsListFilter =
  | Readonly<{ sessionId: string; status?: string[] }>
  | Readonly<{ nonTerminal: true }>
  | Readonly<{ projectId: string; since: number }>

export type ComputeJobsPendingNotificationFilter = string | Readonly<{ allSessions: true }>

type ComputeOutputLocator = { projectId: string; sessionId: string; jobId: string; path: string }
const computeOutputPrefix = 'compute-output:v1:'
// Archive paths cross desktop platforms and must never address a device, stream or aliased directory.
const reservedWindowsSegment = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i
// eslint-disable-next-line no-control-regex
const unsafeOutputCharacters = /[/\\:\x00-\x1f\x7f]/u
const safeOutputSegment = (part: string): boolean =>
  !!part &&
  !/[. ]$/.test(part) &&
  !reservedWindowsSegment.test(part) &&
  !unsafeOutputCharacters.test(part)

export function createComputeOutputPreviewKey(locator: ComputeOutputLocator): string {
  const { projectId, sessionId, jobId, path } = locator
  if (
    ![projectId, sessionId, jobId].every(
      (part) =>
        typeof part === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) &&
        safeOutputSegment(part)
    ) ||
    typeof path !== 'string'
  )
    throw new Error('Invalid compute output reference.')
  const parts = path.split('/')
  if (
    parts.length < 4 ||
    parts[0] !== 'hpc' ||
    parts[1] !== jobId ||
    !['featured', 'hidden'].includes(parts[2]) ||
    !parts.every(safeOutputSegment)
  )
    throw new Error('Invalid compute output path.')
  return computeOutputPrefix + [projectId, sessionId, ...parts].map(encodeURIComponent).join('/')
}
export function parseComputeOutputPreviewKey(key: string): ComputeOutputLocator {
  if (typeof key !== 'string' || !key.startsWith(computeOutputPrefix) || key.length > 32768)
    throw new Error('Invalid compute output reference.')
  const [projectId, sessionId, ...parts] = key
    .slice(computeOutputPrefix.length)
    .split('/')
    .map(decodeURIComponent)
  const locator = { projectId, sessionId, jobId: parts[1], path: parts.join('/') }
  if (createComputeOutputPreviewKey(locator) !== key)
    throw new Error('Noncanonical compute output reference.')
  return locator
}
