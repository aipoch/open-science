import type {
  ComputeHost,
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
  type RawInputSpec
} from './compute-job-workflow-owner'
import { ComputeRemoteOperationOwner } from './compute-remote-operation-owner'
import type { ConcurrencyManager, SessionStatus } from './concurrency-manager'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ScpRunner } from './scp-runner'
import { SystemScpRunner } from './scp-runner'
import type { SshRunner } from './ssh-runner'

export { parseProbeOutput } from './compute-host-profile-owner'
export type { ProbeScriptOutput } from './compute-host-profile-owner'
export { resolveInputs } from './compute-job-workflow-owner'
export type { ArtifactResolver, RawInputSpec } from './compute-job-workflow-owner'

// Stable facade composed from private host-profile, remote-operation and job workflows.
export class ComputeService {
  private readonly hostProfiles: ComputeHostProfileOwner
  private readonly remoteOperations: ComputeRemoteOperationOwner
  private readonly jobWorkflow: ComputeJobWorkflowOwner

  constructor(
    runner: SshRunner,
    private readonly repository: ComputeHostRepository,
    approvalBroker?: ComputeApprovalBroker,
    scpRunner?: ScpRunner,
    overrideDownloadsDir?: string,
    jobRepository?: ComputeJobRepository,
    onJobUpdated?: (job: ComputeJob) => void,
    artifactResolver?: ArtifactResolver,
    storageRoot?: string,
    concurrencyManager?: ConcurrencyManager
  ) {
    const effectiveScpRunner = scpRunner ?? new SystemScpRunner()
    this.hostProfiles = new ComputeHostProfileOwner(runner, repository)
    this.remoteOperations = new ComputeRemoteOperationOwner(
      runner,
      repository,
      approvalBroker,
      effectiveScpRunner,
      overrideDownloadsDir
    )
    this.jobWorkflow = new ComputeJobWorkflowOwner(
      runner,
      repository,
      approvalBroker,
      effectiveScpRunner,
      jobRepository,
      onJobUpdated,
      artifactResolver,
      storageRoot,
      concurrencyManager
    )
  }

  async probe(providerId: string): Promise<ProbeResult> {
    return this.hostProfiles.probe(providerId)
  }

  async list(): Promise<ComputeHost[]> {
    return this.repository.list()
  }

  async getDetails(providerId: string): Promise<{ doc: string; isSkeleton: boolean }> {
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

  async setConcurrencyLimit(providerId: string, limit: number): Promise<void> {
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
    context?: { sessionId: string; projectId: string }
  ): Promise<ExecResult> {
    return this.remoteOperations.callCommand(
      providerId,
      cmd,
      intent,
      loginShell,
      timeoutSeconds,
      context
    )
  }

  async download(
    providerId: string,
    remotePath: string,
    dest: DownloadDest,
    context?: { sessionId: string; projectId: string }
  ): Promise<LocalFile> {
    return this.remoteOperations.download(providerId, remotePath, dest, context)
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
    context: { sessionId: string; projectId: string }
  ): Promise<SubmitJobResult> {
    return this.jobWorkflow.submitJob(providerId, intent, command, options, context)
  }

  async getJobStatus(jobId: string): Promise<import('../../shared/compute').JobStatusResult> {
    return this.jobWorkflow.getJobStatus(jobId)
  }

  async getJobResult(jobId: string): Promise<JobResult> {
    return this.jobWorkflow.getJobResult(jobId)
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
}
