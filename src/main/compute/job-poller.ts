import { randomBytes } from 'node:crypto'

import type { ComputeJob, JobSummary } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'
import { quoteRemotePath, type RemoteHandle } from './job-dispatcher'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { emitJobNotification } from './job-notifier'

// Polling interval: 15 seconds (design.md §8).
export const POLL_INTERVAL_MS = 15_000

// Maximum bytes to capture per stream tail (64 KiB per design.md §8).
const TAIL_MAX_BYTES = 65536

// Consecutive ticks without exit_code before declaring process_vanished (design.md §8 §3).
const PROCESS_VANISHED_TICKS = 2

// Timeout for the per-host poll SSH command.
const POLL_TIMEOUT_MS = 30_000

// Maximum output per poll (pid lines + exit codes + tails; bounded by TAIL_MAX_BYTES × 2 + overhead).
const POLL_MAX_OUTPUT_BYTES = TAIL_MAX_BYTES * 2 + 4 * 1024

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
  runner: SshRunner
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
  private readonly vanishCounters = new Map<string, VanishState>()

  // Injectable timers (tests override to control ticks synchronously).
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void
  // Injectable nonce generator (tests override for deterministic marker matching).
  private readonly makeNonceFn: () => string
  // Shared dispatch tracker (see JobPollerDeps.dispatchTracker).
  private readonly dispatchTracker: DispatchTracker
  // Optional injectable harvest function (design §3).
  private readonly harvestFn: HarvestFn | undefined

  // Harvest concurrency state (design §3):
  //   inFlightHarvests: jobIds whose harvest is currently running — prevents duplicate dispatches
  //   harvestSemaphore: count of available harvest slots (starts at HARVEST_CONCURRENCY_LIMIT)
  //   harvestQueue: jobs waiting for a semaphore slot
  private readonly inFlightHarvests = new Set<string>()
  private harvestSemaphore = HARVEST_CONCURRENCY_LIMIT
  private readonly harvestQueue: ComputeJob[] = []

  constructor(private readonly deps: JobPollerDeps) {
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h))
    this.makeNonceFn = deps.makeNonce ?? (() => randomBytes(12).toString('hex') + '_')
    this.dispatchTracker = deps.dispatchTracker ?? sharedDispatchTracker
    this.harvestFn = deps.harvestFn
  }

  // Starts the poller. Polls once immediately (picks up jobs that were running before restart),
  // then on every interval.
  start(): void {
    if (this.handle) return // already running

    void this.tick() // first tick immediately (restart recovery)
    this.handle = this.setIntervalFn(() => void this.tick(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.handle) {
      this.clearIntervalFn(this.handle)
      this.handle = undefined
    }
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
    void this.harvestFn(job)
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
      const updated = await this.deps.jobRepository.update(job.job_id, {
        status: 'error',
        errorCode: 'dispatch_failed',
        stderrTail: 'dispatch interrupted by restart',
        finishedAt: new Date()
      })
      this.deps.onJobUpdated?.(updated)
      // Emit compute_done notification for execution-error jobs (design §8: error is a final
      // resting state). Fire-and-forget: notification failure must not break the poller tick.
      if (this.deps.broadcast && this.deps.storageRoot) {
        void emitJobNotification(updated, {
          jobRepository: this.deps.jobRepository,
          storageRoot: this.deps.storageRoot,
          broadcast: this.deps.broadcast
        }).catch(() => {
          // Non-fatal: job status is already persisted.
        })
      }
    }

    if (withHandle.length === 0) return

    const host = await this.deps.hostRepository.get(providerId)
    if (!host) return // host deleted

    let target
    try {
      target = await resolveSshTarget(host.sshAlias, host.sshOverrides)
    } catch {
      // Can't reach host — do not flip job status (design.md §8 boundary 2).
      return
    }

    // Per-tick random nonce prefixed onto every structural marker. Job stdout/stderr tails are
    // interleaved into the same stream, so bare markers (JOB_START:/alive:/STDOUT_END:/...) printed
    // by the job could otherwise hijack section splitting or field parsing. An unpredictable nonce
    // the job cannot know makes such collisions effectively impossible.
    const nonce = this.makeNonceFn()

    // Build per-job check commands, batched into one SSH round-trip.
    // Format per job (each marker carries the nonce prefix):
    //   echo "<nonce>JOB_START:<jobId>"
    //   kill -0 <pid> 2>/dev/null && echo "<nonce>alive:1" || echo "<nonce>alive:0"
    //   test -f <exit_code_path> && cat <exit_code_path> || echo ""
    //   tail -c 65536 <stdout_path> 2>/dev/null || true
    //   echo "<nonce>STDOUT_END:<jobId>"
    //   tail -c 65536 <stderr_path> 2>/dev/null || true
    //   echo "<nonce>STDERR_END:<jobId>"
    const parts: string[] = []
    for (const job of withHandle) {
      const handle = this._parseHandle(job.remote_handle)
      if (!handle) continue

      parts.push(
        `echo "${nonce}JOB_START:${job.job_id}"`,
        `kill -0 ${handle.pid} 2>/dev/null && echo "${nonce}alive:1" || echo "${nonce}alive:0"`,
        `if [ -f ${quoteRemotePath(handle.exit_code_path)} ]; then cat ${quoteRemotePath(handle.exit_code_path)}; else echo ""; fi`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(handle.stdout_path)} 2>/dev/null || true`,
        `echo "${nonce}STDOUT_END:${job.job_id}"`,
        `tail -c ${TAIL_MAX_BYTES} ${quoteRemotePath(handle.stderr_path)} 2>/dev/null || true`,
        `echo "${nonce}STDERR_END:${job.job_id}"`
      )
    }

    if (parts.length === 0) return

    const pollCmd = parts.join('\n')
    let runResult
    try {
      runResult = await this.deps.runner.run(target, pollCmd, {
        timeoutMs: POLL_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: POLL_MAX_OUTPUT_BYTES
      })
    } catch (err) {
      // SSH threw — record lastPollError for each job but do NOT flip status (design.md §8 boundary 2).
      const msg = err instanceof Error ? err.message : String(err)
      await this._recordPollError(withHandle, msg)
      return
    }

    if (runResult.timedOut || runResult.exitCode === 255) {
      // Host unreachable — record error per job but do NOT flip status (design.md §8 boundary 2).
      const msg =
        runResult.stderr || (runResult.timedOut ? 'SSH connection timed out' : 'SSH exit 255')
      await this._recordPollError(withHandle, msg)
      return
    }

    // Parse the batched output using nonce-prefixed markers. Pass target for poller fallback kill.
    const output = runResult.stdout
    await this._parsePollOutput(output, withHandle, nonce, target)
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
      const updated = await this.deps.jobRepository.update(job.job_id, {
        lastPollError: message,
        retryAfterUserAction: true
      })
      this.deps.onJobUpdated?.(updated)
    }
  }

  // Parses the batched poll output and updates each job accordingly. All structural markers carry
  // the per-tick `nonce` prefix so adversarial job tail content cannot collide with them.
  // `target` is threaded through so _applyPollResult can issue the poller-fallback kill command.
  private async _parsePollOutput(
    output: string,
    jobs: ComputeJob[],
    nonce: string,
    target: import('./ssh-runner').ResolvedSshTarget
  ): Promise<void> {
    // Split output into per-job sections by the nonce-prefixed JOB_START marker.
    const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const sections = output.split(new RegExp(`^${escapedNonce}JOB_START:`, 'm'))

    for (const section of sections) {
      if (!section.trim()) continue
      const firstNewline = section.indexOf('\n')
      if (firstNewline === -1) continue
      const jobId = section.slice(0, firstNewline).trim()
      const body = section.slice(firstNewline + 1)

      const job = jobs.find((j) => j.job_id === jobId)
      if (!job) continue

      // Extract alive line (nonce-prefixed).
      const aliveMatch = body.match(new RegExp(`^${escapedNonce}alive:([01])`, 'm'))
      const alive = aliveMatch?.[1] === '1'

      // Extract exit code (line after the nonce-prefixed alive line).
      const alivePrefix = `${nonce}alive:`
      const lines = body.split('\n')
      let exitCodeRaw = ''
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.startsWith(alivePrefix)) {
          exitCodeRaw = lines[i + 1]?.trim() ?? ''
          break
        }
      }
      const exitCode = exitCodeRaw.trim() === '' ? null : Number.parseInt(exitCodeRaw.trim(), 10)
      const hasExitCode = exitCode !== null && Number.isFinite(exitCode)

      // Extract stdout tail (between the third line after JOB_START and STDOUT_END marker).
      const stdoutEndMarker = `${nonce}STDOUT_END:${jobId}`
      const stderrEndMarker = `${nonce}STDERR_END:${jobId}`
      const stdoutStart = body.indexOf('\n', body.indexOf('\n', body.indexOf('\n') + 1) + 1) + 1
      const stdoutEnd = body.indexOf(stdoutEndMarker)
      const stdoutTail =
        stdoutEnd > stdoutStart ? body.slice(stdoutStart, stdoutEnd).replace(/\n$/, '') : ''

      const stderrStart = body.indexOf('\n', stdoutEnd + stdoutEndMarker.length) + 1
      const stderrEnd = body.indexOf(stderrEndMarker)
      const stderrTail =
        stderrEnd > stderrStart ? body.slice(stderrStart, stderrEnd).replace(/\n$/, '') : ''

      await this._applyPollResult(
        job,
        { alive, exitCode, hasExitCode, stdoutTail, stderrTail },
        target
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
    target: import('./ssh-runner').ResolvedSshTarget
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

      const updated = await this.deps.jobRepository.update(job.job_id, {
        status,
        exitCode,
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null,
        errorCode: errorCode ?? null,
        finishedAt: new Date()
      })
      this.deps.onJobUpdated?.(updated)
      // Async-dispatch harvest for success/failed/timeout (design §3). Not awaited — must not
      // block the tick loop. 'error' status is never reached here (only in the noHandle path).
      this._dispatchHarvest(updated)
      return
    }

    // Process gone but no exit_code file — potential process_vanished.
    if (!alive && !hasExitCode) {
      const state = this.vanishCounters.get(job.job_id) ?? { ticks: 0 }
      state.ticks++
      this.vanishCounters.set(job.job_id, state)

      if (state.ticks >= PROCESS_VANISHED_TICKS) {
        this.vanishCounters.delete(job.job_id)
        const updated = await this.deps.jobRepository.update(job.job_id, {
          status: 'failed',
          errorCode: 'process_vanished',
          stdoutTail: stdoutTail || null,
          stderrTail: stderrTail || null,
          finishedAt: new Date()
        })
        this.deps.onJobUpdated?.(updated)
        // process_vanished is a terminal state — dispatch harvest (design §3).
        this._dispatchHarvest(updated)
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
        const handle = this._parseHandle(job.remote_handle)
        if (handle) {
          // Best-effort kill; ignore errors (process may have already exited).
          try {
            await this.deps.runner.run(
              target,
              `kill ${handle.pid} 2>/dev/null; kill -9 ${handle.pid} 2>/dev/null; true`,
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
        const updated = await this.deps.jobRepository.update(job.job_id, {
          status: 'timeout',
          errorCode: 'timeout',
          stdoutTail: stdoutTail || null,
          stderrTail: stderrTail || null,
          finishedAt: new Date()
        })
        this.deps.onJobUpdated?.(updated)
        // Poller-fallback timeout is a terminal state — dispatch harvest (design §3).
        this._dispatchHarvest(updated)
        return
      }
    }

    if (job.status !== 'running') {
      // Transition to running if still in submitted (shouldn't happen but guard).
      // Clear any stale lastPollError: a successful poll proves connectivity is healthy again
      // (schema.prisma: "Cleared on the next successful poll").
      const updated = await this.deps.jobRepository.update(job.job_id, {
        status: 'running',
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null,
        lastPollError: null
      })
      this.deps.onJobUpdated?.(updated)
    } else {
      // Just update tails. Also clear any stale lastPollError now that this poll succeeded, so a
      // transient SSH blip's error banner does not stick to a healthy running job forever.
      const updated = await this.deps.jobRepository.update(job.job_id, {
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null,
        lastPollError: null
      })
      this.deps.onJobUpdated?.(updated)
    }
  }
}
