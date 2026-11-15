import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  stageHuggingFaceInputs,
  cleanupHuggingFaceBucketFiles,
  submitHuggingFaceJob,
  HuggingFaceJobCreationRejectedError,
  recoverApprovedHuggingFaceJob,
  inspectHuggingFaceJob,
  cancelHuggingFaceJob,
  readHuggingFaceJobLogs
} from '@aipoch/compute/node'
import type { ComputeJob } from '../../shared/compute'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import { decodeDataPath } from '../storage/data-path'
import { getHuggingFaceJobAccess, resolveHuggingFaceJobIdentity } from './hugging-face-job-access'
import type { ComputeJobRepository, UpdateJobRequest } from './job-repository'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { readHostedJournal, type HostedJobJournal } from './hugging-face-job-journal'
import { createComputeRuntimeLoop, type ComputeRuntimePassResult } from './compute-runtime-loop'
import {
  nextComputeRuntimeBackoff,
  nextComputeRuntimeWakeAfter,
  type ComputeRuntimeBackoffState
} from './compute-runtime-backoff'

const log = createLogger('compute:hosted')
const inputs = z.array(
  z.object({
    kind: z.literal('upload'),
    dstFilename: z.string(),
    localPath: z.string().startsWith('$DATA/'),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/)
  })
)
function frozenInputReceipts(
  job: ComputeJob
): Array<{ path: string; bytes: number; sha256: string }> {
  return inputs.parse(JSON.parse(job.input_manifest ?? '[]')).map((file) => ({
    path: file.dstFilename,
    bytes: file.sizeBytes,
    sha256: file.checksum
  }))
}
type Dependencies = {
  jobRepository: ComputeJobRepository
  operationRepository?: ComputeJobOperationRepository
  onJobUpdated: (job: ComputeJob) => Promise<void> | void
  storageRoot: string
  harvest: (
    job: ComputeJob,
    bucket: { bucket: string; runId: string; token: string },
    signal: AbortSignal
  ) => Promise<void>
}
async function access(
  job: ComputeJob,
  journal: HostedJobJournal,
  signal: AbortSignal
): Promise<{ namespace: string; runId: string; token: string; signal: AbortSignal }> {
  const { namespace, account } = journal.target
  const identity = await resolveHuggingFaceJobIdentity(namespace, signal)
  if (identity.account !== account) throw new Error('HF account changed after approval.')
  return { namespace, runId: job.job_id, token: identity.token, signal }
}
const approvalChangedMessage =
  'HF account or price changed after approval; cancel this submission and approve a new one.'
class ApprovalChangedError extends Error {}
async function approvedAccess(
  job: ComputeJob,
  journal: HostedJobJournal,
  signal: AbortSignal
): Promise<Awaited<ReturnType<typeof access>>> {
  const current = await getHuggingFaceJobAccess(journal.target, signal)
  if (
    current.account !== journal.target.account ||
    current.rateMicroUsdPerMinute > journal.target.rateMicroUsdPerMinute
  )
    throw new ApprovalChangedError(approvalChangedMessage)
  return { namespace: journal.target.namespace, runId: job.job_id, token: current.token, signal }
}
function spec(
  job: ComputeJob,
  journal: HostedJobJournal,
  connection: Awaited<ReturnType<typeof access>>
): Parameters<typeof submitHuggingFaceJob>[0] {
  if (!journal.launch || !job.timeout_seconds)
    throw new Error('Missing approved HF job specification.')
  return {
    ...connection,
    image: journal.target.image,
    flavor: journal.target.flavor,
    timeoutSeconds: job.timeout_seconds,
    command: ['bash', '-c', 'cd /outputs || exit 1\n' + job.command],
    inputs: journal.launch.inputs,
    outputs: journal.launch.outputs
  }
}
function terminal(
  observed: Awaited<ReturnType<typeof inspectHuggingFaceJob>>
): UpdateJobRequest | undefined {
  if (observed.phase === 'succeeded')
    return { status: 'success', exitCode: 0, finishedAt: new Date() }
  if (observed.phase === 'cancelled')
    return { status: 'failed', errorCode: 'job_cancelled', finishedAt: new Date() }
  if (observed.phase === 'failed') {
    const timeout = /^Job timeout\b/i.test(observed.message ?? '')
    return {
      status: timeout ? 'timeout' : 'failed',
      errorCode: timeout ? 'timeout' : 'job_failed',
      exitCode: observed.exitCode,
      finishedAt: new Date()
    }
  }
  return undefined
}
async function logs(
  request: Parameters<typeof readHuggingFaceJobLogs>[0]
): Promise<string | undefined> {
  let tail = ''
  try {
    const deadline = AbortSignal.timeout(3000)
    for await (const line of readHuggingFaceJobLogs({
      ...request,
      signal: request.signal ? AbortSignal.any([request.signal, deadline]) : deadline
    })) {
      tail = (tail + line + '\n').slice(-8192)
    }
  } catch {
    request.signal?.throwIfAborted()
  }
  return tail || undefined
}
export function createHuggingFaceJobRuntime(deps: Dependencies): {
  start(): void
  wake(): Promise<void>
  resume(): void
  pause(): Promise<void>
  stop(): Promise<void>
  tick(): Promise<void>
  retry(jobId: string): Promise<void>
  manualCleanup(job: ComputeJob): Promise<void>
} {
  const repo = deps.jobRepository
  const cancel = deps.operationRepository
  const publish = async (jobId: string): Promise<void> => {
    const job = await repo.get(jobId)
    if (job) await deps.onJobUpdated(job)
  }
  const reconcile = async (job: ComputeJob, signal: AbortSignal): Promise<void> => {
    if (job.last_poll_error === approvalChangedMessage && job.status === 'submitted') return
    const journal = readHostedJournal(job)
    if (job.harvested_at && !repo.canCleanJournalResources(job, journal)) return
    const connection =
      !journal.launch && (job.status === 'submitted' || job.status === 'running')
        ? await approvedAccess(job, journal, signal)
        : await access(job, journal, signal)
    const bucket = { bucket: journal.target.bucket, runId: job.job_id, token: connection.token }
    if (job.status === 'submitted' || job.status === 'running') {
      if (!journal.launch) {
        if (!journal.staging) {
          await repo.replaceHostedJournal(job, JSON.stringify({ ...journal, staging: true }), true)
          return
        }
        const files = inputs.parse(JSON.parse(job.input_manifest ?? '[]')).map((entry) => ({
          path: entry.dstFilename,
          localPath: decodeDataPath(entry.localPath, deps.storageRoot)!,
          bytes: entry.sizeBytes,
          sha256: entry.checksum
        }))
        const mounts = await stageHuggingFaceInputs({
          ...bucket,
          signal,
          files,
          maxBytes: LOCAL_RESOURCE_BUDGETS.artifactTurnBytes
        })
        const next = { ...journal, launch: { inputs: mounts.inputs, outputs: mounts.outputs } }
        const verified = await approvedAccess(job, journal, signal)
        const serialized = JSON.stringify(next)
        if (!(await repo.replaceHostedJournal(job, serialized, true))) return
        const fencedJob = { ...job, remote_handle: serialized }
        let id: string
        try {
          id = await submitHuggingFaceJob(spec(job, next, verified))
        } catch (error) {
          if (!(error instanceof HuggingFaceJobCreationRejectedError)) throw error
          if (await repo.rejectHostedSubmission(fencedJob, error.status)) await publish(job.job_id)
          return
        }
        await repo.replaceHostedJournal(
          fencedJob,
          JSON.stringify({ ...next, launch: { ...next.launch, remoteId: id } }),
          false
        )
        return
      }
      if (!journal.launch.remoteId) {
        const id = await recoverApprovedHuggingFaceJob(spec(job, journal, connection))
        if (!id) throw new Error('Unresolved HF submission.')
        await repo.replaceHostedJournal(
          job,
          JSON.stringify({ ...journal, launch: { ...journal.launch, remoteId: id } }),
          false
        )
        return
      }
      const request = { ...connection, jobId: journal.launch.remoteId }
      const observed = await inspectHuggingFaceJob(request)
      if (observed.phase === 'unreconciled') throw new Error('Unresolved HF job state.')
      const settled = terminal(observed)
      if (!settled && observed.phase !== 'running') return
      const tail = await logs(request)
      if (
        !settled &&
        job.status === 'running' &&
        !job.last_poll_error &&
        (!tail || job.stdout_tail === tail)
      )
        return
      const updated = await repo.updateIfStatus(job.job_id, [job.status], {
        ...(settled ?? { status: 'running', startedAt: job.started_at ? undefined : new Date() }),
        lastPollError: null,
        ...(tail && { stdoutTail: tail })
      })
      if (updated) await deps.onJobUpdated(updated)
      return
    }
    if (!job.harvested_at) {
      await deps.harvest(job, bucket, signal)
      return
    }
    await cleanupHuggingFaceBucketFiles({
      ...bucket,
      signal,
      expectedOutputs: journal.published ?? [],
      expectedInputs: journal.launch ? undefined : frozenInputReceipts(job),
      discardedOutputs: journal.discardedOutputs
    })
    await deps.onJobUpdated(await repo.confirmHostedCleanup(job))
  }
  const cancelOne = async (signal: AbortSignal): Promise<boolean> => {
    if (!cancel) return false
    const claim = await cancel.claimNext(
      'cancel',
      new Date(),
      120000,
      randomUUID(),
      'hugging_face_jobs'
    )
    if (!claim) return false
    const retry = (): Promise<boolean> =>
      cancel.retry(claim, new Date(), new Date(Date.now() + 5000))
    try {
      const job = await repo.get(claim.jobId)
      if (!job) throw new Error('Missing job.')
      const journal = readHostedJournal(job)
      if (journal.launch) {
        const connection = await access(job, journal, signal)
        const id =
          journal.launch.remoteId ??
          (await recoverApprovedHuggingFaceJob(spec(job, journal, connection)))
        if (!id) throw new Error('Unresolved HF submission.')
        const request = { ...connection, jobId: id }
        const observed = await inspectHuggingFaceJob(request)
        if (observed.phase !== 'cancelled') {
          const completed = terminal(observed)
          if (completed) {
            await cancel.settle(claim, new Date(), { outcome: 'superseded', job: completed })
            await publish(job.job_id)
            return true
          }
          if (observed.phase !== 'unreconciled') await cancelHuggingFaceJob(request)
          await retry()
          return true
        }
      }
      if (
        await cancel.fulfill(
          claim,
          new Date(),
          !journal.staging,
          Boolean(journal.staging && !journal.launch)
        )
      )
        await publish(job.job_id)
    } catch {
      await retry()
      return true
    }
    return true
  }
  const failures = new Map<string, ComputeRuntimeBackoffState>()
  const keepsActiveCadence = (job: ComputeJob): boolean =>
    job.status === 'submitted' || job.status === 'running' || !job.harvested_at
  const pass = async (signal: AbortSignal): Promise<ComputeRuntimePassResult> => {
    const cancelled = await cancelOne(signal)
    const jobs = await repo.findHostedWork()
    const ids = new Set(jobs.map((job) => job.job_id))
    for (const id of failures.keys()) if (!ids.has(id)) failures.delete(id)
    let ready = false
    for (const job of jobs) {
      signal.throwIfAborted()
      const previous = failures.get(job.job_id)
      if (previous && previous.retryAt > Date.now()) continue
      try {
        await reconcile(job, signal)
        failures.delete(job.job_id)
        ready ||= keepsActiveCadence(job)
      } catch (error) {
        signal.throwIfAborted()
        failures.set(job.job_id, nextComputeRuntimeBackoff(previous, Date.now()))
        const message =
          error instanceof ApprovalChangedError
            ? error.message
            : 'HF job recovery is pending. Check the approved account and remote job before resubmitting.'
        if (job.last_poll_error !== message) {
          const updated = await repo.updateIfStatus(job.job_id, [job.status], {
            lastPollError: message
          })
          if (updated) await deps.onJobUpdated(updated)
        }
      }
    }
    const nextWakeAfterMs = nextComputeRuntimeWakeAfter(failures.values(), Date.now())
    return {
      hasWork: cancelled || ready,
      ...(nextWakeAfterMs === undefined ? {} : { nextWakeAfterMs })
    }
  }
  const loop = createComputeRuntimeLoop({
    run: pass,
    activeIntervalMs: 5000,
    onError: () => log.warn('Hosted job reconciliation deferred.')
  })
  return {
    ...loop,
    retry: async (jobId: string) => {
      await loop.wake(() => failures.delete(jobId))
    },
    manualCleanup: async (job) => {
      const signal = loop.signal
      if (!signal) throw new Error('Compute recovery is paused.')
      if (!repo.getManualStagedCleanup(job)) throw new Error('Cannot verify staged resources.')
      const journal = readHostedJournal(job)
      const connection = await access(job, journal, signal)
      await cleanupHuggingFaceBucketFiles({
        bucket: journal.target.bucket,
        runId: job.job_id,
        token: connection.token,
        signal,
        expectedOutputs: [],
        expectedInputs: frozenInputReceipts(job)
      })
      await deps.onJobUpdated(await repo.confirmManualStagedCleanup(job))
    }
  }
}
