import { randomBytes } from 'node:crypto'

import type { ComputeJob, JobSummary } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import {
  classifyConnectionFailure,
  ComputeConnectionError,
  redactConnectionOutputs,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import {
  computeRemoteWorkdir,
  quoteRemotePath,
  REMOTE_PROCESS_OWNERSHIP_FUNCTION,
  type RemoteHandle
} from './job-dispatcher'
import { parsePollOutput } from './job-poll-output'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { emitJobNotification } from './job-notifier'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import { cleanupCommand, validatedRemoteWorkdir } from './job-deletion-owner'

// Polling interval: 15 seconds (design.md §8).
export const POLL_INTERVAL_MS = 15_000

// Maximum bytes to capture per stream tail (64 KiB per design.md §8).
const TAIL_MAX_BYTES = 65536

// Consecutive ticks without exit_code before declaring process_vanished (design.md §8 §3).
const PROCESS_VANISHED_TICKS = 2

// Timeout for the per-host poll SSH command.
const POLL_TIMEOUT_MS = 30_000

// Per-job output budget for a poll: two tails (stdout+stderr) plus marker/pid/exit-code lines.
// The 1 KiB pad covers the seven nonce-prefixed marker lines and the exit-code/alive output.
const PER_JOB_POLL_BYTES = TAIL_MAX_BYTES * 2 + 1024

// Maximum jobs polled in a single SSH round-trip. All non-terminal jobs for one provider used to be
// batched into ONE ssh call sized for a single job, so a provider with N running jobs overflowed the
// output cap and the trailing jobs' sections were silently dropped (truncation keeps the head). We
// now poll in sub-batches of at most this many jobs, sizing the output cap to the sub-batch, which
// bounds peak memory per call (~POLL_BATCH_MAX_JOBS × PER_JOB_POLL_BYTES ≈ 1 MiB) while guaranteeing
// every job's section fits.
const POLL_BATCH_MAX_JOBS = 8

// Grace period added to timeout_seconds before the poller forcibly kills a still-running job
// (design.md §10). This gives the remote `timeout` command time to deliver SIGTERM+SIGKILL
// cleanly and write the exit_code file (exit 124) before the poller intervenes.
const POLLER_KILL_GRACE_SECONDS = 60

// Maximum concurrent harvest operations (design.md §3: concurrency limit 2).
const HARVEST_CONCURRENCY_LIMIT = 2

const buildDispatchRecoveryCommand = (workdir: string): string => {
  const marker = '/.openscience/jobs/'
  const markerIndex = workdir.lastIndexOf(marker)
  if (markerIndex < 0) throw new Error('Unsafe remote Compute Job recovery path.')
  const scratchRoot = markerIndex === 0 ? '/' : workdir.slice(0, markerIndex)
  const workdirSuffix = workdir.slice(markerIndex + 1)
  const quotedScratchRoot = quoteRemotePath(scratchRoot)
  const quotedWorkdirSuffix = quoteRemotePath(workdirSuffix)
  const quotedWorkdir = quoteRemotePath(workdir)
  const quotedPidFile = quoteRemotePath(`${workdir}/job.pid`)
  const quotedExitCodeFile = quoteRemotePath(`${workdir}/exit_code`)

  return [
    `[ ! -L ${quotedWorkdir} ] || exit 3`,
    `scratch_root=$(cd -- ${quotedScratchRoot} 2>/dev/null && pwd -P || true)`,
    `workdir=$(cd -- ${quotedWorkdir} 2>/dev/null && pwd -P || true)`,
    'expected_workdir=${scratch_root%/}/' + quotedWorkdirSuffix,
    '[ -n "$workdir" ] && [ -n "$scratch_root" ] && [ "$workdir" = "$expected_workdir" ] || exit 3',
    `pid=$(cat ${quotedPidFile} 2>/dev/null || true)`,
    `case "$pid" in ''|*[!0-9]*) exit 2 ;; esac`,
    REMOTE_PROCESS_OWNERSHIP_FUNCTION,
    `if [ ! -f ${quotedExitCodeFile} ]; then process_owned_by_workdir "$pid" "$workdir" || exit 2; fi`,
    `started_at=$(stat -c %Y ${quotedPidFile} 2>/dev/null || stat -f %m ${quotedPidFile} 2>/dev/null || true)`,
    `case "$started_at" in ''|*[!0-9]*) exit 2 ;; esac`,
    `printf '%s\n%s\n' "$pid" "$started_at"`
  ].join('\n')
}

/** Injectable harvest operation. Production supplies `harvestJob` from harvest-engine.ts. */
export type HarvestFn = (job: ComputeJob, signal?: AbortSignal) => Promise<void>

export type JobPollerDeps = {
  connectionBroker: ComputeConnectionBrokerAcquirer
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  // Optional broadcast hook for Phase 3d renderer IPC; no-op when omitted.
  onJobUpdated?: (job: ComputeJob) => void
  // Injectable timer for tests (defaults to global setInterval/clearInterval).
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
  // Injectable nonce generator for tests (defaults to a random per-tick hex string).
  makeNonce?: () => string
  // Shared with the dispatcher so the poller can tell a job that is still actively dispatching
  // (in-flight in this process) from one orphaned by an app restart. Defaults to the shared tracker.
  dispatchTracker?: DispatchTracker
  // Injectable harvest function (design §3). When omitted, harvest is disabled (no-op).
  // In production, wire this to harvestJob from harvest-engine.ts.
  harvestFn?: HarvestFn
  /**
   * Broadcast hook for compute_done notification (issue 06).
   * Used when emitting the notification for execution-error jobs (dispatch_failed).
   * Harvest-triggered notifications use harvestFn's own broadcast dep.
   * When omitted, no notification is emitted for error-state jobs.
   */
  broadcast?: (summary: JobSummary) => void
  /**
   * Storage root for the workspace path (issue 06).
   * Required when broadcast is set; used to compute the harvest dir path.
   */
  storageRoot?: string
}

// Per-job vanish counter (lives here because the poller is the only thing that increments it).
type VanishState = { ticks: number }

// JobPoller runs in the main process, independent of any kernel lifetime. It polls all non-terminal
// jobs every 15 s, batching by provider to minimise SSH connections. App restart resumes from DB.
// In 3b it also drives harvest: on terminal transition it async-dispatches harvestFn (no-await),
// bounded by a concurrency semaphore of 2 and an in-flight dedup Set (design §3).
export class JobPoller {
  private handle: ReturnType<typeof setInterval> | undefined
  private paused = false
  private workAbortController = new AbortController()
  private readonly activeTicks = new Set<Promise<void>>()
  private readonly backgroundTasks = new Set<Promise<void>>()
  private readonly vanishCounters = new Map<string, VanishState>()
  private readonly pollResultChains = new Map<string, Promise<void>>()

  // Injectable timers (tests override to control ticks synchronously).
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void
  // Injectable nonce generator (tests override for deterministic marker matching).
  private readonly makeNonceFn: () => string
  // Shared dispatch tracker (see JobPollerDeps.dispatchTracker).
  private readonly dispatchTracker: DispatchTracker
  // Optional injectable harvest function (design §3).
  private readonly harvestFn: HarvestFn | undefined
  private readonly lifecycle: ComputeJobLifecycle

  // Harvest concurrency state: deduplicate by job id and run at most two operations at once.
  private readonly inFlightHarvests = new Set<string>()
  private harvestSemaphore = HARVEST_CONCURRENCY_LIMIT
  private readonly harvestQueue: Array<{ job: ComputeJob; signal: AbortSignal }> = []
  //   inFlightErrorNotifs: jobIds whose error-notification emit is in progress — prevents a second
  //   overlapping tick from re-emitting before notified_at is persisted (ticks are not serialized)
  private readonly inFlightErrorNotifs = new Set<string>()

  constructor(private readonly deps: JobPollerDeps) {
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h))
    this.makeNonceFn = deps.makeNonce ?? (() => randomBytes(12).toString('hex') + '_')
    this.dispatchTracker = deps.dispatchTracker ?? sharedDispatchTracker
    this.harvestFn = deps.harvestFn
    this.lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
  }

  // Poll once immediately for restart recovery, then on every interval.
  start(): void {
    if (this.handle) return // already running

    if (this.workAbortController.signal.aborted) {
      this.workAbortController = new AbortController()
    }
    this.paused = false
    this.runTick() // first tick immediately (restart recovery)
    this.handle = this.setIntervalFn(() => this.runTick(), POLL_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    this.paused = true
    if (this.handle) {
      this.clearIntervalFn(this.handle)
      this.handle = undefined
    }
    this.workAbortController.abort()
    for (const { job } of this.harvestQueue.splice(0)) {
      this.inFlightHarvests.delete(job.job_id)
    }
    await this.drainTrackedWork()
  }

  async pause(): Promise<void> {
    this.paused = true
    await this.drainTrackedWork()
  }

  private async drainTrackedWork(): Promise<void> {
    while (this.activeTicks.size > 0 || this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.activeTicks, ...this.backgroundTasks])
    }
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (this.handle) this.runTick()
  }

  private runTick(): void {
    if (this.paused || this.activeTicks.size > 0) return
    const task = this.tick(this.workAbortController.signal)
    this.activeTicks.add(task)
    void task.then(
      () => this.activeTicks.delete(task),
      () => this.activeTicks.delete(task)
    )
  }

  private trackBackground(task: Promise<void>): void {
    this.backgroundTasks.add(task)
    void task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task)
    )
  }

  // Poll non-terminal jobs by provider and recover interrupted harvests.
  async tick(signal: AbortSignal = this.workAbortController.signal): Promise<void> {
    if (signal.aborted) return
    // Restart-recovery harvest scan: re-queue terminal jobs whose harvest was interrupted by restart.
    // harvestFn must be configured; without it, harvest is disabled entirely.
    if (this.harvestFn) {
      const unharvested = await this.deps.jobRepository.findTerminalUnharvested()
      if (signal.aborted) return
      for (const job of unharvested) {
        this._dispatchHarvest(job, signal)
      }
    }

    // Error-notification recovery scan: the dispatcher writes status='error' (dispatch_failed /
    // host_unreachable) but never emits a compute_done notification, and 'error' is excluded from
    // both the harvest scan and findNonTerminal. Without this, a dispatch failure would never reach
    // notify→analyze. emitJobNotification is idempotent (guards on notified_at), so a job already
    // notified via another path (e.g. the noHandle branch below) is skipped.
    if (this.deps.broadcast && this.deps.storageRoot) {
      const { broadcast, storageRoot } = this.deps
      const errorUnnotified = await this.deps.jobRepository.findErrorUnnotified()
      if (signal.aborted) return
      for (const job of errorUnnotified) {
        // emitJobNotification guards on notified_at (idempotent), but that is a check-then-act
        // with a real window: ticks are not serialized, so a second tick could re-select this row
        // before the notified_at write commits and emit a duplicate user-visible notification. The
        // in-flight set closes that window (mirrors inFlightHarvests for the harvest scan).
        if (this.inFlightErrorNotifs.has(job.job_id)) continue
        this.inFlightErrorNotifs.add(job.job_id)
        const task = emitJobNotification(job, {
          jobRepository: this.deps.jobRepository,
          hostRepository: this.deps.hostRepository,
          storageRoot,
          broadcast
        })
          .catch(() => {
            // Non-fatal: job status is already persisted; retry on the next tick.
          })
          .finally(() => {
            this.inFlightErrorNotifs.delete(job.job_id)
          })
        this.trackBackground(task)
      }
    }

    const jobs = await this.deps.jobRepository.findNonTerminal()
    if (signal.aborted) return
    if (jobs.length === 0) return

    // Group by provider.
    const byProvider = new Map<string, ComputeJob[]>()
    for (const job of jobs) {
      const list = byProvider.get(job.provider_id) ?? []
      list.push(job)
      byProvider.set(job.provider_id, list)
    }

    // Poll each provider's jobs in parallel (different SSH connections, no ordering dependency).
    await Promise.all(
      Array.from(byProvider.entries()).map(([providerId, providerJobs]) =>
        this._pollProvider(providerId, providerJobs, signal)
      )
    )
  }

  // ---------------------------------------------------------------------------
  // Harvest dispatch helpers (design §3)
  // ---------------------------------------------------------------------------

  // Fire-and-forget harvest dispatch with in-flight deduplication and bounded concurrency.
  private _dispatchHarvest(job: ComputeJob, signal: AbortSignal): void {
    if (!this.harvestFn || signal.aborted) return
    // In-flight dedup: if already harvesting this job, skip.
    if (this.inFlightHarvests.has(job.job_id)) return

    this.inFlightHarvests.add(job.job_id)

    if (this.harvestSemaphore > 0) {
      // Slot available — start immediately.
      this._runHarvest(job, signal)
    } else {
      // No slot — enqueue; will be started when a running harvest completes.
      this.harvestQueue.push({ job, signal })
    }
  }

  // Acquires a semaphore slot, runs harvestFn, then releases the slot and drains the queue.
  private _runHarvest(job: ComputeJob, signal: AbortSignal): void {
    if (!this.harvestFn) return
    this.harvestSemaphore--

    // Fire-and-forget: intentionally not awaited.
    const task = this.harvestFn(job, signal)
      .catch(() => {
        // Individual harvest failures must not propagate to the poller (design §3: error isolation).
      })
      .finally(() => {
        this.inFlightHarvests.delete(job.job_id)
        this.harvestSemaphore++
        // Drain one item from the queue if any are waiting.
        const next = this.harvestQueue.shift()
        if (next && !next.signal.aborted) {
          this._runHarvest(next.job, next.signal)
        } else if (next) {
          this.inFlightHarvests.delete(next.job.job_id)
        }
      })
    this.trackBackground(task)
  }

  // Polls all jobs for one provider in a single SSH round-trip (where possible).
  private async _pollProvider(
    providerId: string,
    jobs: ComputeJob[],
    signal: AbortSignal
  ): Promise<void> {
    // A submitted job without a handle may still be staging large inputs. Only an untracked job is
    // an interrupted dispatch; DispatchTracker distinguishes it from live work in this process.
    const noHandle: ComputeJob[] = []
    const withHandle: ComputeJob[] = []
    for (const job of jobs) {
      if (job.status === 'submitted' && !job.remote_handle) {
        if (this.dispatchTracker.has(job.job_id)) continue // still dispatching — not orphaned
        noHandle.push(job)
      } else {
        withHandle.push(job)
      }
    }

    if (withHandle.length === 0 && noHandle.length === 0) return

    let recoveryFallbackRoot: string | undefined
    let hasRecoveryFallback = false
    if (noHandle.some((job) => !job.remote_workdir)) {
      const host = await this.deps.hostRepository.get(providerId)
      if (signal.aborted) return
      if (host) {
        recoveryFallbackRoot = host.scratchRoot
        hasRecoveryFallback = true
      }
    }

    let connection: ComputeConnectionLease
    try {
      connection = await this.deps.connectionBroker.acquire(providerId, {
        intent: 'job_poll',
        signal
      })
    } catch (error) {
      if (signal.aborted) return
      const errorCode = error instanceof ComputeConnectionError ? error.code : 'host_unreachable'
      await this._recordPollError([...withHandle, ...noHandle], errorCode, signal)
      return
    }

    for (const job of noHandle) {
      if (signal.aborted) return
      const fallbackWorkdir =
        !job.remote_workdir && hasRecoveryFallback
          ? computeRemoteWorkdir(recoveryFallbackRoot, job.job_id)
          : undefined
      const recovered = await this._recoverSubmittedJob(job, connection, signal, fallbackWorkdir)
      if (recovered) withHandle.push(recovered)
    }

    if (withHandle.length === 0) return

    // Poll bounded sub-batches sequentially over one provider connection.
    for (let i = 0; i < withHandle.length; i += POLL_BATCH_MAX_JOBS) {
      if (signal.aborted) return
      const batch = withHandle.slice(i, i + POLL_BATCH_MAX_JOBS)
      await this._pollBatch(batch, connection, signal)
    }
  }

  private async _recoverSubmittedJob(
    job: ComputeJob,
    connection: ComputeConnectionLease,
    signal: AbortSignal,
    fallbackWorkdir?: string
  ): Promise<ComputeJob | undefined> {
    let workdir: string
    try {
      workdir = validatedRemoteWorkdir(job, fallbackWorkdir)
    } catch {
      await this._recordPollError([job], 'dispatch_recovery_required', signal)
      return undefined
    }

    let recoveryResult
    try {
      recoveryResult = await connection.run(buildDispatchRecoveryCommand(workdir), {
        timeoutMs: POLL_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: 64,
        signal
      })
    } catch (error) {
      if (signal.aborted) return undefined
      const errorCode = error instanceof ComputeConnectionError ? error.code : 'host_unreachable'
      await this._recordPollError([job], errorCode, signal)
      return undefined
    }

    if (signal.aborted) return undefined
    const connectionFailure = classifyConnectionFailure(recoveryResult, false)
    if (connectionFailure) {
      await this._recordPollError([job], connectionFailure.code, signal)
      return undefined
    }

    const recoveryLines = recoveryResult.stdout.trim().split(/\r?\n/)
    const [pidText = '', startedAtText = ''] = recoveryLines
    const pid = /^[1-9][0-9]*$/.test(pidText) ? Number(pidText) : Number.NaN
    const startedAtSeconds = /^[1-9][0-9]*$/.test(startedAtText)
      ? Number(startedAtText)
      : Number.NaN
    const startedAt = new Date(startedAtSeconds * 1000)
    if (
      recoveryResult.exitCode === 0 &&
      recoveryLines.length === 2 &&
      Number.isSafeInteger(pid) &&
      Number.isSafeInteger(startedAtSeconds) &&
      Number.isFinite(startedAt.getTime())
    ) {
      const remoteHandle: RemoteHandle = {
        pid,
        exit_code_path: `${workdir}/exit_code`,
        stdout_path: `${workdir}/stdout`,
        stderr_path: `${workdir}/stderr`,
        workdir
      }
      const transition = await this.lifecycle.dispatchRunning(
        job.job_id,
        JSON.stringify(remoteHandle),
        startedAt,
        job.remote_workdir ? undefined : workdir
      )
      return transition.kind === 'applied' ? transition.job : undefined
    }

    // The exact workdir was reachable but did not contain a valid launch receipt. Reuse the
    // deletion owner's fail-closed cleanup: it only signals a PID whose cwd proves ownership, then
    // removes the exact validated Job directory. Do not terminalize the row unless cleanup succeeds.
    let cleanupResult
    try {
      cleanupResult = await connection.run(cleanupCommand(workdir, undefined), {
        timeoutMs: POLL_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: 64,
        signal
      })
    } catch {
      if (signal.aborted) return undefined
      await this._recordPollError([job], 'dispatch_recovery_required', signal)
      return undefined
    }

    if (signal.aborted) return undefined
    if (classifyConnectionFailure(cleanupResult, false) || cleanupResult.exitCode !== 0) {
      await this._recordPollError([job], 'dispatch_recovery_required', signal)
      return undefined
    }

    const transition = await this.lifecycle.recoverInterruptedDispatch(job.job_id)
    if (transition.kind === 'ignored') return undefined
    this._notifyExecutionError(transition.job)
    return undefined
  }

  private _notifyExecutionError(job: ComputeJob): void {
    if (!this.deps.broadcast || !this.deps.storageRoot) return
    const task = emitJobNotification(job, {
      jobRepository: this.deps.jobRepository,
      hostRepository: this.deps.hostRepository,
      storageRoot: this.deps.storageRoot,
      broadcast: this.deps.broadcast
    }).catch(() => {
      // Non-fatal: job status is already persisted.
    })
    this.trackBackground(task)
  }

  // Polls one sub-batch of jobs (all with handles) in a single SSH round-trip, sizing the output cap
  // to the batch so no job's section is truncated away.
  private async _pollBatch(
    jobs: ComputeJob[],
    connection: ComputeConnectionLease,
    signal: AbortSignal
  ): Promise<void> {
    // Prefix structural markers with an unpredictable nonce so job output cannot spoof them.
    const nonce = this.makeNonceFn()

    // Build one ownership/status/tail command section per job.
    const parts: string[] = [REMOTE_PROCESS_OWNERSHIP_FUNCTION]
    const batched: ComputeJob[] = []
    for (const job of jobs) {
      const handle = this._parseHandle(job.remote_handle)
      if (!handle) continue
      batched.push(job)

      parts.push(
        `echo "${nonce}JOB_START:${job.job_id}"`,
        `workdir=$(cd -- ${quoteRemotePath(handle.workdir)} 2>/dev/null && pwd -P || true)`,
        `process_owned_by_workdir ${handle.pid} "$workdir" && kill -0 ${handle.pid} 2>/dev/null && echo "${nonce}alive:1" || echo "${nonce}alive:0"`,
        `if [ -f ${quoteRemotePath(handle.exit_code_path)} ]; then cat ${quoteRemotePath(handle.exit_code_path)}; else echo ""; fi`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(handle.stdout_path)} 2>/dev/null || true`,
        `echo "${nonce}STDOUT_END:${job.job_id}"`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(handle.stderr_path)} 2>/dev/null || true`,
        `echo "${nonce}STDERR_END:${job.job_id}"`
      )
    }

    if (batched.length === 0) return

    // Size the output cap to this batch: one PER_JOB_POLL_BYTES budget per job that emits a section.
    const maxOutputBytes = batched.length * PER_JOB_POLL_BYTES
    const pollCmd = parts.join('\n')
    let runResult
    try {
      runResult = await connection.run(pollCmd, {
        timeoutMs: POLL_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes,
        signal
      })
    } catch (err) {
      if (signal.aborted) return
      // SSH threw — record lastPollError for each job but do NOT flip status (design.md §8 boundary 2).
      const errorCode = err instanceof ComputeConnectionError ? err.code : 'host_unreachable'
      await this._recordPollError(batched, errorCode, signal)
      return
    }

    if (signal.aborted) return

    const connectionFailure = classifyConnectionFailure(runResult, false)
    if (connectionFailure) {
      // Host unreachable — record error per job but do NOT flip status (design.md §8 boundary 2).
      await this._recordPollError(batched, connectionFailure.code, signal)
      return
    }

    // Parse the batched output using nonce-prefixed markers. Pass target for poller fallback kill.
    // A truncated result should be impossible now that the cap is sized to the batch, but if it ever
    // happens the head is kept, so leading jobs still parse; any job whose section was dropped simply
    // stays non-terminal and is re-polled next tick (its remote exit_code file persists).
    await this._parsePollOutput(runResult.stdout, batched, nonce, connection, signal)
  }

  private _parseHandle(raw: string | undefined): RemoteHandle | null {
    if (!raw) return null
    try {
      return JSON.parse(raw) as RemoteHandle
    } catch {
      return null
    }
  }

  // Records a transient SSH connectivity error for each job without changing job status.
  // Implements design.md §8 boundary 2: "host unreachable ≠ job failed".
  private async _recordPollError(
    jobs: ComputeJob[],
    message: string,
    signal: AbortSignal
  ): Promise<void> {
    for (const job of jobs) {
      if (signal.aborted) return
      if (job.status !== 'submitted' && job.status !== 'running') continue
      await this.lifecycle.recordPollError(job.job_id, job.status, message)
    }
  }

  // Parses the batched poll output and updates each job accordingly. All structural markers carry
  // the per-tick `nonce` prefix so adversarial job tail content cannot collide with them.
  // `target` is threaded through so _applyPollResult can issue the poller-fallback kill command.
  private async _parsePollOutput(
    output: string,
    jobs: ComputeJob[],
    nonce: string,
    connection: ComputeConnectionLease,
    signal: AbortSignal
  ): Promise<void> {
    const parsedResults = parsePollOutput(output, jobs, nonce)

    const safeTails = await redactConnectionOutputs(
      connection,
      parsedResults.flatMap(({ stdoutTail, stderrTail }) => [stdoutTail, stderrTail])
    )
    if (signal.aborted) return
    for (const [index, result] of parsedResults.entries()) {
      if (signal.aborted) return
      await this._applyPollResult(
        result.job,
        {
          alive: result.alive,
          exitCode: result.exitCode,
          hasExitCode: result.hasExitCode,
          stdoutTail: safeTails[index * 2] ?? '',
          stderrTail: safeTails[index * 2 + 1] ?? ''
        },
        connection,
        signal
      )
    }
  }

  private async _applyPollResult(
    job: ComputeJob,
    result: {
      alive: boolean
      exitCode: number | null
      hasExitCode: boolean
      stdoutTail: string
      stderrTail: string
    },
    connection: ComputeConnectionLease,
    signal: AbortSignal
  ): Promise<void> {
    const previous = this.pollResultChains.get(job.job_id) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this._applyPollResultExclusive(job, result, connection, signal))
    this.pollResultChains.set(job.job_id, current)

    try {
      await current
    } finally {
      if (this.pollResultChains.get(job.job_id) === current) {
        this.pollResultChains.delete(job.job_id)
      }
    }
  }

  private async _applyPollResultExclusive(
    job: ComputeJob,
    result: {
      alive: boolean
      exitCode: number | null
      hasExitCode: boolean
      stdoutTail: string
      stderrTail: string
    },
    connection: ComputeConnectionLease,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) return
    const { alive, exitCode, hasExitCode, stdoutTail, stderrTail } = result

    // Terminal: exit_code file exists — this is authoritative.
    if (hasExitCode && exitCode !== null) {
      // Reset vanish counter since we have a definitive result.
      this.vanishCounters.delete(job.job_id)

      let status: 'success' | 'failed' | 'timeout'
      let errorCode: string | undefined

      if (exitCode === 0) {
        status = 'success'
      } else if (exitCode === 124) {
        status = 'timeout'
        errorCode = 'timeout'
      } else if (exitCode === 137) {
        // SIGKILL: check elapsed time to disambiguate timeout vs OOM kill.
        const startedAt = job.started_at
        const timeoutSecs = job.timeout_seconds ?? 86400
        const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0
        if (elapsed >= timeoutSecs) {
          status = 'timeout'
          errorCode = 'timeout'
        } else {
          status = 'failed'
          errorCode = 'job_failed'
        }
      } else {
        status = 'failed'
        errorCode = 'job_failed'
      }

      const transition = await this.lifecycle.finishPolled(job.job_id, {
        status,
        exitCode,
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null,
        errorCode: errorCode ?? null
      })
      if (transition.kind === 'ignored') return
      // Async-dispatch harvest for success/failed/timeout (design §3). Not awaited — must not
      // block the tick loop. 'error' status is never reached here (only in the noHandle path).
      this._dispatchHarvest(transition.job, signal)
      return
    }

    // Process gone but no exit_code file — potential process_vanished.
    if (!alive && !hasExitCode) {
      const state = this.vanishCounters.get(job.job_id) ?? { ticks: 0 }
      state.ticks++
      this.vanishCounters.set(job.job_id, state)

      if (state.ticks >= PROCESS_VANISHED_TICKS) {
        this.vanishCounters.delete(job.job_id)
        const transition = await this.lifecycle.finishPolled(job.job_id, {
          status: 'failed',
          errorCode: 'process_vanished',
          stdoutTail: stdoutTail || null,
          stderrTail: stderrTail || null
        })
        // process_vanished is a terminal state — dispatch harvest (design §3).
        if (transition.kind === 'applied') this._dispatchHarvest(transition.job, signal)
      }
      // else: keep running, check again next tick
      return
    }

    // Still alive (running) — check poller fallback timeout, then update tails. Reset vanish counter.
    this.vanishCounters.delete(job.job_id)

    // Poller fallback: if job is still alive past startedAt + timeout + grace, the remote `timeout`
    // command may have been absent or hung. Kill the pid and mark as timeout (design.md §10).
    const startedAt = job.started_at
    const timeoutSecs = job.timeout_seconds ?? 86400
    if (startedAt) {
      const elapsedSecs = (Date.now() - startedAt) / 1000
      if (elapsedSecs >= timeoutSecs + POLLER_KILL_GRACE_SECONDS) {
        // Same-job poll results are serialized. Re-read after acquiring that chain so an earlier
        // terminal result can suppress this stale destructive observation before any remote kill.
        const current = await this.deps.jobRepository.get(job.job_id)
        if (signal.aborted) return
        if (!current || (current.status !== 'submitted' && current.status !== 'running')) return

        const handle = this._parseHandle(current.remote_handle)
        if (handle) {
          // Best-effort kill; ignore errors (process may have already exited).
          try {
            await connection.run(
              [
                REMOTE_PROCESS_OWNERSHIP_FUNCTION,
                `workdir=$(cd -- ${quoteRemotePath(handle.workdir)} 2>/dev/null && pwd -P || true)`,
                `process_owned_by_workdir ${handle.pid} "$workdir" && kill ${handle.pid} 2>/dev/null || true`,
                `process_owned_by_workdir ${handle.pid} "$workdir" && kill -9 ${handle.pid} 2>/dev/null || true`
              ].join('\n'),
              {
                timeoutMs: 10_000,
                loginShell: false,
                maxOutputBytes: 64,
                signal
              }
            )
          } catch {
            // Ignore kill errors — the job is marked terminal regardless.
          }
        }
        if (signal.aborted) return
        const transition = await this.lifecycle.finishPolled(job.job_id, {
          status: 'timeout',
          errorCode: 'timeout',
          stdoutTail: stdoutTail || null,
          stderrTail: stderrTail || null
        })
        if (transition.kind === 'ignored') return
        // Poller-fallback timeout is a terminal state — dispatch harvest (design §3).
        this._dispatchHarvest(transition.job, signal)
        return
      }
    }

    if (job.status !== 'submitted' && job.status !== 'running') return
    if (signal.aborted) return
    // Transition a submitted-with-handle recovery to running, or refresh an existing running row.
    // A successful poll also clears any stale connectivity projection.
    await this.lifecycle.observeRunning(job.job_id, job.status, {
      stdoutTail: stdoutTail || null,
      stderrTail: stderrTail || null
    })
  }
}
