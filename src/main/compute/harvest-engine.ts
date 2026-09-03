/**
 * harvest-engine.ts — downloads a finished job's output files from the remote workdir.
 *
 * Three phases (design.md §6):
 *  1. Remote enumeration: single SSH round-trip using `find -printf '%P\t%s\n'`.
 *  2. Classification: delegates to harvest-classifier (pure, no I/O).
 *  3. Download: scp each file to the session workspace under hpc/<jobId>/.
 *
 * On any failure the engine sets harvestError + harvestedAt (harvest_failed outcome, design §9).
 * The remote workdir is never deleted here (retained for manual recovery, design §7).
 *
 * Security: only files beneath the remote_workdir are downloaded (enumeration is scoped
 * to that directory). Paths are validated before scp via scp-runner's GLOB_CHARS /
 * SHELL_UNSAFE_CHARS checks (design §8.2 / issue 02 security requirement).
 *
 * Approval: harvest does NOT go through the download approval gate (design §12).
 * The submit_job approval covers the full submit→harvest lifecycle.
 */

import { randomUUID } from 'node:crypto'
import { access, mkdir, realpath, rename, rm, stat, statfs, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import type { ComputeJob, JobSummary } from '../../shared/compute'
import {
  hasImmutableExecutionFileEvidenceReference,
  parseOwnedExecutionFileEvidenceSummary
} from '../../shared/execution-file-evidence'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import {
  classifyConnectionFailure,
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import {
  quoteRemotePath,
  SHELL_UNSAFE_CHARS,
  validateRelativeTransferPath
} from './remote-path-security'
import {
  classifyFiles,
  HARVEST_MAX_FILE_MB,
  normalizeHarvestConfig,
  type FileEntry,
  type OutputDeclaration,
  type HarvestConfig
} from './harvest-classifier'
import { getNotebookSessionRoot } from '../notebook/repository'
import { emitJobNotification } from './job-notifier'
import {
  cleanupComputeJobFileEvidence,
  publishComputeJobFileEvidence,
  settleComputeJobFileEvidence
} from '../notebook/working-file-observer'
import { withDataRootWrite } from '../storage/migration-state'
import { toErrorMessage } from '../error-message'
import { getJobHarvestDir, workspaceRelativePath } from './workspace-path'
import { createLogger, errorLogFields } from '../logger'
import {
  normalizeRemoteMtimeToken,
  parseRemoteFileStat,
  remoteFileStatCommand,
  sameRemoteFileSnapshot,
  type RemoteFileSnapshot
} from './remote-file-snapshot'

const MIB_BYTES = 1024 * 1024
export const HARVEST_FREE_DISK_RESERVE_BYTES = 2 * 1024 * MIB_BYTES
const log = createLogger('compute:harvest')

const getFreeDiskBytes = async (path: string): Promise<number> => {
  const stats = await statfs(path)
  return Number(stats.bavail) * Number(stats.bsize)
}

// Serialize only reservation bookkeeping so concurrent harvests cannot spend the same free space.
let harvestBudgetTail: Promise<void> = Promise.resolve()
const withHarvestBudgetLock = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
  const previous = harvestBudgetTail
  let release!: () => void
  harvestBudgetTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

const reservedHarvestBytesByRoot = new Map<string, number>()

const canonicalStorageRoot = async (storageRoot: string): Promise<string> =>
  realpath(storageRoot).catch(() => resolve(storageRoot))

const reserveHarvestBudget = async (
  storageRoot: string,
  freeDiskBytes: number,
  requestedBytes: number
): Promise<{ bytes: number; release: () => Promise<void> }> => {
  const rootKey = await canonicalStorageRoot(storageRoot)
  return withHarvestBudgetLock(async () => {
    const reserved = reservedHarvestBytesByRoot.get(rootKey) ?? 0
    const available = Math.max(
      0,
      Math.floor(freeDiskBytes - HARVEST_FREE_DISK_RESERVE_BYTES - reserved)
    )
    const bytes = Math.max(0, Math.min(Math.floor(requestedBytes), available))
    reservedHarvestBytesByRoot.set(rootKey, reserved + bytes)
    let released = false
    return {
      bytes,
      release: async () => {
        if (released) return
        released = true
        await withHarvestBudgetLock(async () => {
          const current = reservedHarvestBytesByRoot.get(rootKey) ?? 0
          const next = Math.max(0, current - bytes)
          if (next === 0) reservedHarvestBytesByRoot.delete(rootKey)
          else reservedHarvestBytesByRoot.set(rootKey, next)
        })
      }
    }
  })
}

const pathExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )
// ---------------------------------------------------------------------------
// Remote enumeration
// ---------------------------------------------------------------------------

// Timeout for the single SSH enumerate round-trip (generous for large workdirs).
const ENUMERATE_TIMEOUT_MS = 60_000

type HarvestFileEntry = FileEntry & { snapshot: RemoteFileSnapshot }

/**
 * Lists all files in the remote workdir using a single SSH round-trip.
 * Command: find <workdir> -type f -printf '%P\t%s\t%i\t%T@\n'
 *
 * Returns FileEntry[] (relative paths + byte sizes). Throws on SSH failure.
 */
export const enumerateRemoteFiles = async (
  connection: ComputeConnectionLease,
  remoteWorkdir: string
): Promise<HarvestFileEntry[]> => {
  // Single-quote the workdir path for safe embedding in the SSH command.
  const quotedWorkdir = quoteRemotePath(remoteWorkdir)
  const cmd = `find ${quotedWorkdir} -type f -printf '%P\\t%s\\t%i\\t%T@\\n' 2>/dev/null || true`

  const result = await connection.run(cmd, {
    timeoutMs: ENUMERATE_TIMEOUT_MS,
    loginShell: false,
    maxOutputBytes: 4 * 1024 * 1024 // 4 MB cap — a listing of millions of files
  })
  const connectionFailure = classifyConnectionFailure(result, false)
  if (connectionFailure) throw connectionFailure

  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new Error('Remote file enumeration failed.')
  }

  // Check if output was truncated (exceeds 4MB cap). A huge directory listing would lose trailing
  // files silently — they'd neither be downloaded nor appear in left_on_remote.
  if (result.truncated) {
    throw new Error(
      'Remote file listing exceeded 4MB size cap and was truncated. ' +
        'The workdir may contain millions of files. Consider cleaning up the remote directory.'
    )
  }

  if (!result.stdout.trim()) return []

  const entries: HarvestFileEntry[] = []
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    const mtimeTab = trimmed.lastIndexOf('\t')
    const inodeTab = trimmed.lastIndexOf('\t', mtimeTab - 1)
    const sizeTab = trimmed.lastIndexOf('\t', inodeTab - 1)
    if (sizeTab === -1 || inodeTab === -1 || mtimeTab === -1) continue
    const path = trimmed.slice(0, sizeTab)
    const sizeStr = trimmed.slice(sizeTab + 1, inodeTab)
    const inode = trimmed.slice(inodeTab + 1, mtimeTab)
    const mtimeToken = normalizeRemoteMtimeToken(trimmed.slice(mtimeTab + 1))
    const size_bytes = Number.parseInt(sizeStr, 10)
    if (!path || !inode || !mtimeToken || !Number.isSafeInteger(size_bytes) || size_bytes < 0)
      continue
    entries.push({
      path,
      size_bytes,
      snapshot: { sizeBytes: size_bytes, inode, mtimeToken }
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

// Validates a relative file path from the remote listing before using it in an scp arg.
// Returns an error string on rejection, undefined on success.
const validateRelativePath = (path: string): string | undefined => {
  return validateRelativeTransferPath(path)
}

type HarvestDownloadLimitError = Error & { limitExceeded?: boolean }

/**
 * Downloads a single file from the remote workdir to a local destination.
 * Production uses a bounded SSH stream so a file that grows after enumeration cannot exceed
 * the application-owned byte budget. Test runners without that capability retain the SCP seam.
 */
const downloadFile = async (
  connection: ComputeConnectionLease,
  remoteWorkdir: string,
  relativePath: string,
  localDestPath: string,
  maxBytes: number,
  expectedSnapshot: RemoteFileSnapshot
): Promise<number> => {
  const pathError = validateRelativePath(relativePath)
  if (pathError) {
    throw new Error('Rejected remote path "' + relativePath + '": ' + pathError)
  }

  const absRemotePath = remoteWorkdir + '/' + relativePath

  if (SHELL_UNSAFE_CHARS.test(absRemotePath)) {
    throw new Error(
      'Rejected absolute remote path "' + absRemotePath + '": shell-unsafe characters'
    )
  }

  await mkdir(dirname(localDestPath), { recursive: true })

  const result = await connection.download(absRemotePath, localDestPath, maxBytes)
  const connectionFailure = classifyConnectionFailure(result, false)
  if (connectionFailure) throw connectionFailure
  if (result.exceeded) {
    const error = new Error(
      'download exceeded the allowed byte budget for ' + relativePath
    ) as HarvestDownloadLimitError
    error.limitExceeded = true
    throw error
  }
  if (result.timedOut) throw new Error('download timed out for ' + relativePath)
  if (result.exitCode !== 0) {
    throw new Error('remote copy failed for ' + relativePath)
  }
  const localSize = Number((await stat(localDestPath)).size)
  const postTransferResult = await connection.run(remoteFileStatCommand(absRemotePath), {
    timeoutMs: 10_000,
    loginShell: false,
    maxOutputBytes: 512
  })
  const postTransferFailure = classifyConnectionFailure(postTransferResult, false)
  if (postTransferFailure) throw postTransferFailure
  const postTransfer = parseRemoteFileStat(postTransferResult.stdout)
  if (
    postTransferResult.exitCode !== 0 ||
    postTransfer.fileType !== 'f' ||
    !postTransfer.snapshot ||
    result.bytesWritten !== expectedSnapshot.sizeBytes ||
    localSize !== expectedSnapshot.sizeBytes ||
    !sameRemoteFileSnapshot(postTransfer.snapshot, expectedSnapshot)
  ) {
    throw new Error('File changed during transfer: ' + relativePath)
  }
  return result.bytesWritten
}

// ---------------------------------------------------------------------------
// HarvestDeps: the injectable seam for tests
// ---------------------------------------------------------------------------

export type HarvestDeps = {
  connectionBroker: ComputeConnectionBrokerAcquirer
  hostRepository: Pick<ComputeHostRepository, 'get'>
  jobRepository: Pick<ComputeJobRepository, 'update' | 'claimNotification'>
  storageRoot: string
  signal?: AbortSignal
  /** Override free-space discovery for deterministic tests. */
  getFreeDiskBytesFn?: (path: string) => Promise<number>
  /** Injectable filesystem publication seam for crash/interruption tests. */
  renameFn?: typeof rename
  /**
   * Broadcast hook for the compute_done notification (issue 06).
   * Called after harvestedAt is written. Defaults to the production broadcastJobUpdated.
   * Injected as undefined in tests that don't need notification assertions.
   */
  broadcast?: (summary: JobSummary) => void
  /** Publishes non-final harvest state, such as a retryable connection failure. */
  publishJobUpdated?: (job: ComputeJob) => void
}

// ---------------------------------------------------------------------------
// Left-on-remote URI builder
// ---------------------------------------------------------------------------

/**
 * Builds the ssh:// URI for a file left on the remote side.
 * Format: ssh://<alias>/<abs_remote_path> (design §5).
 */
const buildLeftOnRemoteUri = (
  sshAlias: string,
  remoteWorkdir: string,
  relativePath: string
): string => {
  const absPath = `${remoteWorkdir}/${relativePath}`
  // Ensure exactly one slash between alias and path.
  const cleanPath = absPath.startsWith('/') ? absPath : `/${absPath}`
  return `ssh://${sshAlias}${cleanPath}`
}

// ---------------------------------------------------------------------------
// Main harvest function
// ---------------------------------------------------------------------------

/**
 * Executes one harvest pass for a finished job:
 *   1. Look up the host record.
 *   2. Resolve SSH target.
 *   3. Enumerate remote files (single round-trip).
 *   4. Classify files using harvest-classifier.
 *   5. Download featured + hidden files; put stdout/stderr at harvest root.
 *   6. Write harvestedAt / harvestError / leftOnRemote to DB.
 *
 * On any error: sets harvestError + harvestedAt (harvest_failed). Remote workdir
 * is NEVER deleted (preserved for manual recovery, design §9).
 *
 * This function is idempotent: calling it twice on the same job overwrites the
 * previous harvest (re-downloads files, re-writes DB fields).
 */
export const harvestJob = async (job: ComputeJob, deps: HarvestDeps): Promise<void> => {
  deps.signal?.throwIfAborted()
  return withDataRootWrite(async () => {
    deps.signal?.throwIfAborted()
    const harvestDir = getJobHarvestDir(
      deps.storageRoot,
      job.project_id,
      job.session_id,
      job.job_id
    )
    const attemptDir = `${harvestDir}.harvest-attempt`
    const backupDir = `${harvestDir}.harvest-backup`
    const renamePath = deps.renameFn ?? rename

    // Repair the only interrupted publication states before touching a new attempt. A whole harvest
    // is published by directory rename, so readers see one complete generation or none, never a
    // per-file mixture. Only exact app-owned sibling paths are cleaned.
    if (await pathExists(backupDir)) {
      if (await pathExists(harvestDir)) await rm(backupDir, { recursive: true, force: true })
      else await renamePath(backupDir, harvestDir)
    }
    await rm(attemptDir, { recursive: true, force: true })

    try {
      await harvestJobUnchecked(job, deps, { harvestDir, attemptDir, backupDir, renamePath })
    } catch (error) {
      if (error instanceof ComputeConnectionError) {
        // Keep harvestedAt unset so restart/tick recovery retries. Persist only a safe error class;
        // never persist connection output or credentials.
        const pendingJob = await deps.jobRepository.update(job.job_id, {
          harvestError: `harvest pending: ${error.code}`
        })
        deps.publishJobUpdated?.(pendingJob)
      }
      throw error
    } finally {
      await rm(attemptDir, { recursive: true, force: true })
    }
  })
}

const harvestJobUnchecked = async (
  job: ComputeJob,
  deps: HarvestDeps,
  publication: {
    harvestDir: string
    attemptDir: string
    backupDir: string
    renamePath: typeof rename
  }
): Promise<void> => {
  const { connectionBroker, hostRepository, jobRepository, storageRoot } = deps

  const { harvestDir, attemptDir, backupDir, renamePath } = publication
  const workspaceCwd = getNotebookSessionRoot(storageRoot, job.project_id, job.session_id)
  const featuredDir = join(attemptDir, 'featured')
  const hiddenDir = join(attemptDir, 'hidden')
  const downloadedOutputs: Array<{
    attemptPath: string
    publishedPath: string
    relativePath: string
  }> = []
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
      // The repository validates new manifests; malformed historical rows remain evidence-unknown.
    }
  }

  // Ensure harvest directory structure exists (idempotent).
  await mkdir(featuredDir, { recursive: true })
  await mkdir(hiddenDir, { recursive: true })
  deps.signal?.throwIfAborted()

  // Finalize the harvest result first. Notification ownership is claimed separately through the
  // notifier's database CAS, and restart recovery can claim any completed-but-unnotified row.
  const finalize = async (
    harvestError: string | null,
    leftOnRemoteJson: string
  ): Promise<ComputeJob> => {
    let leftOnRemoteCount = 0
    try {
      const leftOnRemote = JSON.parse(leftOnRemoteJson) as unknown[]
      leftOnRemoteCount = Array.isArray(leftOnRemote) ? leftOnRemote.length : 0
    } catch {
      leftOnRemoteCount = 0
    }
    const reasonCodes = [
      ...(harvestError ? (['harvest-incomplete'] as const) : []),
      ...(leftOnRemoteCount > 0 ? (['remote-output-not-harvested'] as const) : [])
    ]
    let fileEvidence = parseOwnedExecutionFileEvidenceSummary(job.file_evidence, {
      activityId: job.job_id,
      activityKind: 'compute-job',
      parentActivityId: job.producer_run_id,
      storageKey: `execution-file-evidence/${job.project_id}/${job.session_id}/activity-${job.job_id}/evidence.json`
    })
    let publishedEvidence = false
    let evidencePublicationFailed = false
    if (!hasImmutableExecutionFileEvidenceReference(fileEvidence)) {
      try {
        fileEvidence = await publishComputeJobFileEvidence({
          storageRoot,
          projectId: job.project_id,
          sessionId: job.session_id,
          jobId: job.job_id,
          producerRunId: job.producer_run_id,
          outputs: downloadedOutputs.map((output) => ({
            localPath: harvestError ? output.attemptPath : output.publishedPath,
            relativePath: output.relativePath
          })),
          remoteInputPaths,
          reasonCodes,
          signal: deps.signal
        })
        publishedEvidence = true
      } catch {
        evidencePublicationFailed = true
        fileEvidence = {
          schemaVersion: 1,
          activityId: job.job_id,
          activityKind: 'compute-job',
          ...(job.producer_run_id ? { parentActivityId: job.producer_run_id } : {}),
          state: 'unavailable',
          scientificOutputCount: 0,
          initialViewState: 'unavailable',
          managedRootsFinalState: 'unavailable',
          scientificOutputAnalysis: 'unavailable',
          fileReads: 'unavailable',
          externalPaths: 'unavailable',
          writerAttribution: 'unavailable',
          reasonCodes: [
            ...reasonCodes,
            ...(job.producer_run_id ? [] : (['compute-activity-lineage-missing'] as const)),
            'evidence-persistence-failed'
          ]
        }
      }
    }
    const updated = await jobRepository.update(job.job_id, {
      harvestedAt: new Date(),
      harvestError,
      leftOnRemote: leftOnRemoteJson,
      fileEvidence
    })
    if (
      evidencePublicationFailed &&
      !hasImmutableExecutionFileEvidenceReference(updated.file_evidence)
    ) {
      await cleanupComputeJobFileEvidence({
        storageRoot,
        projectId: job.project_id,
        sessionId: job.session_id,
        jobId: job.job_id,
        preservePublished: true
      }).catch((error) =>
        log.warn('Compute Job file-evidence cleanup deferred to startup recovery.', {
          jobId: job.job_id,
          ...errorLogFields(error)
        })
      )
    }
    if (publishedEvidence) {
      await settleComputeJobFileEvidence({
        storageRoot,
        projectId: job.project_id,
        sessionId: job.session_id,
        jobId: job.job_id,
        producerRunId: job.producer_run_id,
        fileEvidence
      }).catch((error) =>
        log.warn('Compute Job file-evidence receipt remains for startup recovery.', {
          jobId: job.job_id,
          ...errorLogFields(error)
        })
      )
    }
    return updated
  }

  // Helper: finalize + broadcast + return (DRY for all early-exit paths).
  const finalizeAndReturn = async (
    harvestError: string | null,
    leftOnRemoteJson: string
  ): Promise<void> => {
    const updatedJob = await finalize(harvestError, leftOnRemoteJson)
    if (deps.broadcast) await notify(updatedJob)
  }

  const notify = async (updatedJob: ComputeJob): Promise<void> => {
    try {
      await emitJobNotification(updatedJob, {
        jobRepository,
        hostRepository,
        storageRoot,
        broadcast: deps.broadcast!
      })
    } catch {
      // Notification failure is non-fatal: harvest result is already persisted and restart recovery
      // can retry rows whose CAS claim was never committed.
    }
  }

  // ── 1. Look up host ─────────────────────────────────────────────────────────
  let host: Awaited<ReturnType<typeof hostRepository.get>>
  try {
    host = await hostRepository.get(job.provider_id)
  } catch (err) {
    if (deps.signal?.aborted) throw err
    const msg = toErrorMessage(err)
    await finalizeAndReturn(`host lookup failed: ${msg}`, '[]')
    return
  }

  deps.signal?.throwIfAborted()

  if (!host) {
    await finalizeAndReturn(`host not found: ${job.provider_id}`, '[]')
    return
  }

  // ── 2. Acquire one Host/revision-scoped connection lease ────────────────────
  const connection: ComputeConnectionLease = await connectionBroker.acquire(job.provider_id, {
    intent: 'job_harvest',
    signal: deps.signal
  })

  const remoteWorkdir = job.remote_workdir ?? `~/.openscience/jobs/${job.job_id}`

  // ── 3. Enumerate remote files ───────────────────────────────────────────────
  let remoteFiles: HarvestFileEntry[]
  try {
    remoteFiles = await enumerateRemoteFiles(connection, remoteWorkdir)
  } catch (err) {
    if (deps.signal?.aborted) throw err
    if (err instanceof ComputeConnectionError) throw err
    await finalizeAndReturn('Remote file enumeration failed.', '[]')
    return
  }

  deps.signal?.throwIfAborted()

  // ── 4. Classify files ───────────────────────────────────────────────────────
  let outputs: OutputDeclaration[] = []
  if (job.output_manifest) {
    try {
      outputs = JSON.parse(job.output_manifest) as OutputDeclaration[]
    } catch {
      // Malformed manifest — treat as no outputs (default hidden for everything).
    }
  }

  let harvestConfig: HarvestConfig = {}
  if (job.harvest_config) {
    try {
      harvestConfig = JSON.parse(job.harvest_config) as HarvestConfig
    } catch {
      // Malformed config — use defaults.
    }
  }

  // Build staged inputs set (bare filenames from inputManifest).
  const stagedInputs = new Set<string>()
  if (job.input_manifest) {
    try {
      const manifest = JSON.parse(job.input_manifest) as Array<{
        dstFilename?: string
        dest?: string
      }>
      for (const entry of manifest) {
        const destination = entry.dstFilename ?? entry.dest
        if (destination) stagedInputs.add(destination)
      }
    } catch {
      // Ignore parse errors.
    }
  }

  const normalizedHarvestConfig = normalizeHarvestConfig(harvestConfig)
  const plannedClassification = classifyFiles(
    remoteFiles,
    outputs,
    normalizedHarvestConfig,
    stagedInputs
  )
  const remoteFileByPath = new Map(remoteFiles.map((entry) => [entry.path, entry]))
  const plannedPaths = new Set([
    ...plannedClassification.featured,
    ...plannedClassification.hidden,
    ...plannedClassification.logs
  ])
  const plannedTransferBytes = [...plannedPaths].reduce(
    (total, path) => total + Math.max(0, remoteFileByPath.get(path)?.size_bytes ?? 0),
    0
  )
  let freeDiskBytes: number
  try {
    freeDiskBytes = await (deps.getFreeDiskBytesFn ?? getFreeDiskBytes)(attemptDir)
    if (!Number.isFinite(freeDiskBytes) || freeDiskBytes < 0) {
      throw new Error('free-space query returned an invalid value')
    }
  } catch (err) {
    if (deps.signal?.aborted) throw err
    const msg = toErrorMessage(err)
    await finalizeAndReturn(`free-space check failed: ${msg}`, '[]')
    return
  }
  const requestedBudgetBytes = Math.min(
    Math.floor((normalizedHarvestConfig.max_total_mb ?? 0) * MIB_BYTES),
    plannedTransferBytes
  )
  const reservation = await reserveHarvestBudget(storageRoot, freeDiskBytes, requestedBudgetBytes)
  const effectiveHarvestConfig: HarvestConfig = {
    ...normalizedHarvestConfig,
    max_total_mb: reservation.bytes / MIB_BYTES
  }
  const classification = classifyFiles(remoteFiles, outputs, effectiveHarvestConfig, stagedInputs)
  let remainingBudgetBytes = reservation.bytes

  // ── 5. Download files ───────────────────────────────────────────────────────
  const errors: string[] = []

  // Helper: download one file, recording errors without throwing.
  const recordLimit = (
    relativePath: string,
    sizeBytes: number,
    reason: 'exceeds_max_file_mb' | 'exceeds_max_total_mb'
  ): void => {
    if (classification.left_on_remote.some((entry) => entry.path === relativePath)) return
    classification.left_on_remote.push({
      path: relativePath,
      size_mb: sizeBytes / MIB_BYTES,
      reason
    })
  }

  const safeDownload = async (
    relativePath: string,
    localPath: string,
    recordAsEvidence = true
  ): Promise<boolean> => {
    deps.signal?.throwIfAborted()
    const remoteFile = remoteFileByPath.get(relativePath)
    if (!remoteFile) {
      errors.push('Remote file disappeared before transfer: ' + relativePath)
      return false
    }
    const expectedBytes = remoteFile.size_bytes
    let currentFreeBytes: number
    try {
      currentFreeBytes = await (deps.getFreeDiskBytesFn ?? getFreeDiskBytes)(attemptDir)
      if (!Number.isFinite(currentFreeBytes) || currentFreeBytes < 0) {
        throw new Error('free-space query returned an invalid value')
      }
    } catch (error) {
      errors.push('free-space check failed: ' + String(error))
      return false
    }
    const diskAvailableBytes = Math.max(
      0,
      Math.floor(currentFreeBytes - HARVEST_FREE_DISK_RESERVE_BYTES)
    )
    const maxBytes = Math.max(
      0,
      Math.min(HARVEST_MAX_FILE_MB * MIB_BYTES, remainingBudgetBytes, diskAvailableBytes)
    )
    if (expectedBytes > maxBytes) {
      recordLimit(relativePath, expectedBytes, 'exceeds_max_total_mb')
      return false
    }

    const temporaryPath = `${localPath}.${randomUUID()}.partial`
    try {
      const bytesWritten = await downloadFile(
        connection,
        remoteWorkdir,
        relativePath,
        temporaryPath,
        maxBytes,
        remoteFile.snapshot
      )
      deps.signal?.throwIfAborted()
      await rename(temporaryPath, localPath)
      remainingBudgetBytes = Math.max(0, remainingBudgetBytes - bytesWritten)
      if (recordAsEvidence) {
        const publishedPath = join(harvestDir, relative(attemptDir, localPath))
        downloadedOutputs.push({
          attemptPath: localPath,
          publishedPath,
          relativePath: workspaceRelativePath(workspaceCwd, publishedPath)
        })
      }
      return true
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined)
      if (deps.signal?.aborted) throw error
      if (error instanceof ComputeConnectionError) throw error
      const candidate = error as HarvestDownloadLimitError
      if (candidate.limitExceeded) {
        const reason =
          maxBytes >= HARVEST_MAX_FILE_MB * MIB_BYTES
            ? 'exceeds_max_file_mb'
            : 'exceeds_max_total_mb'
        recordLimit(relativePath, Math.max(expectedBytes, maxBytes + 1), reason)
      }
      const message = toErrorMessage(error)
      errors.push(message)
      return false
    }
  }

  try {
    // Download featured files.
    for (const relativePath of classification.featured) {
      deps.signal?.throwIfAborted()
      const localPath = join(featuredDir, relativePath)
      await mkdir(dirname(localPath), { recursive: true })
      await safeDownload(relativePath, localPath)
    }

    // Download hidden files.
    for (const relativePath of classification.hidden) {
      deps.signal?.throwIfAborted()
      const localPath = join(hiddenDir, relativePath)
      await mkdir(dirname(localPath), { recursive: true })
      await safeDownload(relativePath, localPath)
    }

    // ── 6. Build left_on_remote JSON and finalize ────────────────────────────────
    // Download full logs last; bounded tails remain available when the budget excludes them.
    for (const relativePath of classification.logs) {
      deps.signal?.throwIfAborted()
      await safeDownload(relativePath, join(attemptDir, relativePath), false)
    }
  } finally {
    await reservation.release()
  }

  const leftOnRemote = classification.left_on_remote.map((entry) => ({
    uri: buildLeftOnRemoteUri(host.sshAlias, remoteWorkdir, entry.path),
    size_mb: entry.size_mb,
    reason: entry.reason
  }))

  const harvestError =
    errors.length > 0
      ? `harvest_failed: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ''}`
      : null

  deps.signal?.throwIfAborted()
  if (!harvestError) {
    let backedUp = false
    try {
      if (await pathExists(harvestDir)) {
        await rm(backupDir, { recursive: true, force: true })
        await renamePath(harvestDir, backupDir)
        backedUp = true
      }
      await renamePath(attemptDir, harvestDir)
      if (backedUp) await rm(backupDir, { recursive: true, force: true })
    } catch (error) {
      if (backedUp && !(await pathExists(harvestDir)) && (await pathExists(backupDir))) {
        await renamePath(backupDir, harvestDir)
      }
      throw error
    }
  }

  deps.signal?.throwIfAborted()
  const updatedJob = await finalize(harvestError, JSON.stringify(leftOnRemote))
  if (deps.broadcast) await notify(updatedJob)
}

export { getJobHarvestDir }
