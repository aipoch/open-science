import { randomUUID } from 'node:crypto'
import { resolveKubernetesJobTarget, type KubernetesJobTarget } from './kubernetes-kubeconfig'
import {
  authorizedWorkspaceBinding,
  readWorkspaceBinding,
  resolveWorkspaceTarget,
  prepareKubernetesJobWorkspace,
  type WorkspaceOwner
} from './kubernetes-job-workspace'
import { createKubernetesBackendAdapter, type KubernetesWorkspace } from '@aipoch/compute/node'
import {
  initialHostedJournal,
  readHostedJournal,
  type HostedJobJournal,
  type HostedJobTarget
} from './hugging-face-job-journal'
import { getManualStagedCleanup } from './manual-staged-cleanup'
import { initialRayJournal, type RayJobTarget } from './ray-job-journal'
import {
  initialModalJournal,
  MODAL_CREATION_UNCONFIRMED,
  readModalJournal,
  withUnstartedModalLaunch,
  type ModalJobJournal,
  type ModalJobTarget
} from './modal-job-journal'
import { isComputeJobTrackingStopped } from '@aipoch/compute'
import type {
  ComputeJobIntegrityIssue,
  ComputeJobOwner,
  ComputeJobRemoteCleanupDisposition,
  ComputeJobSessionOwner,
  ComputeJobStatus
} from '@aipoch/compute'
import type { PrismaClient, ComputeJob as PrismaComputeJob } from '@prisma/client'
import type {
  ComputeJob,
  ComputeJobAnalysisState,
  ComputeJobAnalysisTransition
} from '../../shared/compute'

import {
  classifyComputeJobIntegrity,
  isKnownComputeJobStatus,
  createCleanupStopEvidence,
  hasCleanupStopEvidence
} from '@aipoch/compute/node'
import {
  hasImmutableExecutionFileEvidenceReference,
  parseOwnedExecutionFileEvidenceSummary,
  type ExecutionFileEvidenceSummary
} from '../../shared/execution-file-evidence'
import {
  OptionalSecureStorageStringProtection,
  type ProtectedJsonContainer
} from './credential-vault'

// Only ComputeJob persistence and a transaction wrapper are needed.
type ComputeJobClient = Pick<PrismaClient, '$transaction' | 'computeJob'>
type ComputeJobClientProvider = () => Promise<ComputeJobClient>
type PrismaComputeJobWithOperation = PrismaComputeJob & {
  operations?: Array<{
    phase: string
    outcome: string | null
    revision?: number
    errorCode?: string | null
    errorMessage?: string | null
  }>
}
type ComputeJobFieldProtection = Pick<
  OptionalSecureStorageStringProtection,
  'isAvailable' | 'protect' | 'protectJson' | 'reveal' | 'revealJson'
>

export class UnencryptedComputeJobPersistenceApprovalRequiredError extends Error {
  constructor() {
    super('Compute Job plaintext persistence requires explicit approval.')
    this.name = 'UnencryptedComputeJobPersistenceApprovalRequiredError'
  }
}

const journalModes = ['modal_sandbox', 'hugging_face_jobs', 'ray_jobs'] as const
type JournalMode = (typeof journalModes)[number]
const usesJournal = (mode: string): boolean => journalModes.some((value) => value === mode)
const needsRemoteOwner = (mode: string): boolean => mode === 'kubernetes' || usesJournal(mode)
const ownerWhere = (owner: ComputeJobOwner): { projectId: string; sessionId?: string } => ({
  projectId: owner.projectId,
  ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId })
})

const sessionOwnerKey = (projectId: string, sessionId: string): string =>
  JSON.stringify([projectId, sessionId])

const asStatus = (value: string): ComputeJobStatus => {
  return isKnownComputeJobStatus(value) ? value : 'error'
}

const asAnalysisState = (value: string | null): ComputeJobAnalysisState | undefined => {
  const valid: ComputeJobAnalysisState[] = ['dispatched', 'succeeded', 'failed', 'cancelled']
  return valid.includes(value as ComputeJobAnalysisState)
    ? (value as ComputeJobAnalysisState)
    : undefined
}

const asRemoteCleanupDisposition = (value: string): ComputeJobRemoteCleanupDisposition => {
  const valid: ComputeJobRemoteCleanupDisposition[] = ['pending', 'cleaned', 'abandoned']
  return valid.includes(value as ComputeJobRemoteCleanupDisposition)
    ? (value as ComputeJobRemoteCleanupDisposition)
    : 'pending'
}

export type CreateJobRequest = {
  id: string
  providerId: string
  shape: string
  executionMode?: import('@aipoch/compute').ComputeExecutionMode
  sessionId: string
  projectId: string
  intent: string
  command: string
  commandHash: string
  environment?: string
  resourceRequest?: string
  inputManifest?: string
  producerRunId?: string
  fileEvidence?: ExecutionFileEvidenceSummary
  outputManifest?: string
  harvestConfig?: string
  timeoutSeconds?: number
  remoteWorkdir?: string
  initialStatus?: ComputeJobStatus
  allowUnencryptedPersistence?: boolean
}

export type UpdateJobRequest = import('@aipoch/compute').UpdateJobRequest & {
  fileEvidence?: ExecutionFileEvidenceSummary
}

type ComputeJobUpdateData = Parameters<ComputeJobClient['computeJob']['update']>[0]['data']
type ComputeJobCreateData = Parameters<ComputeJobClient['computeJob']['create']>[0]['data']

type SensitiveJobProjection = Readonly<{
  intent: string
  command: string
  environment: string | undefined
  resourceRequest: string | undefined
  inputManifest: string | undefined
  outputManifest: string | undefined
  harvestConfig: string | undefined
  remoteWorkdir: string | undefined
  remoteHandle: string | undefined
  stdoutTail: string | undefined
  stderrTail: string | undefined
  lastPollError: string | undefined
  errorMessage: string | undefined
  cancellationErrorMessage: string | undefined
  harvestError: string | undefined
  leftOnRemote: string | undefined
  unavailable: boolean
}>

// Owns ComputeJob reads/writes. Follows the same lazy-provider pattern as ComputeHostRepository.
export class ComputeJobRepository {
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private readonly deletingProjects = new Set<string>()
  private readonly deletingSessions = new Set<string>()
  private readonly deletingProviders = new Set<string>()

  constructor(
    private readonly getClient: ComputeJobClientProvider,
    private readonly fieldProtection: ComputeJobFieldProtection = new OptionalSecureStorageStringProtection(),
    private readonly resolveKubernetesTarget = resolveKubernetesJobTarget
  ) {}

  async prepareKubernetesWorkspace(
    owner: WorkspaceOwner,
    signal?: AbortSignal
  ): Promise<KubernetesWorkspace> {
    return prepareKubernetesJobWorkspace(
      await this.getClient(),
      this.fieldProtection,
      owner,
      this.resolveKubernetesTarget,
      signal
    )
  }

  async getKubernetesReservation(
    owner: WorkspaceOwner,
    signal?: AbortSignal
  ): Promise<{ binding: ReturnType<typeof readWorkspaceBinding>; target: KubernetesJobTarget }> {
    const client = await this.getClient()
    const row = await client.computeJob.findFirstOrThrow({
      where: {
        id: owner.jobId,
        sessionId: owner.sessionId,
        projectId: owner.projectId,
        providerId: owner.providerId,
        executionMode: 'kubernetes'
      }
    })
    const binding = readWorkspaceBinding(row, this.fieldProtection, owner)
    const target = await resolveWorkspaceTarget(binding, this.resolveKubernetesTarget, signal)
    return { binding, target }
  }

  // Only the winner may issue the POST. After a restart we may adopt the matching Job, never launch it again.
  async claimKubernetesLaunch(owner: WorkspaceOwner): Promise<string | undefined> {
    const client = await this.getClient()
    const where = {
      id: owner.jobId,
      sessionId: owner.sessionId,
      projectId: owner.projectId,
      providerId: owner.providerId,
      executionMode: 'kubernetes',
      status: 'submitted',
      operations: { none: { kind: 'cancel', phase: 'active' } }
    }
    const row = await client.computeJob.findFirst({ where })
    if (!row) return
    const binding = readWorkspaceBinding(row, this.fieldProtection, owner)
    if (!binding.receipt || binding.launchToken) return
    const launchToken = randomUUID()
    const serialized = JSON.stringify({ ...binding, launchToken })
    const claimed = await client.computeJob.updateMany({
      where: { ...where, kubernetesWorkspace: row.kubernetesWorkspace },
      data: {
        kubernetesWorkspace: row.sensitiveDataEncrypted
          ? this.fieldProtection.protectJson(serialized, 'object')
          : serialized
      }
    })
    return claimed.count ? launchToken : undefined
  }

  async findKubernetesWork(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        executionMode: 'kubernetes',
        kubernetesWorkspace: { not: null },
        status: { in: ['submitted', 'running', 'success', 'failed', 'timeout'] },
        operations: { none: { kind: 'cancel', phase: 'active' } }
      },
      orderBy: { createdAt: 'asc' },
      include: { operations: { where: { kind: 'cancel' } } }
    })
    return this.excludeDeletingOwners(this.toLifecycleJobs(rows))
  }

  /** Retain the remote volume until this job's published local evidence is durable. */
  async releasePublishedKubernetesWorkspace(
    owner: WorkspaceOwner,
    signal?: AbortSignal
  ): Promise<'requested' | 'confirmed'> {
    const client = await this.getClient()
    const where = {
      id: owner.jobId,
      providerId: owner.providerId,
      projectId: owner.projectId,
      sessionId: owner.sessionId,
      executionMode: 'kubernetes'
    }
    const row = await client.computeJob.findFirst({ where })
    const evidence = row ? parseFileEvidence(row) : undefined
    if (
      !row ||
      !['success', 'timeout', 'failed'].includes(row.status) ||
      !row.harvestedAt ||
      row.harvestError !== null ||
      !hasImmutableExecutionFileEvidenceReference(evidence) ||
      evidence.state === 'unavailable' ||
      this.revealJsonOptional(row.leftOnRemote, 'array', row.sensitiveDataEncrypted === true) !==
        '[]'
    )
      throw new Error('Kubernetes workspace files have not been fully published.')
    if (row.kubernetesWorkspace === null) return 'confirmed'
    const binding = readWorkspaceBinding(row, this.fieldProtection, owner)
    if (!binding.receipt) throw new Error('Kubernetes workspace receipt is unavailable.')
    const target = await resolveWorkspaceTarget(binding, this.resolveKubernetesTarget, signal)
    const result = await createKubernetesBackendAdapter(target).releaseWorkspace(
      binding.receipt,
      signal
    )
    if (result === 'confirmed') {
      await client.computeJob.updateMany({
        where: { ...where, kubernetesWorkspace: row.kubernetesWorkspace },
        data: {
          kubernetesWorkspace: null,
          remoteCleanupDisposition: 'cleaned',
          lastPollError: null
        }
      })
    }
    return result
  }

  isFieldProtectionAvailable(): boolean {
    return this.fieldProtection.isAvailable()
  }

  async beginProviderDeletion(providerId: string): Promise<void> {
    await this.runMutation(async () => {
      this.deletingProviders.add(providerId)
    })
  }

  async abortProviderDeletion(providerId: string): Promise<void> {
    await this.runMutation(async () => {
      this.deletingProviders.delete(providerId)
    })
  }

  async completeProviderDeletion(providerId: string): Promise<void> {
    await this.abortProviderDeletion(providerId)
  }

  async beginOwnerDeletion(owner: ComputeJobOwner): Promise<void> {
    await this.runMutation(async () => {
      if (owner.sessionId === undefined) this.deletingProjects.add(owner.projectId)
      else this.deletingSessions.add(sessionOwnerKey(owner.projectId, owner.sessionId))
    })
  }

  async abortOwnerDeletion(owner: ComputeJobOwner): Promise<void> {
    await this.runMutation(async () => {
      if (owner.sessionId === undefined) this.deletingProjects.delete(owner.projectId)
      else this.deletingSessions.delete(sessionOwnerKey(owner.projectId, owner.sessionId))
    })
  }

  async findByOwner(owner: ComputeJobOwner): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: ownerWhere(owner),
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    if (
      rows.some(
        (row) =>
          (usesJournal(row.executionMode) && row.remoteCleanupDisposition === 'pending') ||
          (row.executionMode === 'kubernetes' && row.kubernetesWorkspace !== null)
      )
    )
      throw new Error('Remote workspace requires cleanup.')
    return rows.filter((row) => !needsRemoteOwner(row.executionMode)).map(this.toJob)
  }

  async listOwners(): Promise<ComputeJobSessionOwner[]> {
    const client = await this.getClient()
    return client.computeJob.findMany({
      select: { projectId: true, sessionId: true },
      distinct: ['projectId', 'sessionId'],
      orderBy: [{ projectId: 'asc' }, { sessionId: 'asc' }]
    })
  }

  async deleteByOwner(owner: ComputeJobOwner): Promise<void> {
    await this.runMutation(async () => {
      const client = await this.getClient()
      await client.$transaction(async (tx) => {
        const where = ownerWhere(owner)
        if (
          await tx.computeJob.count({
            where: {
              ...where,
              OR: [
                { executionMode: { in: [...journalModes] }, remoteCleanupDisposition: 'pending' },
                { executionMode: 'kubernetes', kubernetesWorkspace: { not: null } }
              ]
            }
          })
        )
          throw new Error('Remote workspace requires cleanup.')
        await tx.computeJob.deleteMany({ where })
      })
    })
  }

  async createApprovedKubernetesJob(
    request: Omit<
      CreateJobRequest,
      'executionMode' | 'shape' | 'initialStatus' | 'remoteWorkdir'
    > & { initialStatus?: 'submitted' | 'queued' },
    target: Pick<KubernetesJobTarget, 'context' | 'endpoint' | 'namespace' | 'image'> & {
      transferImage?: string
    },
    sizeMiB: number
  ): Promise<WorkspaceOwner> {
    const binding = authorizedWorkspaceBinding(target, sizeMiB)
    await this.createStored(
      {
        ...request,
        shape: 'bridge_runner',
        executionMode: 'kubernetes',
        remoteWorkdir: '/workspace',
        initialStatus: request.initialStatus ?? 'submitted'
      },
      undefined,
      JSON.stringify(binding)
    )
    return {
      jobId: request.id,
      providerId: request.providerId,
      projectId: request.projectId,
      sessionId: request.sessionId
    }
  }

  async createApprovedHuggingFaceJob(
    request: CreateJobRequest,
    target: HostedJobTarget
  ): Promise<ComputeJob> {
    return this.createStored(
      { ...request, shape: 'bridge_runner', executionMode: 'hugging_face_jobs' },
      initialHostedJournal(request.id, request.providerId, target)
    )
  }
  async createApprovedRayJob(request: CreateJobRequest, target: RayJobTarget): Promise<ComputeJob> {
    return this.createStored(
      { ...request, shape: 'bridge_runner', executionMode: 'ray_jobs' },
      initialRayJournal(request.id, request.providerId, target)
    )
  }
  async createApprovedModalJob(
    request: CreateJobRequest,
    target: ModalJobTarget
  ): Promise<ComputeJob> {
    return this.createStored(
      { ...request, shape: 'bridge_runner', executionMode: 'modal_sandbox' },
      initialModalJournal(request.id, request.providerId, target)
    )
  }
  async create(request: CreateJobRequest): Promise<ComputeJob> {
    if (
      request.executionMode != null &&
      request.executionMode !== 'direct_ssh' &&
      request.executionMode !== 'slurm'
    )
      throw new Error('Compute jobs on this backend require an approved target.')
    return this.createStored(request)
  }
  private async createStored(
    request: CreateJobRequest,
    handle?: string,
    workspaceBinding?: string
  ): Promise<ComputeJob> {
    return this.runMutation(async () => {
      if (this.deletingProviders.has(request.providerId)) {
        throw new Error(`Compute Host is being removed: ${request.providerId}`)
      }
      this.assertOwnerMutable(request.projectId, request.sessionId)
      const client = await this.getClient()
      const initialStatus = request.initialStatus ?? 'submitted'
      const sensitiveDataEncrypted = this.fieldProtection.isAvailable()
      if (!sensitiveDataEncrypted && request.allowUnencryptedPersistence !== true) {
        throw new UnencryptedComputeJobPersistenceApprovalRequiredError()
      }

      const buildData = (encrypt: boolean): ComputeJobCreateData => ({
        id: request.id,
        providerId: request.providerId,
        shape: request.shape,
        executionMode: request.executionMode ?? 'direct_ssh',
        sessionId: request.sessionId,
        projectId: request.projectId,
        status: initialStatus,
        intent: this.protect(request.intent, encrypt),
        command: this.protect(request.command, encrypt),
        commandHash: request.commandHash,
        kubernetesWorkspace: this.protectJsonOptional(workspaceBinding, 'object', encrypt),
        remoteHandle: this.protectJsonOptional(handle, 'object', encrypt),
        sensitiveDataEncrypted: encrypt,
        environment: this.protectOptional(request.environment, encrypt),
        resourceRequest: this.protectJsonOptional(request.resourceRequest, 'object', encrypt),
        inputManifest: this.protectJsonOptional(request.inputManifest, 'array', encrypt),
        producerRunId: request.producerRunId,
        fileEvidence:
          request.fileEvidence === undefined ? undefined : JSON.stringify(request.fileEvidence),
        outputManifest: this.protectJsonOptional(request.outputManifest, 'array', encrypt),
        harvestConfig: this.protectJsonOptional(request.harvestConfig, 'object', encrypt),
        timeoutSeconds: request.timeoutSeconds,
        remoteWorkdir: this.protectOptional(request.remoteWorkdir, encrypt),
        submittedAt: initialStatus === 'submitted' ? new Date() : undefined
      })

      let data: ReturnType<typeof buildData>
      try {
        data = buildData(sensitiveDataEncrypted)
      } catch (error) {
        if (sensitiveDataEncrypted && !this.fieldProtection.isAvailable()) {
          if (request.allowUnencryptedPersistence !== true) {
            throw new UnencryptedComputeJobPersistenceApprovalRequiredError()
          }
          data = buildData(false)
        } else {
          throw error
        }
      }

      const row = await client.computeJob.create({
        data,
        include: { operations: { where: { kind: 'cancel' } } }
      })
      return this.toJob(row)
    })
  }

  async get(jobId: string): Promise<ComputeJob | null> {
    const client = await this.getClient()
    const row = await client.computeJob.findUnique({
      where: { id: jobId },
      include: { operations: { where: { kind: 'cancel' } } }
    })
    return row ? this.toJob(row) : null
  }

  // Returns all non-terminal jobs (queued + submitted + running) for the poller to resume after restart.
  async findNonTerminal(includeRemote = false): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        ...(!includeRemote && { executionMode: { in: ['direct_ssh', 'slurm'] } }),
        status: { in: ['queued', 'submitted', 'running'] },
        operations: {
          none: { kind: 'cancel', OR: [{ phase: 'active' }, { outcome: 'fulfilled' }] }
        }
      },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    const jobs = this.toLifecycleJobs(rows)
    return this.excludeDeletingOwners(
      includeRemote ? jobs : jobs.filter((job) => !isComputeJobTrackingStopped(job))
    )
  }

  // Returns all terminal jobs (success/failed/timeout) that have not yet been harvested.
  // Used by the poller's restart-recovery scan to re-queue harvests interrupted by an app restart.
  async findTerminalUnharvested(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        status: { in: ['success', 'failed', 'timeout'] },
        executionMode: { in: ['direct_ssh', 'slurm'] },
        harvestedAt: null,
        remoteCleanupDisposition: { not: 'cleaned' },
        // A cancellation fulfilled while the Job was still queued has no remote execution to
        // harvest. Submitted/running cancellations keep their normal best-effort harvest path.
        NOT: {
          submittedAt: null,
          operations: { some: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } }
        }
      },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    return this.excludeDeletingOwners(this.toLifecycleJobs(rows))
  }

  // Returns every final resting state ready for notification. Harvested execution outcomes and
  // dispatch errors share one restart-recovery entrance; the notifier CAS decides the sole emitter.
  async findNotificationReadyUnnotified(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        notifiedAt: null,
        OR: [
          { status: 'error' },
          { status: 'failed', errorCode: 'job_cancelled' },
          { operations: { some: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } } },
          { status: { in: ['success', 'failed', 'timeout'] }, harvestedAt: { not: null } }
        ]
      },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    return this.excludeDeletingOwners(this.toLifecycleJobs(rows))
  }

  // Returns all non-terminal jobs for a given provider (used by per-host batch polling).
  async findNonTerminalByProvider(providerId: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        providerId,
        status: { in: ['queued', 'submitted', 'running'] },
        operations: {
          none: { kind: 'cancel', OR: [{ phase: 'active' }, { outcome: 'fulfilled' }] }
        }
      },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    return this.toLifecycleJobs(rows).filter((job) => !isComputeJobTrackingStopped(job))
  }

  async update(jobId: string, updates: UpdateJobRequest): Promise<ComputeJob> {
    if (updates.fileEvidence !== undefined) {
      return this.runMutation(async () => {
        const client = await this.getClient()
        return client.$transaction(async (transaction) => {
          const current = await transaction.computeJob.findUnique({ where: { id: jobId } })
          const currentEvidence = current ? parseFileEvidence(current) : undefined
          const fileEvidence = hasImmutableExecutionFileEvidenceReference(currentEvidence)
            ? currentEvidence
            : updates.fileEvidence
          const row = await transaction.computeJob.update({
            where: { id: jobId },
            data: this.toUpdateData(
              this.preserveCleanupStopEvidence(current, { ...updates, fileEvidence }),
              current?.sensitiveDataEncrypted === true
            ),
            include: { operations: { where: { kind: 'cancel' } } }
          })
          return this.toJob(row)
        })
      })
    }
    return this.runMutation(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const current = await transaction.computeJob.findUnique({ where: { id: jobId } })
        const row = await transaction.computeJob.update({
          where: { id: jobId },
          data: this.toUpdateData(
            this.preserveCleanupStopEvidence(current, updates),
            current?.sensitiveDataEncrypted === true
          ),
          include: { operations: { where: { kind: 'cancel' } } }
        })
        return this.toJob(row)
      })
    })
  }

  // Atomically claims the right to emit a notification. Stale callers may all hold a projection
  // with notified_at unset; only the transaction that changes NULL to a timestamp may broadcast.
  async claimNotification(jobId: string, notifiedAt: Date): Promise<ComputeJob | null> {
    return this.runMutation(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const current = await transaction.computeJob.findUnique({ where: { id: jobId } })
        if (!current || !this.isOwnerMutable(current.projectId, current.sessionId)) return null
        const claimed = await transaction.computeJob.updateMany({
          where: {
            id: jobId,
            notifiedAt: null,
            OR: [
              { status: 'error' },
              { status: 'failed', errorCode: 'job_cancelled' },
              { operations: { some: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } } },
              { status: { in: ['success', 'failed', 'timeout'] }, harvestedAt: { not: null } }
            ]
          },
          data: { notifiedAt }
        })
        if (claimed.count === 0) return null
        const row = await transaction.computeJob.findUnique({
          where: { id: jobId },
          include: { operations: { where: { kind: 'cancel' } } }
        })
        return row ? this.toJob(row) : null
      })
    })
  }

  async updateIfStatus(
    jobId: string,
    expectedStatuses: readonly ComputeJobStatus[],
    updates: UpdateJobRequest
  ): Promise<ComputeJob | null> {
    return this.runMutation(async () => {
      const client = await this.getClient()
      return client.$transaction(async (transaction) => {
        const current = await transaction.computeJob.findUnique({ where: { id: jobId } })
        if (!current || !this.isOwnerMutable(current.projectId, current.sessionId)) return null

        const applied = await transaction.computeJob.updateMany({
          where: {
            id: jobId,
            status: { in: [...expectedStatuses] },
            operations: {
              none: { kind: 'cancel', OR: [{ phase: 'active' }, { outcome: 'fulfilled' }] }
            },
            // Failed direct SSH cancellation leaves status active but explicitly stops tracking.
            // Fence stale poll/recovery writes in the same SQL CAS as the status check; a
            // findNonTerminal snapshot or an earlier application read cannot enforce this.
            NOT: {
              executionMode: 'direct_ssh',
              status: { in: ['submitted', 'running'] },
              operations: {
                some: {
                  kind: 'cancel',
                  phase: 'settled',
                  outcome: 'failed',
                  errorCode: 'cancel_confirmation_failed'
                }
              }
            }
          },
          data: this.toUpdateData(
            this.preserveCleanupStopEvidence(current, updates),
            current.sensitiveDataEncrypted === true
          )
        })
        if (applied.count === 0) return null

        const row = await transaction.computeJob.findUnique({
          where: { id: jobId },
          include: { operations: { where: { kind: 'cancel' } } }
        })
        return row ? this.toJob(row) : null
      })
    })
  }

  // Evidence-only handoff remains writable while deletion waits for dispatch to drain.
  // It does not grant the dispatcher ownership of status, cancellation, or deleted rows.
  async recordDispatchNoLaunch(expectedJob: ComputeJob): Promise<void> {
    if (expectedJob.status !== 'submitted' || expectedJob.remote_handle) return
    await this.runMutation(async () => {
      const client = await this.getClient()
      await client.$transaction(async (transaction) => {
        const current = await transaction.computeJob.findUnique({
          where: { id: expectedJob.job_id }
        })
        if (!current) return
        const projected = this.toJob(current)
        if (
          projected.project_id !== expectedJob.project_id ||
          projected.session_id !== expectedJob.session_id ||
          projected.provider_id !== expectedJob.provider_id ||
          projected.created_at !== expectedJob.created_at ||
          projected.command_hash !== expectedJob.command_hash ||
          projected.execution_mode !== expectedJob.execution_mode ||
          projected.remote_workdir !== expectedJob.remote_workdir ||
          projected.last_poll_error !== expectedJob.last_poll_error
        )
          return
        await transaction.computeJob.updateMany({
          where: {
            id: expectedJob.job_id,
            projectId: current.projectId,
            sessionId: current.sessionId,
            providerId: current.providerId,
            createdAt: current.createdAt,
            commandHash: current.commandHash,
            executionMode: current.executionMode,
            remoteWorkdir: current.remoteWorkdir,
            status: 'submitted',
            remoteHandle: null,
            lastPollError: current.lastPollError,
            operations: { none: { kind: 'cancel', phase: 'settled' } }
          },
          data: this.toUpdateData(
            { lastPollError: 'dispatch_definitely_not_started' },
            current.sensitiveDataEncrypted === true
          )
        })
      })
    })
  }

  // Stop proof is written before any destructive cleanup. It is allowed under an owner fence,
  // unlike normal execution transitions, but only for the exact snapshot that was stopped.
  async recordRemoteCleanupStopped(job: ComputeJob, workdir: string): Promise<void> {
    await this.runMutation(async () => {
      const client = await this.getClient()
      await client.$transaction(async (transaction) => {
        const current = await transaction.computeJob.findUnique({ where: { id: job.job_id } })
        if (!current) throw new Error('Compute cleanup snapshot no longer exists.')
        const projected = this.toJob(current)
        const evidence = createCleanupStopEvidence(job, workdir)
        if (
          createCleanupStopEvidence(projected, workdir) !== evidence ||
          projected.status !== job.status ||
          projected.last_poll_error !== job.last_poll_error
        ) {
          throw new Error('Compute cleanup snapshot changed before stop evidence persisted.')
        }
        const applied = await transaction.computeJob.updateMany({
          where: {
            id: current.id,
            providerId: current.providerId,
            projectId: current.projectId,
            sessionId: current.sessionId,
            status: current.status,
            remoteHandle: current.remoteHandle,
            remoteWorkdir: current.remoteWorkdir,
            lastPollError: current.lastPollError
          },
          data: this.toUpdateData(
            { lastPollError: evidence },
            current.sensitiveDataEncrypted === true
          )
        })
        if (applied.count !== 1) throw new Error('Compute cleanup stop evidence was not persisted.')
      })
    })
  }

  private preserveCleanupStopEvidence(
    current: PrismaComputeJob | null,
    updates: UpdateJobRequest
  ): UpdateJobRequest {
    if (!current || updates.lastPollError === undefined) return updates
    const job = this.toJob(current)
    if (
      current.lastPollError !== null &&
      job.integrity_issues?.some((issue) => issue.code === 'sensitive-fields-unavailable')
    ) {
      // A degraded read projection is not proof that durable stop evidence is absent. Fail the
      // transaction before a null update can destroy ciphertext while the keyring is locked.
      throw new Error(
        'Compute Job cleanup evidence is unreadable; refusing to overwrite encrypted diagnostics.'
      )
    }
    if (!hasCleanupStopEvidence(job)) return updates
    // A new handle or workdir denotes a different execution and invalidates old proof.
    if (
      (updates.remoteHandle !== undefined && updates.remoteHandle !== job.remote_handle) ||
      (updates.remoteWorkdir !== undefined && updates.remoteWorkdir !== job.remote_workdir)
    )
      return updates
    return { ...updates, lastPollError: job.last_poll_error }
  }

  // A launch response may arrive after cancellation fenced ordinary lifecycle transitions.
  // Preserve only the missing handle, without reviving execution or overwriting another observer.
  async recordCancellationHandle(jobId: string, remoteHandle: string): Promise<void> {
    await this.runMutation(async () => {
      const client = await this.getClient()
      await client.$transaction(async (transaction) => {
        const current = await transaction.computeJob.findUnique({ where: { id: jobId } })
        if (!current || !this.isOwnerMutable(current.projectId, current.sessionId)) return
        await transaction.computeJob.updateMany({
          where: {
            id: jobId,
            status: { in: ['submitted', 'running'] },
            remoteHandle: null,
            operations: { some: { kind: 'cancel', phase: 'active' } }
          },
          data: this.toUpdateData({ remoteHandle }, current.sensitiveDataEncrypted === true)
        })
      })
    })
  }

  // Observational projection for renderer lists. Unlike lifecycle scans,
  // this retains quarantined/needs-attention rows so users can inspect durable state safely.
  async findBySession(sessionId: string, statuses?: string[]): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        sessionId,
        ...(statuses && statuses.length > 0 ? { status: { in: statuses } } : {})
      },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'desc' }
    })
    return rows.map(this.toJob)
  }

  // Status reads never need sensitive job bodies or cancellation operation payloads.
  async findSessionConcurrencyJobs(
    sessionId: string
  ): Promise<Pick<ComputeJob, 'status' | 'provider_id'>[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        sessionId,
        operations: { none: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } }
      },
      select: { status: true, providerId: true }
    })
    return rows.map((row) => ({ status: asStatus(row.status), provider_id: row.providerId }))
  }

  async findProjectOverview(projectId: string, since: Date): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        projectId,
        OR: [
          { status: { in: ['queued', 'submitted', 'running'] } },
          { operations: { some: { kind: 'cancel', phase: 'active' } } },
          {
            status: { in: ['success', 'failed', 'timeout', 'error'] },
            OR: [{ finishedAt: { gte: since } }, { finishedAt: null, createdAt: { gte: since } }]
          }
        ]
      },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'desc' },
      take: 200
    })
    return rows.map(this.toJob)
  }

  // Checks if a provider has any non-terminal jobs (used by delete guard on ComputeHost).
  async hasActiveJobsForProvider(providerId: string): Promise<boolean> {
    const client = await this.getClient()
    const count = await client.computeJob.count({
      where: {
        providerId,
        status: { in: ['queued', 'submitted', 'running'] },
        operations: { none: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } }
      }
    })
    return count > 0
  }

  async hasIdentityChangeBlockingJobsForProvider(providerId: string): Promise<boolean> {
    const client = await this.getClient()
    const count = await client.computeJob.count({
      where: {
        providerId,
        OR: [
          { status: { in: ['queued', 'submitted', 'running'] } },
          { status: { in: ['success', 'failed', 'timeout'] }, harvestedAt: null },
          { remoteCleanupDisposition: 'pending' }
        ]
      }
    })
    return count > 0
  }

  // Host deletion retains authentication until each Job's remote cleanup is proven or explicitly
  // abandoned. Even a dispatch-error Job can have created remote state before persisting its workdir.
  async hasDeletionBlockingJobsForProvider(providerId: string): Promise<boolean> {
    return this.runMutation(async () => {
      const client = await this.getClient()
      const count = await client.computeJob.count({
        where: { providerId, remoteCleanupDisposition: 'pending' }
      })
      return count > 0
    })
  }

  async findDeletionBlockingJobsForProvider(providerId: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { providerId, remoteCleanupDisposition: 'pending' },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(this.toJob)
  }

  canCleanJournalResources(job: ComputeJob, journal: HostedJobJournal | ModalJobJournal): boolean {
    if (
      !job.harvested_at ||
      job.harvest_error ||
      !['success', 'failed', 'timeout'].includes(job.status)
    )
      return false
    if (journal.published) {
      return (
        job.left_on_remote === '[]' &&
        hasImmutableExecutionFileEvidenceReference(job.file_evidence) &&
        job.file_evidence.state !== 'unavailable'
      )
    }
    // A fulfilled pre-launch cancellation has no execution results to publish.
    return (
      job.status === 'failed' &&
      job.error_code === 'job_cancelled' &&
      job.cancellation_status === 'cancelled' &&
      job.started_at === undefined &&
      (job.left_on_remote === undefined || job.left_on_remote === '[]') &&
      ('nonce' in journal
        ? !!journal.volume?.id && !journal.sandbox
        : journal.staging === true && !journal.launch && !journal.discardedOutputs)
    )
  }

  getManualStagedCleanup = getManualStagedCleanup

  confirmManualStagedCleanup(job: ComputeJob): Promise<ComputeJob> {
    if (job.execution_mode !== 'hugging_face_jobs' && job.execution_mode !== 'modal_sandbox')
      throw new Error('Staged resource cleanup is unavailable.')
    return this.confirmJournalCleanup(job, job.execution_mode, true)
  }

  confirmModalCleanup(job: ComputeJob): Promise<ComputeJob> {
    return this.confirmJournalCleanup(job, 'modal_sandbox')
  }
  confirmHostedCleanup(job: ComputeJob): Promise<ComputeJob> {
    return this.confirmJournalCleanup(job, 'hugging_face_jobs')
  }
  private async confirmJournalCleanup(
    job: ComputeJob,
    mode: 'hugging_face_jobs' | 'modal_sandbox',
    manual = false
  ): Promise<ComputeJob> {
    const client = await this.getClient()
    return client.$transaction(async (tx) => {
      const where = {
        id: job.job_id,
        providerId: job.provider_id,
        projectId: job.project_id,
        sessionId: job.session_id,
        executionMode: mode
      }
      const row = await tx.computeJob.findFirstOrThrow({
        where,
        include: { operations: { where: { kind: 'cancel' } } }
      })
      const current = this.toJob(row)
      if (current.remote_handle !== job.remote_handle)
        throw new Error('Remote resource cleanup could not be confirmed.')
      if (current.remote_cleanup_disposition === 'cleaned') return current
      const eligible = manual
        ? getManualStagedCleanup(current)
        : this.canCleanJournalResources(
            current,
            mode === 'modal_sandbox' ? readModalJournal(current) : readHostedJournal(current)
          )
      if (!eligible) throw new Error('Remote resource cleanup could not be confirmed.')
      const result = await tx.computeJob.updateMany({
        where: {
          ...where,
          status: row.status,
          remoteHandle: row.remoteHandle,
          remoteCleanupDisposition: 'pending'
        },
        data: {
          remoteCleanupDisposition: 'cleaned',
          lastPollError: null,
          ...(manual && mode === 'modal_sandbox' && { harvestError: null })
        }
      })
      if (result.count !== 1) throw new Error('Remote resource cleanup disposition changed.')
      return this.toJob(
        await tx.computeJob.findFirstOrThrow({
          where,
          include: { operations: { where: { kind: 'cancel' } } }
        })
      )
    })
  }

  async settleRemoteCleanup(
    request: Readonly<{
      jobId: string
      providerId: string
      projectId: string
      sessionId: string
      disposition: Exclude<ComputeJobRemoteCleanupDisposition, 'pending'>
    }>
  ): Promise<ComputeJob> {
    return this.runMutation(async () => {
      const client = await this.getClient()
      const existing = await client.computeJob.findUnique({ where: { id: request.jobId } })
      if (
        !existing ||
        existing.providerId !== request.providerId ||
        existing.projectId !== request.projectId ||
        existing.sessionId !== request.sessionId
      ) {
        throw new Error('Compute Job cleanup scope does not match.')
      }
      if (
        existing.executionMode === 'modal_sandbox' &&
        request.disposition === 'abandoned' &&
        existing.remoteCleanupDisposition === 'pending' &&
        ['submitted', 'running'].includes(existing.status)
      ) {
        const job = this.toJob(existing)
        const binding = readModalJournal(job)
        if (
          job.last_poll_error !== MODAL_CREATION_UNCONFIRMED ||
          !((binding.volume && !binding.volume.id) || (binding.sandbox && !binding.sandbox.id))
        )
          throw new Error('Modal abandonment requires an unconfirmed creation.')
        return client.$transaction(async (tx) => {
          const message =
            'Local ownership abandoned after unconfirmed Modal creation. Check the Modal dashboard for remaining resources and charges.'
          const changed = await tx.computeJob.updateMany({
            where: {
              id: existing.id,
              executionMode: 'modal_sandbox',
              status: existing.status,
              remoteHandle: existing.remoteHandle,
              lastPollError: existing.lastPollError,
              remoteCleanupDisposition: 'pending'
            },
            data: {
              ...this.toUpdateData(
                {
                  status: 'error',
                  errorCode: 'dispatch_failed',
                  errorMessage: message,
                  finishedAt: new Date()
                },
                existing.sensitiveDataEncrypted === true
              ),
              remoteCleanupDisposition: 'abandoned'
            }
          })
          if (!changed.count) throw new Error('Modal job changed while abandoning.')
          await tx.computeJobOperation.updateMany({
            where: { jobId: existing.id, kind: 'cancel', phase: 'active' },
            data: {
              phase: 'settled',
              outcome: 'failed',
              errorCode: 'job_status_unavailable',
              errorMessage: this.protect(message, existing.sensitiveDataEncrypted === true),
              claimToken: null,
              claimExpiresAt: null,
              eligibleAt: null,
              settledAt: new Date(),
              revision: { increment: 1 }
            }
          })
          return this.toJob(
            await tx.computeJob.findUniqueOrThrow({
              where: { id: existing.id },
              include: { operations: { where: { kind: 'cancel' } } }
            })
          )
        })
      }
      if (
        (usesJournal(existing.executionMode) ||
          (existing.executionMode === 'kubernetes' && existing.kubernetesWorkspace !== null)) &&
        existing.remoteCleanupDisposition === 'pending' &&
        (!['success', 'failed', 'timeout', 'error'].includes(existing.status) ||
          request.disposition === 'cleaned')
      )
        throw new Error(
          existing.executionMode === 'kubernetes'
            ? 'Kubernetes workspace cleanup requires a confirmed release or explicit terminal abandonment.'
            : 'Remote workspace cleanup requires confirmed publication or explicit terminal abandonment.'
        )
      if (existing.remoteCleanupDisposition !== 'pending') {
        if (existing.remoteCleanupDisposition !== request.disposition) {
          throw new Error('Compute Job remote cleanup is already settled.')
        }
      } else {
        await client.computeJob.update({
          where: { id: request.jobId },
          data: {
            remoteCleanupDisposition: request.disposition,
            ...(existing.executionMode === 'kubernetes' &&
              request.disposition === 'abandoned' && { kubernetesWorkspace: null })
          }
        })
      }
      const row = await client.computeJob.findUniqueOrThrow({
        where: { id: request.jobId },
        include: { operations: { where: { kind: 'cancel' } } }
      })
      return this.toJob(row)
    })
  }

  // Returns notified jobs whose automatic analysis is still pending or dispatched, optionally
  // scoped to one Session. Failed/cancelled outcomes stay unconsumed but are terminal and observable
  // through normal Job reads, so the restart scan does not repeatedly requeue them.
  async findPendingNotifications(sessionId?: string): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        ...(sessionId === undefined ? {} : { sessionId }),
        status: { in: ['success', 'failed', 'timeout', 'error'] },
        notifiedAt: { not: null },
        notificationConsumedAt: null,
        OR: [{ analysisState: null }, { analysisState: 'dispatched' }]
      },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    return this.toLifecycleJobs(rows)
  }

  // Detect-only startup seam over raw rows. It never guesses a future enum value and never mutates
  // historical jobs; operational scans quarantine unknown status and notification-invariant rows.
  async scanIntegrity(): Promise<ComputeJobIntegrityIssue[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({ orderBy: { createdAt: 'asc' } })
    return rows.flatMap((row) => this.integrityIssues(row, this.projectSensitiveFields(row)))
  }

  // Marks a batch of jobs as notification-consumed by setting notificationConsumedAt to now.
  // Session ids are globally stable identities; reject a mixed, missing, or unnotified batch
  // atomically so a caller cannot consume another Session's notification by job id.
  async markNotificationsConsumed(sessionId: string, jobIds: readonly string[]): Promise<void> {
    if (jobIds.length === 0) return
    const client = await this.getClient()
    const distinctJobIds = [...new Set(jobIds)]
    await client.$transaction(async (transaction) => {
      const rows = await transaction.computeJob.findMany({
        where: { id: { in: distinctJobIds } },
        select: { id: true, sessionId: true, notifiedAt: true }
      })
      const allOwnedNotifications =
        rows.length === distinctJobIds.length &&
        rows.every((row) => row.sessionId === sessionId && row.notifiedAt !== null)
      if (!allOwnedNotifications) {
        throw new Error('Cannot consume compute notifications outside the requested Session.')
      }
      await transaction.computeJob.updateMany({
        where: {
          sessionId,
          id: { in: distinctJobIds },
          notifiedAt: { not: null },
          notificationConsumedAt: null
        },
        data: { notificationConsumedAt: new Date() }
      })
    })
  }

  async transitionAnalysis(request: ComputeJobAnalysisTransition): Promise<ComputeJob[]> {
    const sessionId = request.sessionId.trim()
    const messageId = request.messageId.trim()
    const jobIds = [...new Set(request.jobIds.map((jobId) => jobId.trim()).filter(Boolean))]
    if (!sessionId || !messageId || jobIds.length === 0) {
      throw new Error('Compute analysis transition requires a Session, Jobs, and Message identity.')
    }

    const client = await this.getClient()
    await client.$transaction(async (transaction) => {
      const rows = await transaction.computeJob.findMany({ where: { id: { in: jobIds } } })
      if (
        rows.length !== jobIds.length ||
        rows.some((row) => row.sessionId !== sessionId || row.notifiedAt === null)
      ) {
        throw new Error('Cannot transition compute analysis outside the requested Session.')
      }

      const transitionAllowed = rows.every((row) => {
        if (request.state === 'dispatched') {
          return (
            row.notificationConsumedAt === null &&
            (row.analysisState === null ||
              (row.analysisState === 'dispatched' && row.analysisMessageId === messageId))
          )
        }
        return (
          row.analysisMessageId === messageId &&
          (row.analysisState === 'dispatched' || row.analysisState === request.state)
        )
      })
      if (!transitionAllowed) {
        throw new Error('Compute analysis transition does not match its durable dispatch.')
      }

      await transaction.computeJob.updateMany({
        where: { sessionId, id: { in: jobIds } },
        data: {
          analysisState: request.state,
          analysisMessageId: messageId,
          analysisUpdatedAt: new Date(),
          ...(request.state === 'succeeded' ? { notificationConsumedAt: new Date() } : {})
        }
      })
    })

    const rows = await client.computeJob.findMany({
      where: { sessionId, id: { in: jobIds } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(this.toJob)
  }

  // Counts non-terminal jobs (queued, submitted, running) across all sessions for a given provider.
  // Used by ConcurrencyManager to enforce provider ceilings.
  async countNonTerminalByProvider(providerId: string): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: {
        providerId,
        status: { in: ['queued', 'submitted', 'running'] },
        operations: { none: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } }
      }
    })
  }

  // Counts non-terminal jobs (queued, submitted, running) across all providers for a given session.
  // Used by ConcurrencyManager to enforce session limits.
  async countNonTerminalBySession(sessionId: string): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: {
        sessionId,
        status: { in: ['queued', 'submitted', 'running'] },
        operations: { none: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } }
      }
    })
  }

  // Counts active jobs (submitted, running) excluding queued, for a given session.
  // Used by ConcurrencyManager to check if a new job should queue or dispatch immediately.
  async countActiveBySession(sessionId: string): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: {
        sessionId,
        status: { in: ['submitted', 'running'] },
        operations: { none: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } }
      }
    })
  }

  // Counts active jobs (submitted, running) excluding queued, for a given provider.
  // Used by ConcurrencyManager to check provider ceiling enforcement.
  async countActiveByProvider(providerId: string): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: {
        providerId,
        status: { in: ['submitted', 'running'] },
        operations: { none: { kind: 'cancel', phase: 'settled', outcome: 'fulfilled' } }
      }
    })
  }

  // Counts all queued jobs globally (across all sessions and providers).
  // Used by ConcurrencyManager to enforce the global queue limit (100).
  async countQueuedJobs(): Promise<number> {
    const client = await this.getClient()
    return await client.computeJob.count({
      where: { status: 'queued', operations: { none: { kind: 'cancel' } } }
    })
  }

  findModalWork(): Promise<ComputeJob[]> {
    return this.findJournalWork('modal_sandbox')
  }
  findHostedWork(): Promise<ComputeJob[]> {
    return this.findJournalWork('hugging_face_jobs')
  }
  findRayWork(): Promise<ComputeJob[]> {
    return this.findJournalWork('ray_jobs')
  }
  private async findJournalWork(mode: JournalMode): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: {
        executionMode: mode,
        ...(mode === 'ray_jobs' && { harvestedAt: null }),
        remoteCleanupDisposition: 'pending',
        status: { in: ['submitted', 'running', 'success', 'timeout', 'failed'] },
        operations: { none: { kind: 'cancel', phase: 'active' } }
      },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    return this.excludeDeletingOwners(this.toLifecycleJobs(rows))
  }

  async replaceHostedJournal(
    job: ComputeJob,
    next: string,
    fenceCancellation: boolean
  ): Promise<boolean> {
    return this.updateFencedJob('hugging_face_jobs', job, { remoteHandle: next }, fenceCancellation)
  }

  async rejectHostedSubmission(job: ComputeJob, status: number): Promise<boolean> {
    return this.updateFencedJob(
      'hugging_face_jobs',
      job,
      {
        status: 'error',
        errorCode: 'dispatch_failed',
        remoteHandle: JSON.stringify({ ...readHostedJournal(job), launchNotStarted: true }),
        errorMessage: `Hugging Face rejected job creation (HTTP ${status}). Review the account or job configuration before submitting again.`,
        lastPollError: null,
        finishedAt: new Date()
      },
      false
    )
  }

  async replaceRayJournal(
    job: ComputeJob,
    next: string,
    fenceCancellation: boolean
  ): Promise<boolean> {
    return this.updateFencedJob('ray_jobs', job, { remoteHandle: next }, fenceCancellation)
  }

  rejectRayCreation(job: ComputeJob, status: number): Promise<boolean> {
    return this.updateFencedJob(
      'ray_jobs',
      job,
      {
        status: 'error',
        errorCode: 'dispatch_failed',
        errorMessage: `Ray rejected the submission (HTTP ${status}). Check the cluster configuration before submitting again.`,
        lastPollError: null,
        finishedAt: new Date()
      },
      false
    )
  }

  async replaceModalJournal(
    job: ComputeJob,
    next: string,
    fenceCancellation: boolean
  ): Promise<boolean> {
    return this.updateFencedJob('modal_sandbox', job, { remoteHandle: next }, fenceCancellation)
  }

  async markModalCreationUnconfirmed(job: ComputeJob): Promise<boolean> {
    return this.updateFencedJob(
      'modal_sandbox',
      job,
      { lastPollError: MODAL_CREATION_UNCONFIRMED },
      false
    )
  }
  async expireUnlaunchedModalJob(job: ComputeJob, noVolume: boolean): Promise<boolean> {
    const journal = readModalJournal(job)
    return this.updateFencedJob(
      'modal_sandbox',
      job,
      {
        status: 'timeout',
        errorCode: 'timeout',
        finishedAt: new Date(),
        harvestedAt: new Date(),
        remoteHandle: withUnstartedModalLaunch(journal),
        harvestError: noVolume
          ? null
          : 'Deadline elapsed before launch; staged files are retained.',
        lastPollError: null
      },
      false,
      noVolume
    )
  }
  async rejectModalSubmission(job: ComputeJob, message: string): Promise<boolean> {
    const journal = readModalJournal(job)
    return this.updateFencedJob(
      'modal_sandbox',
      job,
      {
        status: 'error',
        errorCode: 'dispatch_failed',
        errorMessage: message,
        remoteHandle: withUnstartedModalLaunch(journal),
        lastPollError: null,
        finishedAt: new Date()
      },
      false,
      !journal.volume?.id
    )
  }

  private async updateFencedJob(
    mode: JournalMode,
    job: ComputeJob,
    updates: UpdateJobRequest,
    fenceCancellation: boolean,
    noVolume = false
  ): Promise<boolean> {
    const client = await this.getClient()
    const where = {
      id: job.job_id,
      providerId: job.provider_id,
      sessionId: job.session_id,
      projectId: job.project_id,
      executionMode: mode,
      status: job.status,
      remoteCleanupDisposition: 'pending'
    }
    const row = await client.computeJob.findFirst({ where })
    if (
      !row ||
      !this.isOwnerMutable(row.projectId, row.sessionId) ||
      this.revealJsonOptional(row.remoteHandle, 'object', row.sensitiveDataEncrypted === true) !==
        job.remote_handle
    )
      return false
    const updated = await client.computeJob.updateMany({
      where: {
        ...where,
        remoteHandle: row.remoteHandle,
        ...(fenceCancellation && { operations: { none: { kind: 'cancel', phase: 'active' } } })
      },
      data: {
        ...this.toUpdateData(updates, row.sensitiveDataEncrypted === true),
        ...(noVolume && { remoteCleanupDisposition: 'cleaned' })
      }
    })
    return updated.count === 1
  }
  // Queue promotion is shared across backends; each promoted job keeps its approved execution mode.
  async findQueuedJobs(): Promise<ComputeJob[]> {
    const client = await this.getClient()
    const rows = await client.computeJob.findMany({
      where: { status: 'queued', operations: { none: { kind: 'cancel' } } },
      include: { operations: { where: { kind: 'cancel' } } },
      orderBy: { createdAt: 'asc' }
    })
    return this.toLifecycleJobs(rows)
  }

  private readonly toJob = (row: PrismaComputeJobWithOperation): ComputeJob => {
    const mode = row.executionMode ?? 'direct_ssh'
    if (
      mode !== 'slurm' &&
      mode !== 'direct_ssh' &&
      mode !== 'modal_sandbox' &&
      mode !== 'hugging_face_jobs' &&
      mode !== 'ray_jobs' &&
      mode !== 'kubernetes'
    )
      throw new Error('Unknown Compute Job backend.')
    const sensitive = this.projectSensitiveFields(row)
    const integrityIssues = this.integrityIssues(row, sensitive)
    return {
      job_id: row.id,
      provider_id: row.providerId,
      shape: row.shape,
      execution_mode: mode,
      session_id: row.sessionId,
      project_id: row.projectId,
      status: asStatus(row.status),
      ...(!isKnownComputeJobStatus(row.status) ? { raw_status: row.status } : {}),
      ...(integrityIssues.length > 0
        ? { integrity_issues: integrityIssues, needs_attention: true }
        : {}),
      cancellation_status:
        row.operations?.[0]?.phase === 'active'
          ? 'cancelling'
          : row.operations?.[0]?.outcome === 'fulfilled'
            ? 'cancelled'
            : row.operations?.[0]?.outcome === 'failed'
              ? 'failed'
              : undefined,
      ...(row.operations?.[0]?.outcome === 'failed' &&
      row.operations[0].errorCode &&
      sensitive.cancellationErrorMessage
        ? {
            cancellation_error: {
              code: row.operations[0].errorCode,
              message: sensitive.cancellationErrorMessage
            },
            cancellation_revision: row.operations[0].revision
          }
        : {}),
      intent: sensitive.intent,
      command: sensitive.command,
      command_hash: row.commandHash,
      environment: sensitive.environment,
      resource_request: sensitive.resourceRequest,
      input_manifest: sensitive.inputManifest,
      producer_run_id: row.producerRunId ?? undefined,
      file_evidence: parseFileEvidence(row),
      output_manifest: sensitive.outputManifest,
      harvest_config: sensitive.harvestConfig,
      timeout_seconds: row.timeoutSeconds ?? undefined,
      remote_workdir: sensitive.remoteWorkdir,
      remote_handle: sensitive.remoteHandle,
      remote_cleanup_disposition: asRemoteCleanupDisposition(row.remoteCleanupDisposition),
      exit_code: row.exitCode ?? undefined,
      stdout_tail: sensitive.stdoutTail,
      stderr_tail: sensitive.stderrTail,
      error_code: row.errorCode ?? undefined,
      error_message: sensitive.errorMessage,
      last_poll_error: sensitive.lastPollError,
      harvest_error: sensitive.harvestError,
      left_on_remote: sensitive.leftOnRemote,
      notified_at: row.notifiedAt?.getTime(),
      notification_consumed_at: row.notificationConsumedAt?.getTime(),
      analysis_state: asAnalysisState(row.analysisState),
      analysis_message_id: row.analysisMessageId ?? undefined,
      analysis_updated_at: row.analysisUpdatedAt?.getTime(),
      created_at: row.createdAt.getTime(),
      submitted_at: row.submittedAt?.getTime(),
      started_at: row.startedAt?.getTime(),
      finished_at: row.finishedAt?.getTime(),
      harvested_at: row.harvestedAt?.getTime()
    }
  }

  private projectSensitiveFields(row: PrismaComputeJobWithOperation): SensitiveJobProjection {
    const encrypted = row.sensitiveDataEncrypted === true
    let unavailable = false
    const safely = <Value>(operation: () => Value, fallback: Value): Value => {
      try {
        return operation()
      } catch {
        unavailable = true
        return fallback
      }
    }
    return {
      intent: safely(() => this.reveal(row.intent, encrypted), ''),
      command: safely(() => this.reveal(row.command, encrypted), ''),
      environment: safely(() => this.revealOptional(row.environment, encrypted), undefined),
      resourceRequest: safely(
        () => this.revealJsonOptional(row.resourceRequest, 'object', encrypted),
        undefined
      ),
      inputManifest: safely(
        () => this.revealJsonOptional(row.inputManifest, 'array', encrypted),
        undefined
      ),
      outputManifest: safely(
        () => this.revealJsonOptional(row.outputManifest, 'array', encrypted),
        undefined
      ),
      harvestConfig: safely(
        () => this.revealJsonOptional(row.harvestConfig, 'object', encrypted),
        undefined
      ),
      remoteWorkdir: safely(() => this.revealOptional(row.remoteWorkdir, encrypted), undefined),
      remoteHandle: safely(
        () => this.revealJsonOptional(row.remoteHandle, 'object', encrypted),
        undefined
      ),
      stdoutTail: safely(() => this.revealOptional(row.stdoutTail, encrypted), undefined),
      stderrTail: safely(() => this.revealOptional(row.stderrTail, encrypted), undefined),
      lastPollError: safely(() => this.revealOptional(row.lastPollError, encrypted), undefined),
      errorMessage: safely(() => this.revealOptional(row.errorMessage, encrypted), undefined),
      cancellationErrorMessage: safely(
        () => this.revealOptional(row.operations?.[0]?.errorMessage ?? null, encrypted),
        undefined
      ),
      harvestError: safely(() => this.revealOptional(row.harvestError, encrypted), undefined),
      leftOnRemote: safely(
        () => this.revealJsonOptional(row.leftOnRemote, 'array', encrypted),
        undefined
      ),
      get unavailable() {
        return unavailable
      }
    }
  }

  private integrityIssues(
    row: PrismaComputeJob,
    sensitive: SensitiveJobProjection
  ): ComputeJobIntegrityIssue[] {
    return classifyComputeJobIntegrity(row, {
      remoteWorkdir: sensitive.remoteWorkdir ?? null,
      remoteHandle: sensitive.remoteHandle ?? null,
      unavailable: sensitive.unavailable
    })
  }

  private toLifecycleJobs(rows: PrismaComputeJobWithOperation[]): ComputeJob[] {
    return rows
      .map(this.toJob)
      .filter(
        (job) =>
          !job.integrity_issues?.some(
            (issue) =>
              issue.disposition === 'quarantined' || issue.code === 'sensitive-fields-unavailable'
          )
      )
  }

  private toUpdateData(
    updates: UpdateJobRequest,
    sensitiveDataEncrypted: boolean
  ): ComputeJobUpdateData {
    const data: ComputeJobUpdateData = {}

    if (updates.status !== undefined) data.status = updates.status
    if (updates.remoteHandle !== undefined)
      data.remoteHandle = this.protectJson(updates.remoteHandle, 'object', sensitiveDataEncrypted)
    if (updates.remoteWorkdir !== undefined)
      data.remoteWorkdir = this.protectOptional(updates.remoteWorkdir, sensitiveDataEncrypted)
    if ('exitCode' in updates) data.exitCode = updates.exitCode
    if ('stdoutTail' in updates)
      data.stdoutTail =
        updates.stdoutTail === null
          ? null
          : this.protectOptional(updates.stdoutTail, sensitiveDataEncrypted)
    if ('stderrTail' in updates)
      data.stderrTail =
        updates.stderrTail === null
          ? null
          : this.protectOptional(updates.stderrTail, sensitiveDataEncrypted)
    if ('errorCode' in updates) data.errorCode = updates.errorCode
    if ('errorMessage' in updates)
      data.errorMessage =
        updates.errorMessage === null
          ? null
          : this.protectOptional(updates.errorMessage, sensitiveDataEncrypted)
    if ('lastPollError' in updates)
      data.lastPollError =
        updates.lastPollError === null
          ? null
          : this.protectOptional(updates.lastPollError, sensitiveDataEncrypted)
    if (updates.submittedAt !== undefined) data.submittedAt = updates.submittedAt
    if (updates.startedAt !== undefined) data.startedAt = updates.startedAt
    if (updates.finishedAt !== undefined) data.finishedAt = updates.finishedAt
    if (updates.harvestedAt !== undefined) data.harvestedAt = updates.harvestedAt
    if ('harvestError' in updates)
      data.harvestError =
        updates.harvestError === null
          ? null
          : this.protectOptional(updates.harvestError, sensitiveDataEncrypted)
    if ('leftOnRemote' in updates)
      data.leftOnRemote =
        updates.leftOnRemote === null
          ? null
          : this.protectJsonOptional(updates.leftOnRemote, 'array', sensitiveDataEncrypted)
    if ('notifiedAt' in updates) data.notifiedAt = updates.notifiedAt
    if ('notificationConsumedAt' in updates)
      data.notificationConsumedAt = updates.notificationConsumedAt
    if (updates.fileEvidence !== undefined) data.fileEvidence = JSON.stringify(updates.fileEvidence)

    return data
  }

  private protect(value: string, sensitiveDataEncrypted: boolean): string {
    return sensitiveDataEncrypted ? this.fieldProtection.protect(value) : value
  }

  private protectOptional(
    value: string | undefined,
    sensitiveDataEncrypted: boolean
  ): string | undefined {
    return value === undefined ? undefined : this.protect(value, sensitiveDataEncrypted)
  }

  private protectJson(
    value: string,
    container: ProtectedJsonContainer,
    sensitiveDataEncrypted: boolean
  ): string {
    return sensitiveDataEncrypted ? this.fieldProtection.protectJson(value, container) : value
  }

  private protectJsonOptional(
    value: string | undefined,
    container: ProtectedJsonContainer,
    sensitiveDataEncrypted: boolean
  ): string | undefined {
    return value === undefined
      ? undefined
      : this.protectJson(value, container, sensitiveDataEncrypted)
  }

  private reveal(value: string, sensitiveDataEncrypted: boolean): string {
    return sensitiveDataEncrypted ? this.fieldProtection.reveal(value) : value
  }

  private revealOptional(
    value: string | null,
    sensitiveDataEncrypted: boolean
  ): string | undefined {
    return value === null ? undefined : this.reveal(value, sensitiveDataEncrypted)
  }

  private revealJsonOptional(
    value: string | null,
    container: ProtectedJsonContainer,
    sensitiveDataEncrypted: boolean
  ): string | undefined {
    return value === null
      ? undefined
      : sensitiveDataEncrypted
        ? this.fieldProtection.revealJson(value, container)
        : value
  }

  private assertOwnerMutable(projectId: string, sessionId: string): void {
    if (!this.isOwnerMutable(projectId, sessionId)) {
      throw new Error('Cannot create a Compute Job while its owner is being deleted.')
    }
  }

  private excludeDeletingOwners(jobs: ComputeJob[]): ComputeJob[] {
    return jobs.filter((job) => this.isOwnerMutable(job.project_id, job.session_id))
  }

  private isOwnerMutable(projectId: string, sessionId: string): boolean {
    return (
      !this.deletingProjects.has(projectId) &&
      !this.deletingSessions.has(sessionOwnerKey(projectId, sessionId))
    )
  }

  private runMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

const parseFileEvidence = (row: PrismaComputeJob): ExecutionFileEvidenceSummary | undefined => {
  if (row.fileEvidence === null) return undefined
  try {
    return parseOwnedExecutionFileEvidenceSummary(JSON.parse(row.fileEvidence), {
      activityId: row.id,
      activityKind: 'compute-job',
      parentActivityId: row.producerRunId ?? undefined,
      storageKey: `execution-file-evidence/${row.projectId}/${row.sessionId}/activity-${row.id}/evidence.json`
    })
  } catch {
    return undefined
  }
}

export type { ComputeJobClient, ComputeJobClientProvider, ComputeJobFieldProtection }
