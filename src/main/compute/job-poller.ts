import { randomBytes } from 'node:crypto'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'
import { quoteRemotePath, type RemoteHandle } from './job-dispatcher'

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
}

// Per-job vanish counter (lives here because the poller is the only thing that increments it).
type VanishState = { ticks: number }

// JobPoller runs in the main process, independent of any kernel lifetime. It polls all non-terminal
// jobs every 15 s, batching by provider to minimise SSH connections. App restart resumes from DB.
export class JobPoller {
  private handle: ReturnType<typeof setInterval> | undefined
  private readonly vanishCounters = new Map<string, VanishState>()

  // Injectable timers (tests override to control ticks synchronously).
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void
  // Injectable nonce generator (tests override for deterministic marker matching).
  private readonly makeNonceFn: () => string

  constructor(private readonly deps: JobPollerDeps) {
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIntervalFn = deps.clearInterval ?? ((h) => clearInterval(h))
    this.makeNonceFn = deps.makeNonce ?? (() => randomBytes(12).toString('hex') + '_')
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
  async tick(): Promise<void> {
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

  // Polls all jobs for one provider in a single SSH round-trip (where possible).
  private async _pollProvider(providerId: string, jobs: ComputeJob[]): Promise<void> {
    // Handle jobs stuck in 'submitted' with no pid (app restart interrupted dispatch).
    // Per design.md §8: mark them error/dispatch_failed immediately.
    const noHandle: ComputeJob[] = []
    const withHandle: ComputeJob[] = []
    for (const job of jobs) {
      if (job.status === 'submitted' && !job.remote_handle) {
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
        return
      }
    }

    if (job.status !== 'running') {
      // Transition to running if still in submitted (shouldn't happen but guard).
      const updated = await this.deps.jobRepository.update(job.job_id, {
        status: 'running',
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null
      })
      this.deps.onJobUpdated?.(updated)
    } else {
      // Just update tails.
      const updated = await this.deps.jobRepository.update(job.job_id, {
        stdoutTail: stdoutTail || null,
        stderrTail: stderrTail || null
      })
      this.deps.onJobUpdated?.(updated)
    }
  }
}
