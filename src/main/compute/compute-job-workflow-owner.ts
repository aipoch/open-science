import { randomUUID } from 'node:crypto'
import { readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import type {
  ComputeCallError,
  ComputeJob,
  JobResult,
  JobStatusResult,
  SubmitJobResult
} from '../../shared/compute'
import { ComputeHostUnavailableError } from '../../shared/compute'
import { resolveNotebookStagedInputPath } from '../notebook/input-staging'
import { getNotebookSessionRoot } from '../notebook/repository'
import { encodeDataPath } from '../storage/data-path'
import {
  beginComputeJobFileEvidence,
  cleanupComputeJobFileEvidence
} from '../notebook/working-file-observer'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import { projectJobStatus } from './compute-job-status'
import type { ConcurrencyManager, SessionStatus } from './concurrency-manager'
import { sharedDispatchTracker } from './dispatch-tracker'
import { computeRemoteWorkdir, dispatchJob, hashCommand } from './job-dispatcher'
import type { StagedInputEntry } from './job-dispatcher'
import {
  type ComputeJobRepository,
  UnencryptedComputeJobPersistenceApprovalRequiredError
} from './job-repository'
import { validateHarvestConfig } from './harvest-classifier'
import type { ComputeHostRepository } from './repository'
import { GLOB_CHARS, SHELL_UNSAFE_CHARS } from './remote-path-security'
import { getJobHarvestDir, workspaceRelativePath } from './workspace-path'

const COMMAND_PREVIEW_MAX_LEN = 120
const JOB_MAX_TIMEOUT_SECONDS = 7 * 24 * 3600
const JOB_DEFAULT_TIMEOUT_SECONDS = 24 * 3600
const TERMINAL_JOB_STATUSES: ReadonlySet<ComputeJob['status']> = new Set([
  'success',
  'failed',
  'timeout',
  'error'
])

export type RawInputSpec =
  { src: string; dst_filename: string } | { remote_path: string; dst_filename?: string }

export type ComputeJobReadScope = Readonly<{
  projectId: string
  sessionId: string
  providerId: string
}>

export interface ArtifactResolver {
  resolveArtifactPath(path: string, scope?: ComputeJobReadScope): Promise<string>
}

export const createComputeArtifactResolver = (
  storageRoot: string,
  resolveManagedArtifactPath: (path: string) => Promise<string>
): ArtifactResolver => ({
  resolveArtifactPath: async (path, scope) => {
    if (scope) {
      const staged = await resolveNotebookStagedInputPath(
        storageRoot,
        scope.projectId,
        scope.sessionId,
        path
      )
      if (staged) return staged
      throw new Error('Compute input is not staged for the submitting Project and Session.')
    }
    return resolveManagedArtifactPath(path)
  }
})

const assertBareName = (name: string, label: string): void => {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(
      `dst_filename must be a bare filename with no path separators (got "${name}" for ${label})`
    )
  }
}

const resolveWorkspacePath = (workspaceCwd: string, srcPath: string): string => {
  const resolved = resolve(workspaceCwd, srcPath)
  const rel = relative(resolve(workspaceCwd), resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`workspace path "${srcPath}" would escape the workspace root "${workspaceCwd}"`)
  }
  return resolved
}

export const resolveInputs = async (
  rawInputs: RawInputSpec[],
  workspaceCwd: string | undefined,
  artifactResolver: ArtifactResolver | undefined,
  scope?: ComputeJobReadScope
): Promise<{ entries: StagedInputEntry[]; inputsSummary: string }> => {
  const entries: StagedInputEntry[] = []
  const summaryParts: string[] = []
  const destinations = new Set<string>()

  const reserveDestination = (dstFilename: string): void => {
    if (destinations.has(dstFilename)) {
      throw new Error(`dst_filename must be unique within a Compute Job (got "${dstFilename}")`)
    }
    destinations.add(dstFilename)
  }

  for (const raw of rawInputs) {
    if ('remote_path' in raw) {
      const remotePath = raw.remote_path
      if (!remotePath.startsWith('/')) {
        throw new Error(`remote_path must be an absolute path (got "${remotePath}")`)
      }
      if (GLOB_CHARS.test(remotePath)) {
        throw new Error(`remote_path must not contain glob characters (got "${remotePath}")`)
      }
      if (SHELL_UNSAFE_CHARS.test(remotePath)) {
        throw new Error(
          `remote_path must not contain shell-unsafe characters (got "${remotePath}")`
        )
      }
      const dstFilename = raw.dst_filename ?? basename(remotePath)
      assertBareName(dstFilename, `remote_path "${remotePath}"`)
      reserveDestination(dstFilename)
      entries.push({
        kind: 'symlink',
        remotePath,
        dstFilename,
        label: remotePath
      })
      summaryParts.push(`${dstFilename} (symlink)`)
      continue
    }

    const { src, dst_filename: dstFilename } = raw
    assertBareName(dstFilename, `src "${src}"`)
    reserveDestination(dstFilename)
    if (isAbsolute(src)) {
      if (!artifactResolver) {
        throw new Error(`Cannot resolve artifact "${src}": ArtifactResolver is not available`)
      }
      const localPath = scope
        ? await artifactResolver.resolveArtifactPath(src, scope)
        : await artifactResolver.resolveArtifactPath(src)
      entries.push({ kind: 'upload', localPath, dstFilename, label: src })
    } else {
      if (!workspaceCwd) {
        throw new Error(`Cannot resolve workspace path "${src}": workspace_cwd is not available`)
      }
      const localPath = resolveWorkspacePath(workspaceCwd, src)
      entries.push({ kind: 'upload', localPath, dstFilename, label: src })
    }
    summaryParts.push(dstFilename)
  }

  return {
    entries,
    inputsSummary:
      entries.length === 0
        ? ''
        : `${entries.length} input${entries.length === 1 ? '' : 's'}: ${summaryParts.join(', ')}`
  }
}

const queueFullError = (): Error & { computeCallError: ComputeCallError } => {
  const message =
    'Job queue is full (100 queued jobs). Wait for queued jobs to start running before submitting more.'
  const error = new Error(message) as Error & { computeCallError: ComputeCallError }
  error.computeCallError = {
    error_code: 'queue_full',
    message,
    retry_after_user_action: false
  }
  return error
}

export class ComputeJobWorkflowOwner {
  constructor(
    private readonly connectionBroker: ComputeConnectionBrokerAcquirer,
    private readonly hostRepository: ComputeHostRepository,
    private readonly approvalBroker: ComputeApprovalBroker | undefined,
    private readonly jobRepository: ComputeJobRepository | undefined,
    private readonly publishJobUpdated: ((job: ComputeJob) => void) | undefined,
    private readonly artifactResolver: ArtifactResolver | undefined,
    private readonly storageRoot: string | undefined,
    private readonly concurrencyManager: ConcurrencyManager | undefined,
    private readonly observeBackgroundDispatch?: (dispatch: Promise<void>) => void
  ) {}

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
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call submitJob.')
    }

    if (options.harvestConfig !== undefined) {
      let harvestConfig: unknown
      try {
        harvestConfig = JSON.parse(options.harvestConfig)
      } catch {
        throw new Error('harvest must be valid JSON.')
      }
      validateHarvestConfig(harvestConfig)
    }

    const host = await this.hostRepository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    const rawTimeout = options.timeoutSeconds
    if (rawTimeout !== undefined) {
      if (!Number.isFinite(rawTimeout)) {
        const error = new Error(
          `timeout_seconds must be a finite number (got ${rawTimeout}).`
        ) as Error & { computeCallError: ComputeCallError }
        error.computeCallError = {
          error_code: 'timeout',
          message: 'timeout_seconds must be a finite number.',
          retry_after_user_action: false
        }
        throw error
      }
      if (!Number.isInteger(rawTimeout) || rawTimeout <= 0) {
        const error = new Error(
          `timeout_seconds must be a positive integer (got ${rawTimeout}).`
        ) as Error & { computeCallError: ComputeCallError }
        error.computeCallError = {
          error_code: 'timeout',
          message: 'timeout_seconds must be a positive integer.',
          retry_after_user_action: false
        }
        throw error
      }
      if (rawTimeout > JOB_MAX_TIMEOUT_SECONDS) {
        const error = new Error(
          `timeout_seconds ${rawTimeout} exceeds the 7-day maximum. Use a scheduler driver for multi-day jobs.`
        ) as Error & { computeCallError: ComputeCallError }
        error.computeCallError = {
          error_code: 'timeout',
          message: `timeout_seconds exceeds the 7-day (${JOB_MAX_TIMEOUT_SECONDS}s) maximum.`,
          retry_after_user_action: false
        }
        throw error
      }
    }
    const timeoutSeconds = rawTimeout ?? JOB_DEFAULT_TIMEOUT_SECONDS

    let stagedEntries: StagedInputEntry[] = []
    let inputsSummary = ''
    if (options.inputs && options.inputs.length > 0) {
      const resolved = await resolveInputs(
        options.inputs,
        options.workspaceCwd,
        this.artifactResolver,
        { ...context, providerId }
      )
      stagedEntries = resolved.entries
      inputsSummary = resolved.inputsSummary
    }

    const jobId = randomUUID()
    const remoteWorkdir = computeRemoteWorkdir(host.scratchRoot, jobId)
    if (this.concurrencyManager) {
      const preview = await this.concurrencyManager.enqueue({
        jobId,
        sessionId: context.sessionId,
        providerId
      })
      if (preview === 'queue_full') throw queueFullError()
    }

    if (!this.approvalBroker) {
      throw new Error('ComputeApprovalBroker is required to call submitJob.')
    }
    const approvalBroker = this.approvalBroker
    const commandPreview =
      command.length > COMMAND_PREVIEW_MAX_LEN
        ? `${command.slice(0, COMMAND_PREVIEW_MAX_LEN)}…`
        : command
    const approvalInfo = {
      operation: 'submit_job' as const,
      provider_id: host.providerId,
      provider_name: host.displayName,
      shape: host.shape,
      intent,
      command_preview: commandPreview,
      command_full: command,
      inputs_summary: inputsSummary || undefined,
      resources: options.resourceRequest,
      timeout_seconds: timeoutSeconds,
      remote_workdir: remoteWorkdir
    }
    const approvalContext = {
      sessionId: context.sessionId,
      projectId: context.projectId,
      operation: 'submit_job' as const,
      ownerId: host.id
    }

    const requestApproval = async (willPersistUnencrypted: boolean): Promise<void> => {
      const decision = await approvalBroker.requestWithContext(
        {
          ...approvalInfo,
          ...(willPersistUnencrypted ? { willPersistUnencrypted: true } : {})
        },
        approvalContext,
        signal
      )

      if (decision === 'deny') {
        const error = new Error(
          `Job submission approval was denied for host "${host.displayName}".`
        ) as Error & { computeCallError: ComputeCallError }
        error.computeCallError = {
          error_code: 'approval_denied',
          message: `Approval denied for submit_job on ${host.displayName}.`,
          retry_after_user_action: false
        }
        throw error
      }
    }

    let allowUnencryptedPersistence = !this.jobRepository.isFieldProtectionAvailable()
    await requestApproval(allowUnencryptedPersistence)
    signal?.throwIfAborted()

    let evidenceCaptureStarted = false
    if (this.storageRoot) {
      const uploads = stagedEntries.filter(
        (entry): entry is Extract<StagedInputEntry, { kind: 'upload' }> => entry.kind === 'upload'
      )
      const frozen = await beginComputeJobFileEvidence({
        storageRoot: this.storageRoot,
        projectId: context.projectId,
        sessionId: context.sessionId,
        jobId,
        producerRunId: context.producerRunId,
        inputs: uploads.map((entry) => ({
          localPath: entry.localPath,
          dstFilename: entry.dstFilename,
          label: entry.label
        })),
        signal
      })
      const frozenByDestination = new Map(frozen.map((entry) => [entry.dstFilename, entry]))
      const evidenceStorageRoot = await realpath(this.storageRoot)
      stagedEntries = stagedEntries.map((entry) => {
        if (entry.kind !== 'upload') return entry
        const generation = frozenByDestination.get(entry.dstFilename)
        if (!generation) throw new Error(`Compute input could not be frozen: ${entry.label}`)
        return {
          ...entry,
          localPath: encodeDataPath(generation.frozenPath, evidenceStorageRoot)!,
          generationId: generation.generationId,
          checksum: generation.checksum,
          sizeBytes: generation.sizeBytes
        }
      })
      evidenceCaptureStarted = true
    }

    const commandHash = hashCommand(command)
    const inputManifest = stagedEntries.length > 0 ? JSON.stringify(stagedEntries) : undefined
    const jobRepository = this.jobRepository
    let dispatchHandoffHeld = false
    let rowCreated = false
    const createRow = async (initialStatus: 'submitted' | 'queued'): Promise<void> => {
      signal?.throwIfAborted()
      if (initialStatus === 'submitted') {
        sharedDispatchTracker.begin(jobId)
        dispatchHandoffHeld = true
      }
      const created = await jobRepository.create({
        id: jobId,
        providerId: host.providerId,
        shape: host.shape,
        sessionId: context.sessionId,
        projectId: context.projectId,
        intent,
        command,
        commandHash,
        environment: options.environment,
        resourceRequest: options.resourceRequest,
        inputManifest,
        producerRunId: context.producerRunId,
        fileEvidence: {
          schemaVersion: 1,
          activityId: jobId,
          activityKind: 'compute-job',
          ...(context.producerRunId ? { parentActivityId: context.producerRunId } : {}),
          state: 'unavailable',
          scientificOutputCount: 0,
          initialViewState: evidenceCaptureStarted ? 'complete' : 'unavailable',
          managedRootsFinalState: 'unavailable',
          scientificOutputAnalysis: 'unavailable',
          fileReads: 'unavailable',
          externalPaths: 'unavailable',
          writerAttribution: context.producerRunId ? 'complete' : 'unavailable',
          reasonCodes: [
            ...(context.producerRunId ? [] : ['compute-activity-lineage-missing' as const]),
            'remote-output-not-harvested'
          ]
        },
        outputManifest: options.outputManifest,
        harvestConfig: options.harvestConfig,
        timeoutSeconds,
        remoteWorkdir,
        initialStatus,
        allowUnencryptedPersistence
      })
      rowCreated = true
      this.handleJobUpdated(created)
    }

    let initialStatus: 'submitted' | 'queued' = 'submitted'
    try {
      while (true) {
        try {
          if (this.concurrencyManager) {
            const admitted = await this.concurrencyManager.admit(
              { sessionId: context.sessionId, providerId },
              createRow
            )
            if (admitted === 'queue_full') throw queueFullError()
            initialStatus = admitted
          } else {
            await createRow('submitted')
          }

          if (initialStatus === 'submitted') {
            const dispatch = dispatchJob(jobId, {
              connectionBroker: this.connectionBroker,
              hostRepository: this.hostRepository,
              jobRepository: this.jobRepository,
              onJobUpdated: this.handleJobUpdated,
              storageRoot: this.storageRoot
            })
            this.observeBackgroundDispatch?.(dispatch)
            void dispatch
          }
          break
        } catch (error) {
          if (
            allowUnencryptedPersistence ||
            !(error instanceof UnencryptedComputeJobPersistenceApprovalRequiredError)
          ) {
            throw error
          }
          await requestApproval(true)
          allowUnencryptedPersistence = true
        } finally {
          if (dispatchHandoffHeld) {
            sharedDispatchTracker.end(jobId)
            dispatchHandoffHeld = false
          }
        }
      }
    } catch (error) {
      if (evidenceCaptureStarted && !rowCreated && this.storageRoot) {
        const rowDefinitelyAbsent = await jobRepository
          .get(jobId)
          .then((job) => job === null)
          .catch(() => false)
        if (rowDefinitelyAbsent) {
          await cleanupComputeJobFileEvidence({
            storageRoot: this.storageRoot,
            projectId: context.projectId,
            sessionId: context.sessionId,
            jobId
          }).catch(() => undefined)
        }
      }
      throw error
    }

    return {
      job_id: jobId,
      provider_id: host.providerId,
      status: initialStatus,
      remote_workdir: remoteWorkdir
    }
  }

  async getJobStatus(jobId: string, scope?: ComputeJobReadScope): Promise<JobStatusResult> {
    const job = await this.getJob(jobId, scope)
    return projectJobStatus(job, job.cancellation_status)
  }

  async getJob(jobId: string, scope?: ComputeJobReadScope): Promise<ComputeJob> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to read Compute Jobs.')
    }
    const job = await this.jobRepository.get(jobId)
    if (!job) {
      if (scope) throw new ComputeHostUnavailableError()
      throw new Error(`No compute job found with id "${jobId}".`)
    }
    if (
      scope &&
      (job.project_id !== scope.projectId ||
        job.session_id !== scope.sessionId ||
        job.provider_id !== scope.providerId)
    ) {
      throw new ComputeHostUnavailableError()
    }
    return job
  }

  async getJobResult(jobId: string, scope?: ComputeJobReadScope): Promise<JobResult> {
    const job = await this.getJob(jobId, scope)

    let leftOnRemote: Array<{ uri: string; size_mb: number; reason: string }> = []
    if (job.left_on_remote) {
      try {
        leftOnRemote = JSON.parse(job.left_on_remote) as typeof leftOnRemote
      } catch {
        // Preserve the existing projection for malformed persisted JSON.
      }
    }

    if (!TERMINAL_JOB_STATUSES.has(job.status) || !job.harvested_at) {
      return jobResultWithFiles(job, [], [], [])
    }
    if (!this.storageRoot) {
      return jobResultWithFiles(job, [], [], leftOnRemote)
    }
    if (job.harvest_error) {
      return jobResultWithFiles(job, [], [], leftOnRemote)
    }

    const harvestDir = getJobHarvestDir(
      this.storageRoot,
      job.project_id,
      job.session_id,
      job.job_id
    )
    const workspaceCwd = getNotebookSessionRoot(this.storageRoot, job.project_id, job.session_id)
    const featuredFiles = await scanDirRelative(join(harvestDir, 'featured'), workspaceCwd)
    const hiddenFiles = await scanDirRelative(join(harvestDir, 'hidden'), workspaceCwd)
    return jobResultWithFiles(job, featuredFiles, hiddenFiles, leftOnRemote)
  }

  async setSessionConcurrencyLimit(sessionId: string, limit: number): Promise<void> {
    if (!this.concurrencyManager) {
      throw new Error('ConcurrencyManager is required to set session concurrency limit.')
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(
        `Session concurrency limit must be an integer in the range 1..500 (got ${limit}).`
      )
    }
    await this.concurrencyManager.setSessionLimit(sessionId, limit)
  }

  async getSessionConcurrencyStatus(sessionId: string): Promise<SessionStatus> {
    if (!this.concurrencyManager) {
      throw new Error('ConcurrencyManager is required to get session concurrency status.')
    }
    const status = await this.concurrencyManager.getStatus(sessionId)
    for (const host of await this.hostRepository.list()) {
      if (!(host.providerId in status.provider_ceilings)) {
        status.provider_ceilings[host.providerId] = host.concurrencyLimit ?? 10
      }
    }
    return status
  }

  handleJobUpdated = (job: ComputeJob): void => {
    if (this.concurrencyManager) this.concurrencyManager.handleJobUpdated(job)
    else this.publishJobUpdated?.(job)
  }
}

const jobResultWithFiles = (
  job: ComputeJob,
  featuredFiles: string[],
  hiddenFiles: string[],
  leftOnRemote: Array<{ uri: string; size_mb: number; reason: string }>
): JobResult => ({
  job_id: job.job_id,
  status: job.status,
  cancellation_status: job.cancellation_status,
  exit_code: job.exit_code,
  featured_files: featuredFiles,
  hidden_files: hiddenFiles,
  output_files: [...featuredFiles, ...hiddenFiles],
  left_on_remote: leftOnRemote,
  remote_workdir: job.remote_workdir,
  stdout_tail: job.stdout_tail,
  stderr_tail: job.stderr_tail,
  harvest_error: job.harvest_error
})

async function scanDirRelative(dir: string, workspaceCwd: string): Promise<string[]> {
  const results: string[] = []
  try {
    await collectFiles(dir, workspaceCwd, results)
  } catch {
    // Missing or unreadable harvest directories project as empty file lists.
  }
  return results
}

async function collectFiles(
  currentDir: string,
  workspaceCwd: string,
  results: string[]
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(currentDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name)
    if (entry.isDirectory()) await collectFiles(fullPath, workspaceCwd, results)
    else if (entry.isFile()) results.push(workspaceRelativePath(workspaceCwd, fullPath))
  }
}
