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

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ComputeJob, JobSummary } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { ComputeJobRepository } from './job-repository'
import type { SshRunner, ResolvedSshTarget } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import { buildScpArgs, resolveScpBinary, GLOB_CHARS, SHELL_UNSAFE_CHARS } from './scp-runner'
import { shellSingleQuote } from './scp-runner'
import {
  classifyFiles,
  type FileEntry,
  type OutputDeclaration,
  type HarvestConfig
} from './harvest-classifier'
import { getNotebookSessionRoot } from '../notebook/repository'
import { emitJobNotification } from './job-notifier'

// ---------------------------------------------------------------------------
// Public path helper
// ---------------------------------------------------------------------------

/**
 * Returns the local harvest directory for a job:
 *   <storageRoot>/notebooks/<project>/<sessionId>/hpc/<jobId>/
 *
 * This is inside the session workspace (alongside ./handoff, ./data) so the
 * agent's data kernel can directly open('hpc/<jobId>/out.result') (design §4).
 * Delegates path-segment validation to getNotebookSessionRoot which rejects
 * traversal attempts.
 */
export const getJobHarvestDir = (
  storageRoot: string,
  project: string,
  sessionId: string,
  jobId: string
): string => {
  // getNotebookSessionRoot validates project and sessionId (throws on traversal).
  const workspaceCwd = getNotebookSessionRoot(storageRoot, project, sessionId)
  return join(workspaceCwd, 'hpc', jobId)
}

// ---------------------------------------------------------------------------
// Remote enumeration
// ---------------------------------------------------------------------------

// Timeout for the single SSH enumerate round-trip (generous for large workdirs).
const ENUMERATE_TIMEOUT_MS = 60_000

/**
 * Lists all files in the remote workdir using a single SSH round-trip.
 * Command: find <workdir> -type f -printf '%P\t%s\n'
 *
 * Returns FileEntry[] (relative paths + byte sizes). Throws on SSH failure.
 */
export const enumerateRemoteFiles = async (
  sshRunner: SshRunner,
  target: ResolvedSshTarget,
  remoteWorkdir: string
): Promise<FileEntry[]> => {
  // Single-quote the workdir path for safe embedding in the SSH command.
  const quotedWorkdir = shellSingleQuote(remoteWorkdir)
  const cmd = `find ${quotedWorkdir} -type f -printf '%P\\t%s\\n' 2>/dev/null || true`

  const result = await sshRunner.run(target, cmd, {
    timeoutMs: ENUMERATE_TIMEOUT_MS,
    loginShell: false,
    maxOutputBytes: 4 * 1024 * 1024 // 4 MB cap — a listing of millions of files
  })

  if (result.timedOut) {
    throw new Error('SSH enumerate timed out')
  }

  if (result.exitCode !== 0 && result.exitCode !== null) {
    throw new Error(
      `SSH enumerate failed (exit ${result.exitCode}): ${result.stderr.trim() || '(no stderr)'}`
    )
  }

  if (!result.stdout.trim()) return []

  const entries: FileEntry[] = []
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    const tab = trimmed.lastIndexOf('\t')
    if (tab === -1) continue
    const path = trimmed.slice(0, tab)
    const sizeStr = trimmed.slice(tab + 1)
    const size_bytes = Number.parseInt(sizeStr, 10)
    if (!path || Number.isNaN(size_bytes)) continue
    entries.push({ path, size_bytes })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

// Validates a relative file path from the remote listing before using it in an scp arg.
// Returns an error string on rejection, undefined on success.
const validateRelativePath = (path: string): string | undefined => {
  if (!path) return 'empty path'
  if (path.startsWith('/')) return 'absolute path not allowed'
  if (path.includes('..')) return 'path traversal not allowed'
  if (GLOB_CHARS.test(path)) return 'glob characters not allowed'
  if (SHELL_UNSAFE_CHARS.test(path)) return 'shell-unsafe characters in path'
  return undefined
}

/**
 * Downloads a single file from the remote workdir to a local destination.
 * Creates parent directories as needed.
 * Throws on validation error or scp failure.
 */
const downloadFile = async (
  scpRunner: ScpRunner,
  target: ResolvedSshTarget,
  remoteWorkdir: string,
  relativePath: string,
  localDestPath: string
): Promise<void> => {
  const pathError = validateRelativePath(relativePath)
  if (pathError) {
    throw new Error(`Rejected remote path "${relativePath}": ${pathError}`)
  }

  const absRemotePath = `${remoteWorkdir}/${relativePath}`

  // Ensure parent directory exists.
  await mkdir(dirname(localDestPath), { recursive: true })

  const scpBinary = resolveScpBinary()
  const args = buildScpArgs(target, absRemotePath, localDestPath)
  const result = await scpRunner.copy(scpBinary, args)

  if (result.timedOut) {
    throw new Error(`scp timed out for ${relativePath}`)
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `scp exited ${result.exitCode}`
    throw new Error(`scp failed for ${relativePath}: ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// HarvestDeps: the injectable seam for tests
// ---------------------------------------------------------------------------

export type HarvestDeps = {
  sshRunner: SshRunner
  scpRunner: ScpRunner
  hostRepository: Pick<ComputeHostRepository, 'get'>
  jobRepository: Pick<ComputeJobRepository, 'update'>
  storageRoot: string
  /** Override resolveSshTarget for tests (defaults to real implementation). */
  resolveSshTargetFn?: typeof resolveSshTarget
  /**
   * Broadcast hook for the compute_done notification (issue 06).
   * Called after harvestedAt is written. Defaults to the production broadcastJobUpdated.
   * Injected as undefined in tests that don't need notification assertions.
   */
  broadcast?: (summary: JobSummary) => void
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
  const { sshRunner, scpRunner, hostRepository, jobRepository, storageRoot } = deps
  const resolveFn = deps.resolveSshTargetFn ?? resolveSshTarget

  const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
  const featuredDir = join(harvestDir, 'featured')
  const hiddenDir = join(harvestDir, 'hidden')

  // Ensure harvest directory structure exists (idempotent).
  await mkdir(featuredDir, { recursive: true })
  await mkdir(hiddenDir, { recursive: true })

  // finalize writes harvestedAt + harvestError + leftOnRemote, then emits the compute_done
  // notification (design §8: harvestedAt arrival = final resting state for harvested outcomes).
  const finalize = async (harvestError: string | null, leftOnRemoteJson: string): Promise<void> => {
    const updatedJob = await jobRepository.update(job.job_id, {
      harvestedAt: new Date(),
      harvestError,
      leftOnRemote: leftOnRemoteJson
    })
    // Emit compute_done notification (issue 06). Fire-and-forget inside finalize;
    // notification errors must not fail the harvest write.
    if (deps.broadcast) {
      await emitJobNotification(updatedJob, {
        jobRepository,
        storageRoot,
        broadcast: deps.broadcast
      }).catch(() => {
        // Notification failure is non-fatal: the harvest result is already persisted.
      })
    }
  }

  // ── 1. Look up host ─────────────────────────────────────────────────────────
  let host: Awaited<ReturnType<typeof hostRepository.get>>
  try {
    host = await hostRepository.get(job.provider_id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await finalize(`host lookup failed: ${msg}`, '[]')
    return
  }

  if (!host) {
    await finalize(`host not found: ${job.provider_id}`, '[]')
    return
  }

  // ── 2. Resolve SSH target ───────────────────────────────────────────────────
  let target: ResolvedSshTarget
  try {
    target = await resolveFn(host.sshAlias, host.sshOverrides)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await finalize(`ssh resolve failed: ${msg}`, '[]')
    return
  }

  const remoteWorkdir = job.remote_workdir ?? `~/.openscience/jobs/${job.job_id}`

  // ── 3. Enumerate remote files ───────────────────────────────────────────────
  let remoteFiles: FileEntry[]
  try {
    remoteFiles = await enumerateRemoteFiles(sshRunner, target, remoteWorkdir)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await finalize(`enumerate failed: ${msg}`, '[]')
    return
  }

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
      const manifest = JSON.parse(job.input_manifest) as Array<{ dest?: string }>
      for (const entry of manifest) {
        if (entry.dest) stagedInputs.add(entry.dest)
      }
    } catch {
      // Ignore parse errors.
    }
  }

  const classification = classifyFiles(remoteFiles, outputs, harvestConfig, stagedInputs)

  // ── 5. Download files ───────────────────────────────────────────────────────
  const errors: string[] = []

  // Helper: download one file, recording errors without throwing.
  const safeDownload = async (relativePath: string, localPath: string): Promise<boolean> => {
    try {
      await downloadFile(scpRunner, target, remoteWorkdir, relativePath, localPath)
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(msg)
      return false
    }
  }

  // Download stdout and stderr to harvest root (if present in listing).
  const stdoutInListing = remoteFiles.some((f) => f.path === 'stdout')
  const stderrInListing = remoteFiles.some((f) => f.path === 'stderr')
  if (stdoutInListing) {
    await safeDownload('stdout', join(harvestDir, 'stdout'))
  }
  if (stderrInListing) {
    await safeDownload('stderr', join(harvestDir, 'stderr'))
  }

  // Download featured files.
  for (const relativePath of classification.featured) {
    const localPath = join(featuredDir, relativePath)
    await mkdir(dirname(localPath), { recursive: true })
    await safeDownload(relativePath, localPath)
  }

  // Download hidden files.
  for (const relativePath of classification.hidden) {
    const localPath = join(hiddenDir, relativePath)
    await mkdir(dirname(localPath), { recursive: true })
    await safeDownload(relativePath, localPath)
  }

  // ── 6. Build left_on_remote JSON and finalize ────────────────────────────────
  const leftOnRemote = classification.left_on_remote.map((entry) => ({
    uri: buildLeftOnRemoteUri(host.sshAlias, remoteWorkdir, entry.path),
    size_mb: entry.size_mb,
    reason: entry.reason
  }))

  const harvestError =
    errors.length > 0
      ? `harvest_failed: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ''}`
      : null

  await finalize(harvestError, JSON.stringify(leftOnRemote))
}
