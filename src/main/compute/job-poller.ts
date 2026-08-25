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
  quoteRemotePath,
  REMOTE_PROCESS_OWNERSHIP_FUNCTION,
  type RemoteHandle
} from './job-dispatcher'
import { parsePollOutput } from './job-poll-output'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { emitJobNotification } from './job-notifier'
import { ComputeJobLifecycle } from './compute-job-lifecycle'

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

/**
 * Injectable harvest function type. The poller calls this for each terminal job that needs
 * harvesting (design §3). In production this is `harvestJob` from harvest-engine.ts.
 * Accepting the full job object lets the function access all fields without extra lookups.
 */
export type HarvestFn = (job: ComputeJob) => Promise<void>

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

  // Harvest concurrency state (design §3):
  //   inFlightHarvests: jobIds whose harvest is currently running — prevents duplicate dispatches
  //   harvestSemaphore: count of available harvest slots (starts at HARVEST_CONCURRENCY_LIMIT)
  //   harvestQueue: jobs waiting for a semaphore slot
  private readonly inFlightHarvests = new Set<string>()
  private harvestSemaphore = HARVEST_CONCURRENCY_LIMIT
  private readonly harvestQueue: ComputeJob[] = []
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

  // Starts the poller. Polls once immediately (picks up jobs that were running before restart),
  // then on every interval.
  start(): void {
    if (this.handle) return // already running

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
    const task = this.tick()
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
  async tick(): Promise<void> {
    // Restart-recovery harvest scan: re-queue terminal jobs whose harvest was interrupted by restart.
    // harvestFn must be configured; without it, harvest is disabled entirely.
    if (this.harvestFn) {
      const unharvested = await this.deps.jobRepository.findTerminalUnharvested()
      for (const job of unharvested) {
        this._dispatchHarvest(job)
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
        this._pollProvider(providerId, providerJobs)
      )
    )
  }

  // ---------------------------------------------------------------------------
  // Harvest dispatch helpers (design §3)
  // ---------------------------------------------------------------------------

  // Dispatches a harvest for a terminal job. Fire-and-forget: does NOT await the harvest so the
  // poller tick returns immediately (hard constraint: design §3 "never await in tick loop").
  // Enforces: in-flight dedup (same job not re-dispatched while harvest is running), and the
  // concurrency semaphore (at most HARVEST_CONCURRENCY_LIMIT harvests run simultaneously).
  private _dispatchHarvest(job: ComputeJob): void {
    if (!this.harvestFn) return
    // In-flight dedup: if already harvesting this job, skip.
    if (this.inFlightHarvests.has(job.job_id)) return

    this.inFlightHarvests.add(job.job_id)

    if (this.harvestSemaphore > 0) {
      // Slot available — start immediately.
      this._runHarvest(job)
    } else {
      // No slot — enqueue; will be started when a running harvest completes.
      this.harvestQueue.push(job)
    }
  }

  // Acquires a semaphore slot, runs harvestFn, then releases the slot and drains the queue.
  private _runHarvest(job: ComputeJob): void {
    if (!this.harvestFn) return
    this.harvestSemaphore--

    // Fire-and-forget: intentionally not awaited.
    const task = this.harvestFn(job)
      .catch(() => {
        // Individual harvest failures must not propagate to the poller (design §3: error isolation).
      })
      .finally(() => {
        this.inFlightHarvests.delete(job.job_id)
        this.harvestSemaphore++
        // Drain one item from the queue if any are waiting.
        const next = this.harvestQueue.shift()
        if (next) {
          this._runHarvest(next)
        }
      })
    this.trackBackground(task)
  }

  // Polls all jobs for one provider in a single SSH round-trip (where possible).
  private async _pollProvider(providerId: string, jobs: ComputeJob[]): Promise<void> {
    // Handle jobs stuck in 'submitted' with no pid. A job sits in this state for the whole dispatch
    // window (mkdir + input staging + launch), and input staging can scp GB-scale files for up to
    // 30 min. So 'submitted'+no-handle does NOT by itself mean a failed dispatch: it only means a
    // failed dispatch if no dispatch is actively running for it in this process. The shared
    // DispatchTracker disambiguates — an untracked such job was orphaned by an app restart and is
    // marked error/dispatch_failed (design.md §8 boundary 3); a tracked one is still dispatching and
    // is left alone until the dispatcher writes its terminal or running state.
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

    for (const job of noHandle) {
      const transition = await this.lifecycle.recoverInterruptedDispatch(job.job_id)
      if (transition.kind === 'ignored') continue
      const updated = transition.job
      // Emit compute_done notification for execution-error jobs (design §8: error is a final
      // resting state). Fire-and-forget: notification failure must not break the poller tick.
      if (this.deps.broadcast && this.deps.storageRoot) {
        const task = emitJobNotification(updated, {
          jobRepository: this.deps.jobRepository,
          hostRepository: this.deps.hostRepository,
          storageRoot: this.deps.storageRoot,
          broadcast: this.deps.broadcast
        }).catch(() => {
          // Non-fatal: job status is already persisted.
        })
        this.trackBackground(task)
      }
    }

    if (withHandle.length === 0) return

    let connection: ComputeConnectionLease
    try {
      connection = await this.deps.connectionBroker.acquire(providerId, { intent: 'job_poll' })
    } catch (error) {
      const errorCode = error instanceof ComputeConnectionError ? error.code : 'host_unreachable'
      await this._recordPollError(withHandle, errorCode)
      return
    }

    // Poll in sub-batches so the SSH output cap always fits every job's section. Each sub-batch is
    // one SSH round-trip; batches for the same provider run sequentially to reuse one connection and
    // avoid a fan-out of concurrent ssh processes per provider.
    for (let i = 0; i < withHandle.length; i += POLL_BATCH_MAX_JOBS) {
      const batch = withHandle.slice(i, i + POLL_BATCH_MAX_JOBS)
      await this._pollBatch(batch, connection)
    }
  }

  // Polls one sub-batch of jobs (all with handles) in a single SSH round-trip, sizing the output cap
  // to the batch so no job's section is truncated away.
  private async _pollBatch(jobs: ComputeJob[], connection: ComputeConnectionLease): Promise<void> {
    // Per-tick random nonce prefixed onto every structural marker. Job stdout/stderr tails are
    // interleaved into the same stream, so bare markers (JOB_START:/alive:/STDOUT_END:/...) printed
    // by the job could otherwise hijack section splitting or field parsing. An unpredictable nonce
    // the job cannot know makes such collisions effectively impossible.
    const nonce = this.makeNonceFn()

    // Build per-job check commands, batched into one SSH round-trip.
    // Format per job (each marker carries the nonce prefix):
    //   echo "<nonce>JOB_START:<jobId>"
    //   resolve the canonical workdir and prove the pid still owns it
    //   kill -0 <pid> 2>/dev/null && echo "<nonce>alive:1" || echo "<nonce>alive:0"
    //   test -f <exit_code_path> && cat <exit_code_path> || echo ""
    //   tail -c 65536 <stdout_path> 2>/dev/null || true
    //   echo "<nonce>STDOUT_END:<jobId>"
    //   tail -c 65536 <stderr_path> 2>/dev/null || true
    //   echo "<nonce>STDERR_END:<jobId>"
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
        maxOutputBytes
      })
    } catch (err) {
      // SSH threw — record lastPollError for each job but do NOT flip status (design.md §8 boundary 2).
      const errorCode = err instanceof ComputeConnectionError ? err.code : 'host_unreachable'
      await this._recordPollError(batched, errorCode)
      return
    }

    const connectionFailure = classifyConnectionFailure(runResult, false)
    if (connectionFailure) {
      // Host unreachable — record error per job but do NOT flip status (design.md §8 boundary 2).
      await this._recordPollError(batched, connectionFailure.code)
      return
    }

    // Parse the batched output using nonce-prefixed markers. Pass target for poller fallback kill.
    // A truncated result should be impossible now that the cap is sized to the batch, but if it ever
    // happens the head is kept, so leading jobs still parse; any job whose section was dropped simply
    // stays non-terminal and is re-polled next tick (its remote exit_code file persists).
    await this._parsePollOutput(runResult.stdout, batched, nonce, connection)
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
  private async _recordPollError(jobs: ComputeJob[], message: string): Promise<void> {
    for (const job of jobs) {
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
    connection: ComputeConnectionLease
  ): Promise<void> {
    const parsedResults = parsePollOutput(output, jobs, nonce)

    const safeTails = await redactConnectionOutputs(
      connection,
      parsedResults.flatMap(({ stdoutTail, stderrTail }) => [stdoutTail, stderrTail])
    )
    for (const [index, result] of parsedResults.entries()) {
      await this._applyPollResult(
        result.job,
        {
          alive: result.alive,
          exitCode: result.exitCode,
          hasExitCode: result.hasExitCode,
          stdoutTail: safeTails[index * 2] ?? '',
          stderrTail: safeTails[index * 2 + 1] ?? ''
        },
        connection
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
    connection: ComputeConnectionLease
  ): Promise<void> {
    const previous = this.pollResultChains.get(job.job_id) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this._applyPollResultExclusive(job, result, connection))
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
    connection: ComputeConnectionLease
  ): Promise<void> {
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
      this._dispatchHarvest(transition.job)
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
        if (transition.kind === 'applied') this._dispatchHarvest(transition.job)
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
                maxOutputBytes: 64
              }
            )
          } catch {
            // Ignore kill errors — the job is marked terminal regardless.
          }
        }
        const transition = await this.lifecycle.finishPolled(job.job_id, {
          status: 'timeout',
          errorCode: 'timeout',
          stdoutTail: stdoutTail || null,
          stderrTail: stderrTail || null
        })
        if (transition.kind === 'ignored') return
        // Poller-fallback timeout is a terminal state — dispatch harvest (design §3).
        this._dispatchHarvest(transition.job)
        return
      }
    }

    if (job.status !== 'submitted' && job.status !== 'running') return
    // Transition a submitted-with-handle recovery to running, or refresh an existing running row.
    // A successful poll also clears any stale connectivity projection.
    await this.lifecycle.observeRunning(job.job_id, job.status, {
      stdoutTail: stdoutTail || null,
      stderrTail: stderrTail || null
    })
  }
}
