import type {
  ComputeHost,
  ComputeJob,
  ComputeJobIntegrityIssue,
  ComputeJobRemoteCleanupDisposition,
  ComputeJobStatus,
  JobError
} from './model'

export type ComputeJobOwner = Readonly<{
  projectId: string
  sessionId?: string
}>

export type ComputeJobSessionOwner = Readonly<{
  projectId: string
  sessionId: string
}>

export type UpdateJobRequest = {
  status?: ComputeJobStatus
  remoteHandle?: string
  remoteWorkdir?: string
  exitCode?: number | null
  stdoutTail?: string | null
  stderrTail?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  // lastPollError is set when SSH connectivity fails during polling (not a job failure).
  lastPollError?: string | null
  // retryAfterUserAction is an in-memory hint; always true for poll connectivity errors.
  // It is NOT persisted to the DB but is carried in the update call so callers can surface
  // the retry_after_user_action semantic without a separate DB column.
  retryAfterUserAction?: boolean
  submittedAt?: Date
  startedAt?: Date
  finishedAt?: Date
  // Phase 3b harvest fields (compute-harvest issue 01).
  harvestedAt?: Date
  harvestError?: string | null
  leftOnRemote?: string | null
  notifiedAt?: Date | null
  notificationConsumedAt?: Date | null
}

export interface ComputeJobRepository {
  beginOwnerDeletion(owner: ComputeJobOwner): Promise<void>
  abortOwnerDeletion(owner: ComputeJobOwner): Promise<void>
  findByOwner(owner: ComputeJobOwner): Promise<ComputeJob[]>
  listOwners(): Promise<ComputeJobSessionOwner[]>
  deleteByOwner(owner: ComputeJobOwner): Promise<void>
  get(jobId: string): Promise<ComputeJob | null>
  findNonTerminal(): Promise<ComputeJob[]>
  findTerminalUnharvested(): Promise<ComputeJob[]>
  findNotificationReadyUnnotified(): Promise<ComputeJob[]>
  update(jobId: string, updates: UpdateJobRequest): Promise<ComputeJob>
  updateIfStatus(
    jobId: string,
    expectedStatuses: readonly ComputeJobStatus[],
    updates: UpdateJobRequest
  ): Promise<ComputeJob | null>
  // Preserve authoritative no-launch evidence for the exact submitted dispatch snapshot,
  // including while owner deletion fences status transitions. Never changes status or claims.
  recordDispatchNoLaunch(expectedJob: ComputeJob): Promise<void>
  recordCancellationHandle(jobId: string, remoteHandle: string): Promise<void>
  recordRemoteCleanupStopped(job: ComputeJob, workdir: string): Promise<void>
  findSessionConcurrencyJobs(
    sessionId: string
  ): Promise<Pick<ComputeJob, 'status' | 'provider_id'>[]>
  settleRemoteCleanup(
    request: Readonly<{
      jobId: string
      providerId: string
      projectId: string
      sessionId: string
      disposition: Exclude<ComputeJobRemoteCleanupDisposition, 'pending'>
    }>
  ): Promise<ComputeJob>
  scanIntegrity(): Promise<ComputeJobIntegrityIssue[]>
  countActiveBySession(sessionId: string): Promise<number>
  countActiveByProvider(providerId: string): Promise<number>
  countQueuedJobs(): Promise<number>
  findQueuedJobs(): Promise<ComputeJob[]>
}

export interface ComputeHostRepository {
  get(providerId: string): Promise<ComputeHost | null>
  updateConcurrencyLimit(providerId: string, concurrencyLimit: number): Promise<void>
}

export type ComputeJobOperationKind = 'cancel'

export type ComputeJobOperationPhase = 'active' | 'settled'

export type ComputeJobOperationOutcome = 'fulfilled' | 'superseded' | 'failed'

export type ComputeJobOperationRecord = Readonly<{
  id: string
  jobId: string
  kind: ComputeJobOperationKind
  phase: ComputeJobOperationPhase
  outcome: ComputeJobOperationOutcome | null
  revision: number
  attemptCount: number
  eligibleAt: Date | null
  claimToken: string | null
  claimExpiresAt: Date | null
  createdAt: Date
  settledAt: Date | null
  updatedAt: Date
  errorCode?: string | null
  errorMessage?: string | null
}>

export type ComputeJobOperationSettlement = Readonly<{
  outcome: 'superseded' | 'failed'
  job?: UpdateJobRequest
  error?: JobError
}>

export type ComputeJobOperationScope = Readonly<{
  projectId: string
  sessionId: string
  providerId: string
}>

export type ClaimedComputeJobOperation = Readonly<{
  operation: ComputeJobOperationRecord
  jobId: string
}>

export interface ComputeJobOperationRepository {
  get(jobId: string, kind: ComputeJobOperationKind): Promise<ComputeJobOperationRecord | null>
  request(
    jobId: string,
    kind: ComputeJobOperationKind,
    scope: ComputeJobOperationScope,
    now: Date
  ): Promise<
    | { found: false }
    | { found: true; jobStatus: ComputeJobStatus; record: ComputeJobOperationRecord }
  >
  claimNext(
    kind: ComputeJobOperationKind,
    now: Date,
    leaseMs: number,
    claimToken: string
  ): Promise<ClaimedComputeJobOperation | null>
  fulfill(
    claim: ClaimedComputeJobOperation,
    now: Date,
    remoteWorkdirAbsent?: boolean
  ): Promise<boolean>
  retry(claim: ClaimedComputeJobOperation, now: Date, eligibleAt: Date): Promise<boolean>
  settle(
    claim: ClaimedComputeJobOperation,
    now: Date,
    settlement: ComputeJobOperationSettlement
  ): Promise<ComputeJobOperationRecord | null>
}

export type SessionComputePolicy =
  | { status: 'ready'; limit: number | null; revision: number }
  | {
      status: 'blocked'
      reason:
        | 'unavailable'
        | 'identity-conflict'
        | 'missing'
        | 'deleted'
        | 'unsupported-version'
        | 'invalid-policy'
    }

export type SessionComputePolicyAuthority = {
  // Must be read-only and must not call back into Compute or catalog hydration. The dispatcher
  // serializes this read with admission and policy writes; an adapter must not acquire their locks.
  resolve(sessionId: string, projectId?: string): Promise<SessionComputePolicy>
  save(sessionId: string, limit: number): Promise<void>
}
