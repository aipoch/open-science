import type { ComputeJobIntegrityIssue, ComputeJobStatus } from '../../shared/compute'

const KNOWN_STATUSES = new Set<ComputeJobStatus>([
  'queued',
  'submitted',
  'running',
  'success',
  'failed',
  'timeout',
  'error'
])

const KNOWN_ERROR_CODES = new Set([
  'approval_denied',
  'host_unreachable',
  'dispatch_failed',
  'job_failed',
  'timeout',
  'process_vanished',
  'credential_required',
  'credential_unavailable',
  'secure_storage_unavailable',
  'authentication_failed',
  'credential_conflict',
  'credential_change_blocked_by_jobs',
  'host_key_unknown',
  'host_key_changed',
  'create_failed',
  'reset_failed',
  'unsupported_auth_configuration'
])

const TERMINAL_STATUSES = new Set<ComputeJobStatus>(['success', 'failed', 'timeout', 'error'])

type IntegrityRow = Readonly<{
  id: string
  sessionId: string
  projectId: string
  status: string
  errorCode: string | null
  remoteWorkdir: string | null
  remoteHandle: string | null
  notifiedAt: Date | null
  notificationConsumedAt: Date | null
}>

type IntegritySensitiveProjection = Readonly<{
  remoteWorkdir: string | null
  remoteHandle: string | null
  unavailable?: boolean
}>

const issue = (
  row: IntegrityRow,
  value: Omit<ComputeJobIntegrityIssue, 'jobId' | 'sessionId' | 'projectId' | 'rawStatus'>
): ComputeJobIntegrityIssue => ({
  jobId: row.id,
  sessionId: row.sessionId,
  projectId: row.projectId,
  rawStatus: row.status,
  ...value
})

const remoteHandleIsComplete = (projection: IntegritySensitiveProjection): boolean => {
  if (!projection.remoteHandle) return false
  try {
    const handle = JSON.parse(projection.remoteHandle) as Record<string, unknown> | null
    const workdir = projection.remoteWorkdir
    return Boolean(
      handle &&
      Number.isSafeInteger(handle.pid) &&
      Number(handle.pid) > 1 &&
      typeof workdir === 'string' &&
      workdir.length > 0 &&
      handle.workdir === workdir &&
      handle.exit_code_path === `${workdir}/exit_code` &&
      handle.stdout_path === `${workdir}/stdout` &&
      handle.stderr_path === `${workdir}/stderr`
    )
  } catch {
    return false
  }
}

// Classifies raw persisted values before they are projected through the closed runtime status type.
// This function is deliberately detect-only: submitted/running handle recovery remains owned by the
// poller, which repairs only after the remote workdir + job.pid + cwd witness proves ownership.
export const classifyComputeJobIntegrity = (
  row: IntegrityRow,
  sensitiveProjection: IntegritySensitiveProjection = {
    remoteWorkdir: row.remoteWorkdir,
    remoteHandle: row.remoteHandle
  }
): ComputeJobIntegrityIssue[] => {
  const issues: ComputeJobIntegrityIssue[] = []
  const knownStatus = KNOWN_STATUSES.has(row.status as ComputeJobStatus)

  if (!knownStatus) {
    issues.push(issue(row, { code: 'unknown-status', disposition: 'quarantined' }))
  }
  if (row.errorCode !== null && !KNOWN_ERROR_CODES.has(row.errorCode)) {
    issues.push(
      issue(row, {
        code: 'unknown-error-code',
        disposition: 'needs-attention',
        rawErrorCode: row.errorCode
      })
    )
  }
  if (sensitiveProjection.unavailable) {
    issues.push(
      issue(row, { code: 'sensitive-fields-unavailable', disposition: 'needs-attention' })
    )
  }
  if (
    knownStatus &&
    (row.status === 'submitted' || row.status === 'running') &&
    !sensitiveProjection.unavailable &&
    !remoteHandleIsComplete(sensitiveProjection)
  ) {
    issues.push(issue(row, { code: 'malformed-remote-handle', disposition: 'recovery-required' }))
  }
  if (row.notificationConsumedAt !== null && row.notifiedAt === null) {
    issues.push(issue(row, { code: 'consumed-without-notification', disposition: 'quarantined' }))
  } else if (
    row.notificationConsumedAt !== null &&
    row.notifiedAt !== null &&
    row.notificationConsumedAt.getTime() < row.notifiedAt.getTime()
  ) {
    issues.push(issue(row, { code: 'consumed-before-notified', disposition: 'quarantined' }))
  }
  if (
    row.notifiedAt !== null &&
    knownStatus &&
    !TERMINAL_STATUSES.has(row.status as ComputeJobStatus)
  ) {
    issues.push(issue(row, { code: 'notified-before-terminal', disposition: 'quarantined' }))
  }

  return issues
}

export const isKnownComputeJobStatus = (value: string): value is ComputeJobStatus =>
  KNOWN_STATUSES.has(value as ComputeJobStatus)

export const isTerminalComputeJobStatus = (value: string): value is ComputeJobStatus =>
  isKnownComputeJobStatus(value) && TERMINAL_STATUSES.has(value)
