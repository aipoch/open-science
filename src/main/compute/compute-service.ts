import { readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import type {
  ComputeCallError,
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
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import { GLOB_CHARS, SHELL_UNSAFE_CHARS, SystemScpRunner } from './scp-runner'
import type { ComputeJobRepository } from './job-repository'
import { computeRemoteWorkdir, dispatchJob, hashCommand } from './job-dispatcher'
import type { StagedInputEntry } from './job-dispatcher'
import { getJobHarvestDir } from './harvest-engine'
import { getNotebookSessionRoot } from '../notebook/repository'
import type { ConcurrencyManager, SessionStatus } from './concurrency-manager'
import { workspaceRelativePath } from './workspace-path'
import { ComputeHostProfileOwner } from './compute-host-profile-owner'
import { ComputeRemoteOperationOwner } from './compute-remote-operation-owner'

export { parseProbeOutput } from './compute-host-profile-owner'
export type { ProbeScriptOutput } from './compute-host-profile-owner'

const COMMAND_PREVIEW_MAX_LEN = 120

// Raw input spec as submitted by the agent (before resolution to local paths).
// Three kinds:
//   workspace: {src:"relative/path.csv", dst_filename:"name.csv"}        — relative to session cwd
//   artifact:  {src:"/storage/artifacts/.../name.csv", dst_filename:...} — absolute artifact-store path
//   remote:    {remote_path:"/abs/path", dst_filename?:"name.csv"}       — symlinked, not uploaded
export type RawInputSpec =
  | { src: string; dst_filename: string } // workspace (relative) or artifact (absolute) — see resolveInputs
  | { remote_path: string; dst_filename?: string }

// Validates a dst_filename: must be a bare filename with no path separators.
const assertBareName = (name: string, label: string): void => {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(
      `dst_filename must be a bare filename with no path separators (got "${name}" for ${label})`
    )
  }
}

// Checks a workspace path doesn't escape the workspace root.
// Returns the resolved absolute path on success, throws on escape.
const resolveWorkspacePath = (workspaceCwd: string, srcPath: string): string => {
  const resolved = resolve(workspaceCwd, srcPath)
  const rel = relative(resolve(workspaceCwd), resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`workspace path "${srcPath}" would escape the workspace root "${workspaceCwd}"`)
  }
  return resolved
}

// Resolves an artifact-store path to a validated local absolute path. Backed in production by
// ArtifactRepository.resolveManagedFilePath, which enforces that the path stays inside the artifact
// store root (security boundary) and follows symlinks safely. This product addresses artifacts by
// path (the ArtifactFile.path an agent already holds), not by an opaque id — see design note below.
export interface ArtifactResolver {
  resolveArtifactPath(path: string): Promise<string>
}

// Validates and resolves raw input specs into staged manifest entries.
//   relative src   → resolveWorkspacePath  → StagedInputEntry{kind:'upload', localPath}
//   absolute src   → artifactResolver       → StagedInputEntry{kind:'upload', localPath}
//   remote_path    → validate absolute + no unsafe/glob chars → StagedInputEntry{kind:'symlink'}
// An absolute `src` is an artifact-store path (validated to stay inside the store by the resolver);
// a relative `src` is resolved against the session workspace cwd. remote_path inputs use their own
// key, so within the src branch absolute-vs-relative is an unambiguous discriminator. Returns
// [entries, inputs_summary].
export const resolveInputs = async (
  rawInputs: RawInputSpec[],
  workspaceCwd: string | undefined,
  artifactResolver: ArtifactResolver | undefined
): Promise<{ entries: StagedInputEntry[]; inputsSummary: string }> => {
  const entries: StagedInputEntry[] = []
  const summaryParts: string[] = []

  for (const raw of rawInputs) {
    if ('remote_path' in raw) {
      // Remote symlink: validate absolute + no unsafe/glob chars.
      const rp = raw.remote_path
      if (!rp.startsWith('/')) {
        throw new Error(`remote_path must be an absolute path (got "${rp}")`)
      }
      if (GLOB_CHARS.test(rp)) {
        throw new Error(`remote_path must not contain glob characters (got "${rp}")`)
      }
      if (SHELL_UNSAFE_CHARS.test(rp)) {
        throw new Error(`remote_path must not contain shell-unsafe characters (got "${rp}")`)
      }
      const dstFilename = raw.dst_filename ?? basename(rp)
      assertBareName(dstFilename, `remote_path "${rp}"`)
      entries.push({ kind: 'symlink', remotePath: rp, dstFilename, label: rp })
      summaryParts.push(`${dstFilename} (symlink)`)
    } else {
      // src-based input: absolute → artifact store, relative → workspace.
      const { src, dst_filename: dstFilename } = raw
      assertBareName(dstFilename, `src "${src}"`)

      if (isAbsolute(src)) {
        // Artifact-store path. The resolver enforces it stays inside the artifact store root.
        if (!artifactResolver) {
          throw new Error(`Cannot resolve artifact "${src}": ArtifactResolver is not available`)
        }
        const localPath = await artifactResolver.resolveArtifactPath(src)
        entries.push({ kind: 'upload', localPath, dstFilename, label: src })
        summaryParts.push(dstFilename)
      } else {
        // Workspace-relative path.
        if (!workspaceCwd) {
          throw new Error(`Cannot resolve workspace path "${src}": workspace_cwd is not available`)
        }
        const localPath = resolveWorkspacePath(workspaceCwd, src)
        entries.push({ kind: 'upload', localPath, dstFilename, label: src })
        summaryParts.push(dstFilename)
      }
    }
  }

  const inputsSummary =
    entries.length === 0
      ? ''
      : `${entries.length} input${entries.length === 1 ? '' : 's'}: ${summaryParts.join(', ')}`

  return { entries, inputsSummary }
}

// Maximum timeout seconds allowed for a job (7 days). Commands above this are rejected.
const JOB_MAX_TIMEOUT_SECONDS = 7 * 24 * 3600

// Default timeout when not specified (24 hours).
const JOB_DEFAULT_TIMEOUT_SECONDS = 24 * 3600

// Stable facade composed from private host-profile, remote-operation and job workflows.
export class ComputeService {
  private readonly scpRunner: ScpRunner
  private readonly hostProfiles: ComputeHostProfileOwner
  private readonly remoteOperations: ComputeRemoteOperationOwner

  constructor(
    private readonly runner: SshRunner,
    private readonly repository: ComputeHostRepository,
    private readonly approvalBroker?: ComputeApprovalBroker,
    scpRunner?: ScpRunner,
    overrideDownloadsDir?: string,
    private readonly jobRepository?: ComputeJobRepository,
    private readonly onJobUpdated?: (job: import('../../shared/compute').ComputeJob) => void,
    private readonly artifactResolver?: ArtifactResolver,
    private readonly storageRoot?: string,
    private readonly concurrencyManager?: ConcurrencyManager
  ) {
    this.scpRunner = scpRunner ?? new SystemScpRunner()
    this.hostProfiles = new ComputeHostProfileOwner(runner, repository)
    this.remoteOperations = new ComputeRemoteOperationOwner(
      runner,
      repository,
      approvalBroker,
      this.scpRunner,
      overrideDownloadsDir
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

  // Submits a remote compute job asynchronously (design.md §4, §5).
  //
  // Flow:
  //   1. Validate host exists and timeout is within bounds.
  //   2. Resolve and validate inputs (workspace/artifact/remote_path).
  //   3. Pre-generate a job_id (not yet in DB).
  //   4. Check concurrency limits (if ConcurrencyManager is present).
  //   5. Fire approval gate (before any DB write or SSH).
  //   6. On approval: write ComputeJob row (status=queued or submitted) + trigger background dispatch if submitted.
  //   7. Return { job_id, provider_id, status, remote_workdir } immediately.
  //
  // The background dispatcher transitions the job to running (or error) without blocking this call.
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
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call submitJob.')
    }

    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    // Validate timeout bounds.
    const rawTimeout = options.timeoutSeconds
    if (rawTimeout !== undefined) {
      if (!Number.isFinite(rawTimeout)) {
        const err = new Error(
          `timeout_seconds must be a finite number (got ${rawTimeout}).`
        ) as Error & { computeCallError: ComputeCallError }
        err.computeCallError = {
          error_code: 'timeout',
          message: `timeout_seconds must be a finite number.`,
          retry_after_user_action: false
        }
        throw err
      }
      if (!Number.isInteger(rawTimeout) || rawTimeout <= 0) {
        const err = new Error(
          `timeout_seconds must be a positive integer (got ${rawTimeout}).`
        ) as Error & { computeCallError: ComputeCallError }
        err.computeCallError = {
          error_code: 'timeout',
          message: `timeout_seconds must be a positive integer.`,
          retry_after_user_action: false
        }
        throw err
      }
      if (rawTimeout > JOB_MAX_TIMEOUT_SECONDS) {
        const err = new Error(
          `timeout_seconds ${rawTimeout} exceeds the 7-day maximum. Use a scheduler driver for multi-day jobs.`
        ) as Error & { computeCallError: ComputeCallError }
        err.computeCallError = {
          error_code: 'timeout',
          message: `timeout_seconds exceeds the 7-day (${JOB_MAX_TIMEOUT_SECONDS}s) maximum.`,
          retry_after_user_action: false
        }
        throw err
      }
    }
    const timeoutSeconds = rawTimeout ?? JOB_DEFAULT_TIMEOUT_SECONDS

    // ── RESOLVE INPUTS (validation in main process — security boundary) ───────────
    let stagedEntries: StagedInputEntry[] = []
    let inputsSummary = ''
    if (options.inputs && options.inputs.length > 0) {
      const resolved = await resolveInputs(
        options.inputs,
        options.workspaceCwd,
        this.artifactResolver
      )
      stagedEntries = resolved.entries
      inputsSummary = resolved.inputsSummary
    }

    // Pre-generate job_id for the approval card's remote_workdir preview.
    const jobId = randomUUID()
    const remoteWorkdir = computeRemoteWorkdir(host.scratchRoot, jobId)

    // ── EARLY QUEUE-FULL CHECK (before approval gate) ─────────────────────────────
    // Advisory only: reject obviously-unacceptable jobs before prompting the user. The
    // authoritative decision (and slot reservation) happens atomically in admit() below, after
    // approval, so two concurrent submissions cannot both pass the same slot.
    const queueFullError = (): Error & { computeCallError: ComputeCallError } => {
      const message =
        'Job queue is full (100 queued jobs). Wait for queued jobs to start running before submitting more.'
      const err = new Error(message) as Error & { computeCallError: ComputeCallError }
      err.computeCallError = { error_code: 'queue_full', message, retry_after_user_action: false }
      return err
    }
    if (this.concurrencyManager) {
      const preview = await this.concurrencyManager.enqueue({
        jobId,
        sessionId: context.sessionId,
        providerId
      })
      if (preview === 'queue_full') throw queueFullError()
    }

    // ── APPROVAL GATE (must fire before any DB write or SSH) ──────────────────────
    if (!this.approvalBroker) {
      throw new Error('ComputeApprovalBroker is required to call submitJob.')
    }

    const commandPreview =
      command.length > COMMAND_PREVIEW_MAX_LEN
        ? `${command.slice(0, COMMAND_PREVIEW_MAX_LEN)}…`
        : command

    const approvalInfo = {
      provider_id: host.providerId,
      provider_name: host.displayName,
      shape: host.shape,
      intent,
      command_preview: commandPreview,
      command_full: command,
      inputs_summary: inputsSummary || undefined,
      timeout_seconds: timeoutSeconds,
      remote_workdir: remoteWorkdir
    }

    const decision = await this.approvalBroker.requestWithContext(approvalInfo, {
      sessionId: context.sessionId,
      projectId: context.projectId,
      operation: 'submit_job',
      ownerId: host.id
    })

    if (decision === 'deny') {
      const err = new Error(
        `Job submission approval was denied for host "${host.displayName}".`
      ) as Error & { computeCallError: ComputeCallError }
      err.computeCallError = {
        error_code: 'approval_denied',
        message: `Approval denied for submit_job on ${host.displayName}.`,
        retry_after_user_action: false
      }
      throw err
    }

    // ── WRITE JOB ROW ──────────────────────────────────────────────────────────────
    const commandHash = hashCommand(command)
    const inputManifest = stagedEntries.length > 0 ? JSON.stringify(stagedEntries) : undefined
    const jobRepository = this.jobRepository
    const createRow = async (initialStatus: 'submitted' | 'queued'): Promise<void> => {
      await jobRepository.create({
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
        outputManifest: options.outputManifest,
        harvestConfig: options.harvestConfig,
        timeoutSeconds,
        remoteWorkdir,
        initialStatus
      })
    }

    // With a ConcurrencyManager, decide the status and commit the row atomically so concurrent
    // submissions cannot both pass one slot. Without one, submit immediately (tests / no-limit mode).
    let initialStatus: 'submitted' | 'queued' = 'submitted'
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

    // ── BACKGROUND DISPATCH (non-blocking, only for submitted jobs) ────────────────
    // Fire-and-forget. Errors are persisted to the job row by the dispatcher.
    // Queued jobs are NOT dispatched here — they wait for ConcurrencyManager.tryDispatchNext().
    if (initialStatus === 'submitted') {
      void dispatchJob(jobId, {
        runner: this.runner,
        scpRunner: this.scpRunner,
        hostRepository: this.repository,
        jobRepository: this.jobRepository,
        onJobUpdated: this.handleJobUpdated
      })
    }

    return {
      job_id: jobId,
      provider_id: host.providerId,
      status: initialStatus,
      remote_workdir: remoteWorkdir
    }
  }

  // Returns the lightweight status shape for a job. Does not make any SSH call.
  async getJobStatus(jobId: string): Promise<import('../../shared/compute').JobStatusResult> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call getJobStatus.')
    }

    const job = await this.jobRepository.get(jobId)
    if (!job) {
      throw new Error(`No compute job found with id "${jobId}".`)
    }

    return {
      job_id: job.job_id,
      status: job.status,
      exit_code: job.exit_code,
      stdout_tail: job.stdout_tail,
      stderr_tail: job.stderr_tail,
      remote_workdir: job.remote_workdir
    }
  }

  // Returns the full job result (spec §11.4, design §9). Non-blocking: reads DB row + scans
  // the local harvest directory. Does not make any SSH call or trigger harvest.
  //
  // Four-timing semantics:
  //  1. Non-terminal (submitted/running): empty file lists, no error.
  //  2. Terminal but harvest not done (harvestedAt null): same.
  //  3. Clean harvest (harvestedAt set, harvestError null): full file lists.
  //  4. harvest_failed (harvestedAt set, harvestError non-null): partial files + remote_workdir.
  //
  // File paths are workspace-relative (e.g. "hpc/<jobId>/featured/out.result") so the agent's
  // data kernel can directly open() them relative to the workspace cwd (design §4).
  async getJobResult(jobId: string): Promise<JobResult> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call getJobResult.')
    }

    const job = await this.jobRepository.get(jobId)
    if (!job) {
      throw new Error(`No compute job found with id "${jobId}".`)
    }

    // Terminal states that can have harvest output.
    const terminalStates = new Set(['success', 'failed', 'timeout', 'error'])
    const isTerminal = terminalStates.has(job.status)

    // Parse left_on_remote JSON from the job row (may be undefined before harvest).
    let leftOnRemote: Array<{ uri: string; size_mb: number; reason: string }> = []
    if (job.left_on_remote) {
      try {
        leftOnRemote = JSON.parse(job.left_on_remote) as typeof leftOnRemote
      } catch {
        // Malformed JSON — treat as empty (same guard as harvest-engine and job-notifier).
      }
    }

    // Return empty file lists for non-terminal or pre-harvest states (design §9 rules 1 & 2).
    if (!isTerminal || !job.harvested_at) {
      return {
        job_id: job.job_id,
        status: job.status,
        exit_code: job.exit_code,
        featured_files: [],
        hidden_files: [],
        output_files: [],
        left_on_remote: [],
        remote_workdir: job.remote_workdir,
        stdout_tail: job.stdout_tail,
        stderr_tail: job.stderr_tail
      }
    }

    // Harvest is done (rules 3 & 4): scan the local harvest directory for actual files.
    // storageRoot is required to locate the harvest directory.
    const effectiveStorageRoot = this.storageRoot
    if (!effectiveStorageRoot) {
      // Fall back to empty file lists if storageRoot was not wired (should not happen in prod).
      return {
        job_id: job.job_id,
        status: job.status,
        exit_code: job.exit_code,
        featured_files: [],
        hidden_files: [],
        output_files: [],
        left_on_remote: leftOnRemote,
        remote_workdir: job.remote_workdir,
        stdout_tail: job.stdout_tail,
        stderr_tail: job.stderr_tail
      }
    }

    const harvestDir = getJobHarvestDir(
      effectiveStorageRoot,
      job.project_id,
      job.session_id,
      job.job_id
    )
    // Workspace root: one level up from hpc/<jobId>/ — the session workspace cwd.
    const workspaceCwd = getNotebookSessionRoot(
      effectiveStorageRoot,
      job.project_id,
      job.session_id
    )

    const featuredFiles = await scanDirRelative(join(harvestDir, 'featured'), workspaceCwd)
    const hiddenFiles = await scanDirRelative(join(harvestDir, 'hidden'), workspaceCwd)

    return {
      job_id: job.job_id,
      status: job.status,
      exit_code: job.exit_code,
      featured_files: featuredFiles,
      hidden_files: hiddenFiles,
      // featured first, then hidden (design §9).
      output_files: [...featuredFiles, ...hiddenFiles],
      left_on_remote: leftOnRemote,
      remote_workdir: job.remote_workdir,
      stdout_tail: job.stdout_tail,
      stderr_tail: job.stderr_tail
    }
  }

  // Sets the session-level concurrency limit. Delegates to ConcurrencyManager.
  async setSessionConcurrencyLimit(sessionId: string, limit: number): Promise<void> {
    if (!this.concurrencyManager) {
      throw new Error('ConcurrencyManager is required to set session concurrency limit.')
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(
        `Session concurrency limit must be an integer in the range 1..500 (got ${limit}).`
      )
    }

    this.concurrencyManager.setSessionLimit(sessionId, limit)
  }

  // Returns the session concurrency status (session limit, active/queued counts, provider ceilings).
  // Enriches with all registered compute hosts' concurrency limits.
  async getSessionConcurrencyStatus(sessionId: string): Promise<SessionStatus> {
    if (!this.concurrencyManager) {
      throw new Error('ConcurrencyManager is required to get session concurrency status.')
    }

    const status = await this.concurrencyManager.getStatus(sessionId)

    // Enrich with ALL registered compute hosts (not just those with jobs in this session).
    const allHosts = await this.repository.list()
    for (const host of allHosts) {
      // Only set if not already present from jobs.
      if (!(host.providerId in status.provider_ceilings)) {
        status.provider_ceilings[host.providerId] = host.concurrencyLimit ?? 10
      }
    }

    return status
  }

  // Stable producer-facing sink for every persisted job update, regardless of whether the dispatcher
  // or poller observed it. ConcurrencyManager owns the combined broadcast-and-drain policy when
  // queueing is enabled; otherwise this preserves the observer-only behavior used by lightweight
  // service configurations.
  handleJobUpdated = (job: ComputeJob): void => {
    if (this.concurrencyManager) this.concurrencyManager.handleJobUpdated(job)
    else this.onJobUpdated?.(job)
  }
}

// ---------------------------------------------------------------------------
// scanDirRelative: recursively list files under a directory, returning paths
// relative to workspaceCwd. Returns [] if the directory does not exist.
// ---------------------------------------------------------------------------

async function scanDirRelative(dir: string, workspaceCwd: string): Promise<string[]> {
  const results: string[] = []
  try {
    await collectFiles(dir, dir, workspaceCwd, results)
  } catch {
    // Directory absent (harvest not created yet, or was deleted) — return empty.
  }
  return results
}

async function collectFiles(
  baseDir: string,
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
    if (entry.isDirectory()) {
      await collectFiles(baseDir, fullPath, workspaceCwd, results)
    } else if (entry.isFile()) {
      // Use workspace-relative path so agent can open() directly (design §4).
      results.push(workspaceRelativePath(workspaceCwd, fullPath))
    }
  }
}
