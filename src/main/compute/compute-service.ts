import type {
  ComputeHost,
  ComputeHostDetails,
  ComputeJob,
  DetailsAuthor,
  ExecResult,
  JobResult,
  ProbeResult,
  SubmitJobResult
} from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile } from '../../shared/remote-fs'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeHostProfileOwner } from './compute-host-profile-owner'
import {
  ComputeJobWorkflowOwner,
  type ArtifactResolver,
  type ComputeJobReadScope,
  type RawInputSpec
} from './compute-job-workflow-owner'
import { ComputeRemoteOperationOwner } from './compute-remote-operation-owner'
import type { ConcurrencyManager, SessionStatus } from './concurrency-manager'
import type { ComputeConnectionBroker } from './connection-broker'
import type { CredentialVault } from './credential-vault'
import type { ComputeJobRepository } from './job-repository'
import { ComputeJobCancellationOwner } from './compute-job-cancellation-owner'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import type { ComputeHostRepository } from './repository'
import type { ScpRunner } from './scp-runner'
import type { SshRunner } from './ssh-runner'
import { SessionCacheOwner } from './session-cache-owner'
import { cleanupComputeJobFileEvidence } from '../notebook/working-file-observer'
import { createLogger, errorLogFields } from '../logger'
import {
  createSshConfigCompatibilityBroker,
  projectComputeCredentialStatus
} from './authentication-runtime'

export { parseProbeOutput } from './compute-host-profile-owner'
export type { ProbeScriptOutput } from './compute-host-profile-owner'
export { createComputeArtifactResolver, resolveInputs } from './compute-job-workflow-owner'
export type {
  ArtifactResolver,
  ComputeJobReadScope,
  RawInputSpec
} from './compute-job-workflow-owner'

const log = createLogger('compute')

export type ComputeServiceDependencies = Readonly<{
  runner: SshRunner
  repository: ComputeHostRepository
  approvalBroker?: ComputeApprovalBroker
  scpRunner?: ScpRunner
  overrideDownloadsDir?: string
  jobRepository?: ComputeJobRepository
  operationRepository?: ComputeJobOperationRepository
  onJobUpdated?: (job: ComputeJob) => void
  artifactResolver?: ArtifactResolver
  storageRoot?: string
  sessionCacheOwner?: SessionCacheOwner
  concurrencyManager?: ConcurrencyManager
  connectionBroker?: ComputeConnectionBroker
  credentialVault?: Pick<CredentialVault, 'credentialStatus'>
}>

// Stable facade composed from private host-profile, remote-operation and job workflows.
export class ComputeService {
  private readonly hostProfiles: ComputeHostProfileOwner
  private readonly remoteOperations: ComputeRemoteOperationOwner
  private readonly jobWorkflow: ComputeJobWorkflowOwner
  private readonly jobCancellation?: ComputeJobCancellationOwner
  private readonly repository: ComputeHostRepository
  private readonly concurrencyManager?: ConcurrencyManager
  private readonly credentialVault?: Pick<CredentialVault, 'credentialStatus'>
  private readonly storageRoot?: string

  constructor(dependencies: ComputeServiceDependencies) {
    const {
      runner,
      repository,
      approvalBroker,
      scpRunner,
      overrideDownloadsDir,
      jobRepository,
      operationRepository,
      onJobUpdated,
      artifactResolver,
      storageRoot,
      sessionCacheOwner,
      concurrencyManager,
      connectionBroker,
      credentialVault
    } = dependencies
    this.repository = repository
    this.concurrencyManager = concurrencyManager
    this.credentialVault = credentialVault
    this.storageRoot = storageRoot
    const effectiveConnectionBroker =
      connectionBroker ?? createSshConfigCompatibilityBroker(repository, runner, scpRunner)
    this.hostProfiles = new ComputeHostProfileOwner(effectiveConnectionBroker, repository)
    this.remoteOperations = new ComputeRemoteOperationOwner(
      effectiveConnectionBroker,
      repository,
      approvalBroker,
      overrideDownloadsDir,
      sessionCacheOwner ?? (storageRoot ? new SessionCacheOwner(storageRoot) : undefined)
    )
    this.jobWorkflow = new ComputeJobWorkflowOwner(
      effectiveConnectionBroker,
      repository,
      approvalBroker,
      jobRepository,
      onJobUpdated,
      artifactResolver,
      storageRoot,
      concurrencyManager
    )
    this.jobCancellation =
      operationRepository && jobRepository
        ? new ComputeJobCancellationOwner(operationRepository, jobRepository)
        : undefined
  }

  async probe(providerId: string, signal?: AbortSignal): Promise<ProbeResult> {
    return this.hostProfiles.probe(providerId, signal)
  }

  async list(): Promise<ComputeHost[]> {
    const hosts = await this.repository.list()
    const credentialVault = this.credentialVault
    if (!credentialVault) return hosts
    return Promise.all(hosts.map((host) => projectComputeCredentialStatus(host, credentialVault)))
  }

  async getDetails(providerId: string): Promise<ComputeHostDetails> {
    return this.hostProfiles.getDetails(providerId)
  }

  async replaceDetails(
    providerId: string,
    request: { text: string; oldText: string; author: DetailsAuthor }
  ): Promise<void> {
    return this.hostProfiles.replaceDetails(providerId, request)
  }

  async appendDetails(
    providerId: string,
    request: { text: string; author: DetailsAuthor }
  ): Promise<void> {
    return this.hostProfiles.appendDetails(providerId, request)
  }

  async setScratchRoot(providerId: string, path: string): Promise<void> {
    return this.hostProfiles.setScratchRoot(providerId, path)
  }

  async clearScratchRoot(providerId: string): Promise<void> {
    return this.hostProfiles.clearScratchRoot(providerId)
  }

  async setConcurrencyLimit(providerId: string, limit: number): Promise<void> {
    if (this.concurrencyManager) {
      return this.concurrencyManager.setProviderLimit(providerId, limit)
    }
    return this.hostProfiles.setConcurrencyLimit(providerId, limit)
  }

  async listDir(providerId: string, path: string): Promise<DirListing> {
    return this.remoteOperations.listDir(providerId, path)
  }

  async callCommand(
    providerId: string,
    cmd: string,
    intent: string,
    loginShell = true,
    timeoutSeconds?: number,
    context?: { sessionId: string; projectId: string },
    signal?: AbortSignal
  ): Promise<ExecResult> {
    return this.remoteOperations.callCommand(
      providerId,
      cmd,
      intent,
      loginShell,
      timeoutSeconds,
      context,
      signal
    )
  }

  async download(
    providerId: string,
    remotePath: string,
    dest: DownloadDest,
    context?: { sessionId: string; projectId: string },
    signal?: AbortSignal
  ): Promise<LocalFile> {
    return this.remoteOperations.download(providerId, remotePath, dest, context, signal)
  }

  async submitJob(
    providerId: string,
    intent: string,
    command: string,
    options: {
      environment?: string
      resourceRequest?: string
      inputs?: RawInputSpec[]
      outputManifest?: string
      harvestConfig?: string
      timeoutSeconds?: number
      workspaceCwd?: string
    },
    context: { sessionId: string; projectId: string; producerRunId?: string },
    signal?: AbortSignal
  ): Promise<SubmitJobResult> {
    return this.jobWorkflow.submitJob(providerId, intent, command, options, context, signal)
  }

  async getJobStatus(
    jobId: string,
    scope?: ComputeJobReadScope
  ): Promise<import('../../shared/compute').JobStatusResult> {
    return this.jobWorkflow.getJobStatus(jobId, scope)
  }

  async getJobResult(jobId: string, scope?: ComputeJobReadScope): Promise<JobResult> {
    return this.jobWorkflow.getJobResult(jobId, scope)
  }

  async cancelJob(
    jobId: string,
    scope: ComputeJobReadScope
  ): Promise<import('../../shared/compute').JobStatusResult> {
    if (!this.jobCancellation) {
      throw new Error('ComputeJobOperationRepository is required to call cancelJob.')
    }
    const result = await this.jobCancellation.request(jobId, scope)
    const job = await this.jobWorkflow.getJob(jobId, scope)
    if (
      result.cancellation_status === 'cancelled' &&
      job.submitted_at === undefined &&
      this.storageRoot
    ) {
      await cleanupComputeJobFileEvidence({
        storageRoot: this.storageRoot,
        projectId: job.project_id,
        sessionId: job.session_id,
        jobId
      }).catch((error) =>
        log.warn('Queued Compute Job file-evidence cleanup deferred to startup recovery.', {
          jobId,
          ...errorLogFields(error)
        })
      )
    }
    this.handleJobUpdated(job)
    if (result.cancellation_status === 'cancelled') {
      await this.concurrencyManager?.onJobCompleted()
    }
    return result
  }

  handleJobCancellationConfirmed = async (job: ComputeJob): Promise<void> => {
    this.handleJobUpdated(job)
    await this.concurrencyManager?.onJobCompleted()
  }

  async setSessionConcurrencyLimit(sessionId: string, limit: number): Promise<void> {
    return this.jobWorkflow.setSessionConcurrencyLimit(sessionId, limit)
  }

  async getSessionConcurrencyStatus(sessionId: string): Promise<SessionStatus> {
    return this.jobWorkflow.getSessionConcurrencyStatus(sessionId)
  }

  handleJobUpdated = (job: ComputeJob): void => {
    this.jobWorkflow.handleJobUpdated(job)
  }

  startQueueReconciliation = async (): Promise<void> => {
    await this.concurrencyManager?.startQueueReconciliation()
  }

  stopQueueReconciliation = async (): Promise<void> => {
    await this.concurrencyManager?.stopQueueReconciliation()
  }
}
