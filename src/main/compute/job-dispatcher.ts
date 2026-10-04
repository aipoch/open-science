import { assertSafeInputDestination } from './harvest-classifier'
import { createHash } from 'node:crypto'

import type { ComputeJob } from '../../shared/compute'
import { hasImmutableExecutionFileEvidenceReference } from '../../shared/execution-file-evidence'
import { createLogger, errorLogFields } from '../logger'
import { decodeDataPath } from '../storage/data-path'
import {
  classifyConnectionFailure,
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import { quoteRemotePath, shellSingleQuote } from './remote-path-security'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import {
  cleanupComputeJobFileEvidence,
  publishComputeJobFileEvidence,
  settleComputeJobFileEvidence
} from '../notebook/working-file-observer'
import { SlurmDriverError } from './slurm-driver'
import { createComputeJobDriver } from './job-driver'

export { buildLauncherScript, REMOTE_PROCESS_OWNERSHIP_FUNCTION } from './direct-ssh-driver'
export {
  toBase64,
  type ComputeRemoteHandle,
  type RemoteHandle,
  type SlurmRemoteHandle
} from './remote-job-contract'

const log = createLogger('compute')

// Computes the SHA-256 hash of a command string for auditing and deduplication.
export const hashCommand = (command: string): string =>
  createHash('sha256').update(command).digest('hex')

// Calculates the remote workdir path from the scratch root and job id.
// This is called both at submit time (to return immediately) and by the dispatcher.
export const computeRemoteWorkdir = (scratchRoot: string | undefined, jobId: string): string => {
  const root = scratchRoot?.trim() || '~'
  return `${root}/.open-science/jobs/${jobId}`
}

export const computeLegacyRemoteWorkdir = (
  scratchRoot: string | undefined,
  jobId: string
): string => `${scratchRoot?.trim() || '~'}/.openscience/jobs/${jobId}`

// Quotes a remote path for safe interpolation into a remote shell command, while still allowing a
// leading `~` to be expanded to $HOME by the shell. A tilde inside double/single quotes is NOT
// expanded by bash, so the `~/` prefix is left unquoted and only the remainder is single-quoted
// (single quotes also neutralise $, backticks, spaces, etc. for injection safety). Paths without a
// leading tilde are single-quoted wholesale.
export { quoteRemotePath } from './remote-path-security'

// One entry in the stored input manifest. Created by ComputeService (validation/resolution)
// and consumed by the dispatcher (staging).
export type StagedInputEntry =
  | {
      kind: 'upload'
      localPath: string
      dstFilename: string
      label: string
      generationId?: string
      checksum?: string
      sizeBytes?: number
    }
  | { kind: 'symlink'; remotePath: string; dstFilename: string; label: string }

// Performs the remote staging for all entries: scp upload for 'upload' entries,
// remote ln -s for 'symlink' entries. All-or-nothing: throws on first failure.
// Called inside dispatchJob after the SSH target is resolved.
export const stageInputs = async (
  entries: StagedInputEntry[],
  workdir: string,
  connection: ComputeConnectionLease
): Promise<void> => {
  // Validate the complete persisted manifest before the first upload or symlink.
  for (const entry of entries) assertSafeInputDestination(entry.dstFilename)
  for (const entry of entries) {
    if (entry.kind === 'upload') {
      const remoteDest = `${workdir}/${entry.dstFilename}`
      await connection.upload(entry.localPath, remoteDest)
    } else {
      // Remote symlink: ln -s /abs/path workdir/dst_filename
      const quoted = shellSingleQuote(entry.remotePath)
      const destQ = quoteRemotePath(`${workdir}/${entry.dstFilename}`)
      const lnCmd = `ln -s ${quoted} ${destQ}`
      const result = await connection.run(lnCmd, {
        timeoutMs: 30_000,
        loginShell: false,
        maxOutputBytes: 4 * 1024
      })
      const connectionFailure = classifyConnectionFailure(result, false)
      if (connectionFailure) throw connectionFailure
      if (result.exitCode !== 0) {
        throw new Error(`ln -s failed for ${entry.label}.`)
      }
    }
  }
}

// Dependency interface for the dispatcher. Tests inject a fake SshRunner.
export type DispatcherDeps = {
  connectionBroker: ComputeConnectionBrokerAcquirer
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  // Optional broadcast hook for Phase 3d renderer IPC; no-op when omitted (Phase 3a).
  onJobUpdated?: (job: ComputeJob) => void
  // Tracks this dispatch as in-flight so the poller won't mistake a job that is still staging
  // inputs for a restart-orphaned one. Defaults to the process-wide shared tracker.
  dispatchTracker?: DispatchTracker
  storageRoot?: string
}

// Dispatches one job to its remote host asynchronously (not awaited by submit_job RPC).
// Transitions: submitted → running/terminal when remote launch state is proven, or error when a
// failure is definitive. Ambiguous launch responses remain submitted for non-destructive recovery.
export async function dispatchJob(jobId: string, deps: DispatcherDeps): Promise<void> {
  const tracker = deps.dispatchTracker ?? sharedDispatchTracker
  // Mark in-flight synchronously (before the first await) so the poller can never observe this job
  // as untracked while its dispatch is genuinely running. Cleared in the finally below.
  tracker.begin(jobId)
  try {
    try {
      await dispatchJobInner(jobId, deps)
    } catch (error) {
      // Unknown failures may occur after the remote launcher has started but before its handle is
      // durable. Leave that row submitted so deterministic restart recovery can adopt it; only a
      // transport failure already proven to be pre-launch is safe to terminalize here.
      if (error instanceof SlurmDriverError) {
        const lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
        if (error.code === 'host_unreachable') {
          await lifecycle.recordPollError(jobId, 'submitted', error.message, false)
          return
        }
        await lifecycle.dispatchError(jobId, { errorCode: error.code, stderrTail: error.message })
        return
      }
      if (!(error instanceof ComputeConnectionError)) return
      const lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
      await lifecycle.dispatchError(jobId, { errorCode: error.code, stderrTail: error.message })
    }
  } finally {
    await finalizeDispatchErrorEvidence(jobId, deps)
    tracker.end(jobId)
  }
}

const finalizeDispatchErrorEvidence = async (
  jobId: string,
  deps: DispatcherDeps
): Promise<void> => {
  if (!deps.storageRoot) return
  const job = await deps.jobRepository.get(jobId).catch(() => null)
  if (!job || job.status !== 'error') return
  if (hasImmutableExecutionFileEvidenceReference(job.file_evidence)) return
  const remoteInputPaths: string[] = []
  if (job.input_manifest) {
    try {
      const entries = JSON.parse(job.input_manifest) as Array<{
        kind?: string
        remotePath?: string
      }>
      for (const entry of entries) {
        if (entry.kind === 'symlink' && entry.remotePath) remoteInputPaths.push(entry.remotePath)
      }
    } catch {
      // New manifests are validated; malformed historical rows remain evidence-unknown.
    }
  }
  try {
    const fileEvidence = await publishComputeJobFileEvidence({
      storageRoot: deps.storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId,
      producerRunId: job.producer_run_id,
      outputs: [],
      remoteInputPaths,
      reasonCodes: ['harvest-incomplete', 'remote-output-not-harvested']
    })
    await deps.jobRepository.update(jobId, { fileEvidence })
    await settleComputeJobFileEvidence({
      storageRoot: deps.storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId,
      producerRunId: job.producer_run_id,
      fileEvidence
    }).catch((error) =>
      log.warn('Compute Job file-evidence receipt remains for startup recovery.', {
        jobId,
        ...errorLogFields(error)
      })
    )
  } catch {
    const persisted = await deps.jobRepository.get(jobId).catch(() => null)
    if (persisted && !hasImmutableExecutionFileEvidenceReference(persisted.file_evidence)) {
      await cleanupComputeJobFileEvidence({
        storageRoot: deps.storageRoot,
        projectId: job.project_id,
        sessionId: job.session_id,
        jobId,
        preservePublished: true
      }).catch(() => undefined)
    }
  }
}

async function dispatchJobInner(jobId: string, deps: DispatcherDeps): Promise<void> {
  const { connectionBroker, hostRepository, jobRepository, onJobUpdated } = deps
  const lifecycle = new ComputeJobLifecycle(jobRepository, onJobUpdated)

  const job = await jobRepository.get(jobId)
  if (!job) return // already gone (unlikely but guard anyway)

  const host = await hostRepository.get(job.provider_id)
  if (!host) {
    await lifecycle.dispatchError(jobId, { errorCode: 'dispatch_failed' })
    return
  }

  // The lease captures one Host/authentication-revision snapshot for this entire dispatch.
  let connection: ComputeConnectionLease
  try {
    connection = await connectionBroker.acquire(job.provider_id, { intent: 'job_dispatch' })
  } catch (err) {
    const failure =
      err instanceof ComputeConnectionError
        ? { code: err.code, message: err.message }
        : { code: 'host_unreachable', message: 'The Compute Host could not be reached.' }
    await lifecycle.dispatchError(jobId, {
      errorCode: failure.code,
      stderrTail: failure.message
    })
    return
  }

  const workdir = job.remote_workdir ?? computeLegacyRemoteWorkdir(host.scratchRoot, jobId)
  // Stage inputs declared in the manifest (all-or-nothing: failure → dispatch_failed).
  if (job.input_manifest) {
    let entries: StagedInputEntry[]
    try {
      entries = (JSON.parse(job.input_manifest) as StagedInputEntry[]).map((entry) =>
        entry.kind === 'upload'
          ? { ...entry, localPath: decodeDataPath(entry.localPath, deps.storageRoot)! }
          : entry
      )
    } catch {
      await lifecycle.dispatchError(jobId, {
        errorCode: 'dispatch_failed',
        stderrTail: 'Failed to parse inputManifest JSON'
      })
      return
    }

    // Mkdir workdir first so symlinks and uploads have a destination.
    const mkdirResult = await connection.run(`mkdir -p ${quoteRemotePath(workdir)}`, {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4 * 1024
    })
    const mkdirConnectionFailure = classifyConnectionFailure(mkdirResult, false)
    if (mkdirConnectionFailure) throw mkdirConnectionFailure
    if (mkdirResult.exitCode !== 0) {
      await lifecycle.dispatchError(jobId, {
        errorCode: 'dispatch_failed',
        stderrTail: 'Could not prepare the remote Compute Job directory.'
      })
      return
    }

    try {
      await stageInputs(entries, workdir, connection)
    } catch (err) {
      if (err instanceof ComputeConnectionError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      await lifecycle.dispatchError(jobId, {
        errorCode: 'dispatch_failed',
        stderrTail: `Input staging failed: ${msg}`
      })
      return
    }
  }

  const driver = createComputeJobDriver(job.execution_mode ?? 'direct_ssh')
  await driver.submit({ job, connection, workdir, lifecycle })
}
