import { getRayToken } from './ray-token'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  RayJobCreationNotSentError,
  RayJobCreationRejectedError,
  inspectRayJob,
  submitRayJob,
  prepareRayJobInputs,
  uploadRayWorkingDirectory,
  readRayJobLogs,
  stopRayJob,
  shellSingleQuote,
  type RayJobsTarget,
  type RayJobClaim,
  type RayJobObservation
} from '@aipoch/compute/node'
import { z } from 'zod'
import type { ComputeJob } from '../../shared/compute'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import { decodeDataPath } from '../storage/data-path'
import type { ComputeJobRepository, UpdateJobRequest } from './job-repository'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { readRayJournal, type RayJobJournal } from './ray-job-journal'
import {
  inspectRayDashboard,
  reserveRayOutputDirectory,
  readRayTimeoutMarker
} from './ray-shared-outputs'

const log = createLogger('compute:ray')
const inputs = z.array(
  z.object({
    kind: z.literal('upload'),
    localPath: z.string().startsWith('$DATA/'),
    dstFilename: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/)
  })
)

// Ray's submission timeout bounds the API call, not the driver. Enforce the approved runtime
// even when the host disconnects, and check the published mount before exposing it to the command.
const driver = `import os, signal, subprocess, sys
from pathlib import Path
output, nonce, seconds, command = sys.argv[1:]
marker = Path(output) / ".open-science-owner"
if marker.is_symlink() or marker.read_text(encoding="utf-8") != nonce:
    sys.exit("Ray output mount does not match the approved reservation")
os.environ["RAY_JOB_OUTPUT_DIR"] = output
# The entrypoint execs this interpreter in the session Ray created for the driver.
# The command and its ordinary descendants must remain in Ray's stop/kill group.
if os.getpid() != os.getpgrp() or os.getpid() != os.getsid(0):
    sys.exit("Ray driver does not own its process group")
process = subprocess.Popen(["/bin/sh", "-c", command])
try:
    code = process.wait(timeout=int(seconds))
except subprocess.TimeoutExpired:
    try:
        with (Path(output) / ".open-science-timeout").open("x", encoding="ascii") as receipt:
            receipt.write(nonce)
            receipt.flush()
            os.fsync(receipt.fileno())
    except OSError:
        pass
    print("Ray driver timed out: " + nonce, file=sys.stderr, flush=True)
    os.killpg(os.getpgrp(), signal.SIGKILL)
sys.exit(code if code >= 0 else 128 - code)`
function claimFor(job: ComputeJob, journal: RayJobJournal): RayJobClaim {
  if (!journal.packageSha256 || !job.timeout_seconds)
    throw new Error('Missing approved Ray package or timeout.')
  const output = posix.join(journal.target.remoteRoot, job.job_id)
  return {
    submissionId: job.job_id,
    workingDir: 'gcs://_ray_pkg_' + journal.packageSha256 + '.zip',
    entrypoint:
      'exec python3 -c ' +
      [driver, output, journal.nonce, String(job.timeout_seconds), job.command]
        .map(shellSingleQuote)
        .join(' '),
    metadata: { open_science_job: job.job_id, open_science_reservation: journal.nonce },
    cpus: journal.target.cpus,
    gpus: journal.target.gpus
  }
}

type Dependencies = {
  jobRepository: ComputeJobRepository
  operationRepository?: ComputeJobOperationRepository
  storageRoot: string
  onJobUpdated(job: ComputeJob): Promise<void> | void
  harvest(
    job: ComputeJob,
    scope: { sharedRoot: string; runId: string; dev: string; ino: string },
    signal: AbortSignal
  ): Promise<void>
}
async function verifyDashboard(
  target: RayJobsTarget & { sessionName: string },
  signal: AbortSignal
): Promise<void> {
  const version = await inspectRayDashboard(target, signal)
  if (version.sessionName !== target.sessionName)
    throw new Error('Ray cluster identity changed after approval.')
}
function terminal(observed: RayJobObservation, timedOut: boolean): UpdateJobRequest | undefined {
  if (observed.status === 'SUCCEEDED')
    return { status: 'success', exitCode: observed.exitCode ?? 0, finishedAt: new Date() }
  if (observed.status === 'STOPPED' || observed.status === 'FAILED')
    return {
      status: timedOut ? 'timeout' : 'failed',
      errorCode: timedOut
        ? 'timeout'
        : observed.status === 'STOPPED'
          ? 'job_cancelled'
          : 'job_failed',
      exitCode: observed.exitCode,
      finishedAt: new Date()
    }
  return undefined
}
export function createRayJobRuntime(deps: Dependencies): {
  start(): void
  resume(): void
  pause(): Promise<void>
  stop(): Promise<void>
  tick(): Promise<void>
  retry(jobId: string): Promise<void>
} {
  const repo = deps.jobRepository
  let controller: AbortController | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let active: Promise<void> | undefined
  let stopped = false
  const expired = (job: ComputeJob): boolean =>
    job.submitted_at != null &&
    job.timeout_seconds != null &&
    Date.now() >= job.submitted_at + job.timeout_seconds * 1000
  const reconcile = async (job: ComputeJob, signal: AbortSignal): Promise<void> => {
    const journal = readRayJournal(job)
    if (job.harvested_at || journal.published) return
    const target = { ...journal.target, getToken: getRayToken }
    if (job.status !== 'submitted' && job.status !== 'running') {
      if (journal.directory)
        await deps.harvest(
          job,
          { sharedRoot: target.sharedRoot, runId: job.job_id, ...journal.directory },
          signal
        )
      return
    }
    if (!journal.launch && expired(job)) {
      const updated = await repo.updateIfStatus(job.job_id, ['submitted'], {
        status: 'timeout',
        errorCode: 'timeout',
        finishedAt: new Date(),
        harvestedAt: new Date(),
        harvestError: 'Ray job deadline elapsed before launch.'
      })
      if (updated) await deps.onJobUpdated(updated)
      return
    }
    await verifyDashboard(target, signal)
    if (!journal.launch) {
      const scope = { sharedRoot: target.sharedRoot, runId: job.job_id }
      const directory = await reserveRayOutputDirectory(scope, journal.nonce, signal)
      if (!journal.directory) {
        await repo.replaceRayJournal(job, JSON.stringify({ ...journal, directory }), true)
        return
      }
      if (directory.dev !== journal.directory.dev || directory.ino !== journal.directory.ino)
        throw new Error('Ray output directory was replaced.')
      const files = inputs.parse(JSON.parse(job.input_manifest ?? '[]')).map((input) => ({
        ...input,
        localPath: decodeDataPath(input.localPath, deps.storageRoot)!
      }))
      const pkg = await prepareRayJobInputs(files, LOCAL_RESOURCE_BUDGETS.artifactTurnBytes, signal)
      if (!journal.packageSha256) {
        await repo.replaceRayJournal(
          job,
          JSON.stringify({ ...journal, packageSha256: pkg.sha256 }),
          true
        )
        return
      }
      if (journal.packageSha256 !== pkg.sha256)
        throw new Error('Ray package differs from the approved snapshot.')
      await uploadRayWorkingDirectory({ ...target, signal }, pkg)
      await verifyDashboard(target, signal)
      if (expired(job)) return
      const claim = claimFor(job, journal)
      const fenced = JSON.stringify({ ...journal, launch: true })
      if (!(await repo.replaceRayJournal(job, fenced, true))) return
      try {
        await submitRayJob(target, claim, signal)
      } catch (error) {
        const fencedJob = { ...job, remote_handle: fenced }
        if (error instanceof RayJobCreationNotSentError) {
          // No remote job can exist from this POST. Let a pending cancellation see that too.
          await repo.replaceRayJournal(fencedJob, JSON.stringify(journal), false)
          throw error
        }
        if (!(error instanceof RayJobCreationRejectedError)) throw error
        if (await repo.rejectRayCreation(fencedJob, error.status)) {
          const updated = await repo.get(job.job_id)
          if (updated) await deps.onJobUpdated(updated)
        }
      }
      return
    }
    const claim = claimFor(job, journal)
    let observed = await inspectRayJob(target, claim, signal)
    if (observed.status === 'PENDING' || observed.status === 'RUNNING') {
      if (journal.timedOut || expired(job)) {
        if (!journal.timedOut) {
          await repo.replaceRayJournal(job, JSON.stringify({ ...journal, timedOut: true }), true)
          return
        }
        observed = await stopRayJob(target, claim, signal)
      } else if (observed.status === 'PENDING') return
    }
    const tail = await readRayJobLogs(target, claim, 256 * 1024, signal)
      .then((v) => v.slice(-8192))
      .catch(() => undefined)
    signal.throwIfAborted()
    const timedOut =
      (observed.status === 'STOPPED' && journal.timedOut === true) ||
      (observed.status === 'FAILED' &&
        (observed.exitCode === -9 || observed.exitCode === 137) &&
        (tail?.includes('Ray driver timed out: ' + journal.nonce) ||
          (await readRayTimeoutMarker(
            { sharedRoot: target.sharedRoot, runId: job.job_id, ...journal.directory! },
            journal.nonce
          ))))
    const settled = terminal(observed, timedOut)
    if (
      !settled &&
      (observed.status !== 'RUNNING' ||
        (job.status === 'running' && !job.last_poll_error && (!tail || tail === job.stdout_tail)))
    )
      return
    const updated = await repo.updateIfStatus(job.job_id, [job.status], {
      ...(settled ?? { status: 'running', startedAt: job.started_at ? undefined : new Date() }),
      lastPollError: null,
      ...(tail !== undefined && { stdoutTail: tail })
    })
    if (updated) await deps.onJobUpdated(updated)
  }
  const cancelOne = async (signal: AbortSignal): Promise<void> => {
    const ops = deps.operationRepository
    if (!ops) return
    const claim = await ops.claimNext('cancel', new Date(), 120000, randomUUID(), 'ray_jobs')
    if (!claim) return
    try {
      const job = await repo.get(claim.jobId)
      if (!job) throw new Error('Ray job unavailable.')
      const journal = readRayJournal(job)
      if (journal.launch) {
        const target = { ...journal.target, getToken: getRayToken }
        await verifyDashboard(target, signal)
        const result = await stopRayJob(target, claimFor(job, journal), signal)
        if (result.status !== 'STOPPED' || journal.timedOut) {
          const settled = terminal(result, result.status === 'STOPPED' && !!journal.timedOut)
          if (!settled) throw new Error('Ray stop not confirmed.')
          await ops.settle(claim, new Date(), { outcome: 'superseded', job: settled })
        } else await ops.fulfill(claim, new Date())
      } else await ops.fulfill(claim, new Date(), false, true)
      const updated = await repo.get(job.job_id)
      if (updated) await deps.onJobUpdated(updated)
    } catch {
      await ops.retry(claim, new Date(), new Date(Date.now() + 5000))
    }
  }
  const backoff = new Map<string, { delayMs: number; until: number }>()
  const pass = async (signal: AbortSignal): Promise<void> => {
    await cancelOne(signal)
    const jobs = await repo.findRayWork()
    const pending = new Set(jobs.map((job) => job.job_id))
    for (const id of backoff.keys()) if (!pending.has(id)) backoff.delete(id)
    for (const job of jobs) {
      signal.throwIfAborted()
      const previous = backoff.get(job.job_id)
      if (previous && Date.now() < previous.until) continue
      try {
        await reconcile(job, signal)
        backoff.delete(job.job_id)
      } catch {
        signal.throwIfAborted()
        const delayMs = Math.min(300_000, (previous?.delayMs ?? 2_500) * 2)
        backoff.set(job.job_id, { delayMs, until: Date.now() + delayMs })
        const message =
          'Ray job reconciliation is pending. Check the approved cluster and shared output directory before resubmitting.'
        if (job.last_poll_error !== message) {
          const updated = await repo.updateIfStatus(job.job_id, [job.status], {
            lastPollError: message
          })
          if (updated) await deps.onJobUpdated(updated)
        }
      }
    }
  }
  const tick = (): Promise<void> => {
    if (!controller) return Promise.resolve()
    return (active ??= pass(controller.signal)
      .catch(() => {
        if (controller && !controller.signal.aborted) log.warn('Ray job reconciliation deferred.')
      })
      .finally(() => {
        active = undefined
      }))
  }
  const start = (): void => {
    if (stopped || controller) return
    controller = new AbortController()
    interval = setInterval(() => void tick(), 5000)
    interval.unref()
    void tick()
  }
  const pause = async (): Promise<void> => {
    clearInterval(interval)
    controller?.abort()
    controller = undefined
    await active
  }
  return {
    start,
    resume: start,
    pause,
    tick,
    retry: async (jobId) => {
      await active
      backoff.delete(jobId)
      await tick()
    },
    stop: async () => {
      stopped = true
      await pause()
    }
  }
}
