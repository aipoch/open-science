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
import { JobHarvestScheduler, type HarvestFn } from './job-harvest-scheduler'
import { parsePollOutput } from './job-poll-output'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { emitJobNotification } from './job-notifier'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import { cleanupCommand } from './job-deletion-owner'
import {
  probeRemoteJobProcessOwnership,
  terminateRemoteJobProcessIfOwned
} from './remote-job-process'
import { classifyComputeJobExit } from './remote-launch-recovery'
import { SubmittedJobRecovery, type SubmittedJobRecoveryResult } from './submitted-job-recovery'
import { parseRemoteJobHandle, parseRemoteJobWorkdir } from './remote-job-handle'

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

export type { HarvestFn } from './job-harvest-scheduler'

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
  now?: () => number
  onIntegrityIssues?: (issues: Awaited<ReturnType<ComputeJobRepository['scanIntegrity']>>) => void
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
  private readonly harvestScheduler: JobHarvestScheduler | undefined
  private readonly lifecycle: ComputeJobLifecycle
  private readonly submittedJobRecovery: SubmittedJobRecovery

  //   inFlightErrorNotifs: jobIds whose error-notification emit is in progress — prevents a second
  //   overlapping tick from re-emitting before notified_at is persisted (ticks are not serialized)
  private readonly inFlightErrorNotifs = new Set<string>()
  private integrityScanComplete = false

  constructor(private readonly deps: JobPollerDeps) {
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h))
    this.makeNonceFn = deps.makeNonce ?? (() => randomBytes(12).toString('hex') + '_')
    this.dispatchTracker = deps.dispatchTracker ?? sharedDispatchTracker
    this.harvestScheduler = deps.harvestFn
      ? new JobHarvestScheduler(deps.harvestFn, deps.now)
      : undefined
    this.lifecycle = new ComputeJobLifecycle(deps.jobRepository, deps.onJobUpdated)
    this.submittedJobRecovery = new SubmittedJobRecovery(this.lifecycle)
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
    if (this.harvestScheduler) await this.harvestScheduler.waitForIdle()
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

  // One poll cycle: group non-terminal jobs by provider, poll each provider's jobs.
  // Also runs the restart-recovery harvest scan (design §3): re-queues terminal+unharvested jobs.
  async tick(signal: AbortSignal = this.workAbortController.signal): Promise<void> {
    if (signal.aborted) return
    if (
      !this.integrityScanComplete &&
      typeof this.deps.jobRepository.scanIntegrity === 'function'
    ) {
      try {
        const issues = await this.deps.jobRepository.scanIntegrity()
        this.integrityScanComplete = true
        if (issues.length > 0) this.deps.onIntegrityIssues?.(issues)
      } catch {
        // Keep startup live and retry on the next bounded poll interval. The renderer has its own
        // explicit pending-scan diagnostic; this main-process scan is detect-only hardening.
      }
    }
    // Restart-recovery harvest scan: re-queue terminal jobs whose harvest was interrupted by restart.
    // harvestFn must be configured; without it, harvest is disabled entirely.
    if (this.harvestScheduler) {
      const unharvested = await this.deps.jobRepository.findTerminalUnharvested()
      if (signal.aborted) return
      for (const job of unharvested) {
        this.harvestScheduler.schedule(job, signal)
      }
    }

    // Error-notification recovery scan: the dispatcher writes status='error' (dispatch_failed /
    // host_unreachable) but never emits a compute_done notification, and 'error' is excluded from
    // both the harvest scan and findNonTerminal. Without this, a dispatch failure would never reach
    // notify→analyze. emitJobNotification is idempotent (guards on notified_at), so a job already
    // notified via another path (e.g. the noHandle branch below) is skipped.
    if (this.deps.broadcast && this.deps.storageRoot) {
      const { broadcast, storageRoot } = this.deps
      const notificationReady = await this.deps.jobRepository.findNotificationReadyUnnotified()
      if (signal.aborted) return
      for (const job of notificationReady) {
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
      if (job.status === 'queued') continue
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

  // Polls all jobs for one provider in a single SSH round-trip (where possible).
  private async _pollProvider(
    providerId: string,
    jobs: ComputeJob[],
    signal: AbortSignal
  ): Promise<void> {
    const noHandle: ComputeJob[] = []
    const invalidHandle: ComputeJob[] = []
    const withHandle: ComputeJob[] = []
    for (const job of jobs) {
      if (job.status === 'queued') continue
      if (job.status === 'submitted' && !job.remote_handle) {
        if (this.dispatchTracker.has(job.job_id)) continue // still dispatching — not orphaned
        noHandle.push(job)
      } else if (!parseRemoteJobHandle(job.remote_handle, job.remote_workdir)) {
        invalidHandle.push(job)
      } else {
        withHandle.push(job)
      }
    }
    const recoverableNoHandle = noHandle.filter((job) => job.remote_workdir)
    const legacyNoHandle = noHandle.filter((job) => !job.remote_workdir)
    const recoverableInvalidHandle = invalidHandle.filter((job) => job.remote_workdir)
    const unrecoverableInvalidHandle = invalidHandle.filter((job) => !job.remote_workdir)
    for (const job of unrecoverableInvalidHandle) {
      if (signal.aborted) return
      this._applySubmittedRecoveryResult(await this.submittedJobRecovery.interrupt(job))
    }
    const recoverableJobs = [...recoverableNoHandle, ...recoverableInvalidHandle]
    if (withHandle.length === 0 && recoverableJobs.length === 0 && legacyNoHandle.length === 0) {
      return
    }

    let recoveryFallbackRoot: string | undefined
    let hasRecoveryFallback = false
    if (legacyNoHandle.length > 0) {
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
      await this.submittedJobRecovery.recordUnavailable(recoverableJobs, errorCode)
      await this._recordPollError([...withHandle, ...legacyNoHandle], errorCode, signal)
      return
    }
    for (const job of recoverableJobs) {
      const result = recoverableInvalidHandle.includes(job)
        ? await this.submittedJobRecovery.recoverInvalidHandle(job, connection)
        : await this.submittedJobRecovery.recover(job, connection)
      this._applySubmittedRecoveryResult(result)
    }
    for (const job of legacyNoHandle) {
      if (signal.aborted) return
      const fallbackWorkdir = hasRecoveryFallback
        ? computeRemoteWorkdir(recoveryFallbackRoot, job.job_id)
        : undefined
      const recovered = await this._recoverSubmittedJob(job, connection, signal, fallbackWorkdir)
      if (recovered) withHandle.push(recovered)
    }

    if (withHandle.length === 0) return

    // Poll bounded batches sequentially so every section fits without a per-provider SSH fan-out.
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
    const workdir = parseRemoteJobWorkdir(job.job_id, job.remote_workdir, fallbackWorkdir)
    if (!workdir) {
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
    this._dispatchErrorNotification(transition.job)
    return undefined
  }

  private _applySubmittedRecoveryResult(result: SubmittedJobRecoveryResult): void {
    if (result.kind === 'harvest') this.harvestScheduler?.schedule(result.job)
    if (result.kind === 'notification') this._dispatchErrorNotification(result.job)
  }

  private _dispatchErrorNotification(job: ComputeJob): void {
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
      const handle = parseRemoteJobHandle(job.remote_handle, job.remote_workdir)
      if (!handle) continue
      batched.push(job)

      parts.push(
        `echo "${nonce}JOB_START:${job.job_id}"`,
        `workdir=$(cd -- ${quoteRemotePath(handle.workdir)} 2>/dev/null && pwd -P || true)`,
        `process_owned_by_workdir ${handle.pid} "$workdir" && kill -0 ${handle.pid} 2>/dev/null && echo "${nonce}alive:1" || echo "${nonce}alive:0"`,
        `if [ -f ${quoteRemotePath(handle.exit_code_path)} ]; then POLL_EXIT_CODE=$(cat ${quoteRemotePath(handle.exit_code_path)}); else POLL_EXIT_CODE=; fi; printf '${nonce}exit:%s\\n' "$POLL_EXIT_CODE"`,
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

    if (runResult.truncated) {
      await this._recordPollError(batched, 'poll_protocol_incomplete', signal, false)
      return
    }

    // Parse the batched output using nonce-prefixed markers. Pass target for poller fallback kill.
    // A truncated result should be impossible now that the cap is sized to the batch, but if it ever
    // happens the head is kept, so leading jobs still parse; any job whose section was dropped simply
    // stays non-terminal and is re-polled next tick (its remote exit_code file persists).
    await this._parsePollOutput(runResult.stdout, batched, nonce, connection, signal)
  }

  // Records a transient SSH connectivity error for each job without changing job status.
  // Implements design.md §8 boundary 2: "host unreachable ≠ job failed".
  private async _recordPollError(
    jobs: ComputeJob[],
    message: string,
    signal: AbortSignal,
    retryAfterUserAction = true
  ): Promise<void> {
    for (const job of jobs) {
      if (signal.aborted) return
      if (job.status !== 'submitted' && job.status !== 'running') continue
      await this.lifecycle.recordPollError(job.job_id, job.status, message, retryAfterUserAction)
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
    const completeResults = parsedResults.filter((result) => result.status === 'complete')
    const incompleteJobs = parsedResults
      .filter((result) => result.status === 'incomplete')
      .map((result) => result.job)
    await this._recordPollError(incompleteJobs, 'poll_protocol_incomplete', signal, false)

    const safeTails = await redactConnectionOutputs(
      connection,
      completeResults.flatMap(({ stdoutTail, stderrTail }) => [stdoutTail, stderrTail])
    )
    if (signal.aborted) return
    for (const [index, result] of completeResults.entries()) {
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

      const { status, errorCode } = classifyComputeJobExit(job, exitCode)

      const transition = await this.lifecycle.finishPolled(job.job_id, {
        status,
        exitCode,
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null,
        errorCode
      })
      if (transition.kind === 'ignored') return
      // Async-dispatch harvest for success/failed/timeout (design §3). Not awaited — must not
      // block the tick loop. 'error' status is never reached here (only in the noHandle path).
      this.harvestScheduler?.schedule(transition.job, signal)
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
        if (transition.kind === 'applied') this.harvestScheduler?.schedule(transition.job, signal)
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

        const handle = parseRemoteJobHandle(current.remote_handle, current.remote_workdir)
        if (!handle) {
          await this._recordTimeoutTerminationUnconfirmed(current)
          return
        }
        // Probe failures are unknown ownership and fail closed. The termination operation repeats
        // the same cwd guard before signalling, closing the probe-to-signal PID reuse window.
        try {
          const ownership = await probeRemoteJobProcessOwnership(
            handle.pid,
            handle.workdir,
            connection
          )
          if (ownership === 'unknown') {
            if (signal.aborted) return
            await this._recordTimeoutTerminationUnconfirmed(current)
            return
          }
          if (ownership === 'owned') {
            const terminated = await terminateRemoteJobProcessIfOwned(
              handle.pid,
              handle.workdir,
              connection
            )
            if (!terminated) {
              if (signal.aborted) return
              await this._recordTimeoutTerminationUnconfirmed(current)
              return
            }
          }
        } catch {
          if (signal.aborted) return
          await this._recordTimeoutTerminationUnconfirmed(current)
          return
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
        this.harvestScheduler?.schedule(transition.job, signal)
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

  private async _recordTimeoutTerminationUnconfirmed(job: ComputeJob): Promise<void> {
    if (job.status !== 'submitted' && job.status !== 'running') return
    await this.lifecycle.recordPollError(job.job_id, job.status, 'timeout_termination_unconfirmed')
  }
}
