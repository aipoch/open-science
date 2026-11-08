import { createHash, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { z } from 'zod'
import { createLogger } from '@aipoch/diagnostics/node'
import type { ComputeJob } from '../../shared/compute'
import type { ComputeJobRepository, UpdateJobRequest } from './job-repository'
import type { ComputeJobOperationRepository } from './compute-job-operation-repository'
import { decodeDataPath } from '../storage/data-path'
import { LOCAL_RESOURCE_BUDGETS } from '../resource-budget'
import {
  MODAL_CREATION_UNCONFIRMED,
  readModalJournal,
  type ModalJobJournal
} from './modal-job-journal'
import {
  resolveModalApp,
  createModalVolume,
  stageModalInputs,
  createModalSandbox,
  inspectModalSandbox,
  terminateModalSandbox,
  cleanupModalVolume,
  ModalCreateRejectedError
} from './modal-sdk'

const log = createLogger('compute:modal')
const frozen = z.array(
  z.object({
    kind: z.literal('upload'),
    localPath: z.string().startsWith('$DATA/'),
    dstFilename: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/)
  })
)
async function verifyInputs(
  files: readonly { localPath: string; path: string; bytes: number; sha256: string }[],
  signal: AbortSignal
): Promise<void> {
  let available = LOCAL_RESOURCE_BUDGETS.artifactTurnBytes as number
  for (const file of files) {
    signal.throwIfAborted()
    if (file.bytes > available) throw new Error('Modal inputs exceed the byte budget.')
    available -= file.bytes
    const handle = await open(
      file.localPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== file.bytes)
        throw new Error('Frozen Modal file changed before approval could be executed.')
      const hash = createHash('sha256')
      let received = 0
      const buffer = Buffer.allocUnsafe(64 * 1024)
      while (received < file.bytes) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, file.bytes - received),
          received
        )
        if (!bytesRead) break
        hash.update(buffer.subarray(0, bytesRead))
        received += bytesRead
      }
      if (
        received !== file.bytes ||
        (await handle.stat()).size !== file.bytes ||
        hash.digest('hex') !== file.sha256
      )
        throw new Error('Frozen Modal input checksum differs from approval.')
    } finally {
      await handle.close()
    }
  }
}
class DeadlineElapsedBeforeCreate extends Error {}
function remaining(job: ComputeJob): number {
  if (!Number.isSafeInteger(job.timeout_seconds) || !job.timeout_seconds)
    throw new Error('Missing approved Modal deadline.')
  const dispatchedAt = job.submitted_at ?? job.created_at
  return Math.floor((dispatchedAt + job.timeout_seconds * 1000 - Date.now()) / 1000)
}
type VolumeScope = {
  environmentName: string
  appName: string
  appId: string
  volumeName: string
  volumeId: string
  nonce: string
  runId: string
}
type Deps = {
  jobRepository: ComputeJobRepository
  operationRepository?: ComputeJobOperationRepository
  storageRoot: string
  onJobUpdated: (job: ComputeJob) => void | Promise<void>
  harvest: (job: ComputeJob, scope: VolumeScope, signal: AbortSignal) => Promise<void>
}
const base = (j: ModalJobJournal): Omit<VolumeScope, 'volumeId'> => ({
  appName: j.target.appName,
  environmentName: j.target.environmentName,
  appId: j.target.appId,
  runId: j.jobId,
  nonce: j.nonce,
  volumeName: 'compute-' + j.nonce
})
const uncertain = (j: ModalJobJournal): boolean =>
  !!((j.volume && !j.volume.id) || (j.sandbox && !j.sandbox.id))
type Observation = Awaited<ReturnType<typeof inspectModalSandbox>>
function settlement(state: Observation): UpdateJobRequest | undefined {
  if (state.status === 'running') return undefined
  return {
    finishedAt: new Date(),
    exitCode: state.exitCode,
    status:
      state.status === 'succeeded' ? 'success' : state.status === 'timeout' ? 'timeout' : 'failed',
    errorCode:
      state.status === 'succeeded'
        ? null
        : state.status === 'cancelled'
          ? 'job_cancelled'
          : state.status === 'timeout'
            ? 'timeout'
            : 'job_failed',
    stdoutTail: state.stdoutTail,
    stderrTail: state.stderrTail
  }
}
export function createModalJobRuntime(deps: Deps): {
  start(): void
  resume(): void
  pause(): Promise<void>
  stop(): Promise<void>
  tick(): Promise<void>
  manualCleanup(job: ComputeJob): Promise<void>
  retry(jobId: string): Promise<void>
} {
  const repo = deps.jobRepository
  const operations = deps.operationRepository
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let active: Promise<void> | undefined
  let stopped = false
  const publish = async (id: string): Promise<void> => {
    const job = await repo.get(id)
    if (job) await deps.onJobUpdated(job)
  }
  const markUncertain = async (job: ComputeJob): Promise<void> => {
    if (
      job.last_poll_error !== MODAL_CREATION_UNCONFIRMED &&
      (await repo.markModalCreationUnconfirmed(job))
    )
      await publish(job.job_id)
  }
  const createOnce = async (
    job: ComputeJob,
    intent: ModalJobJournal,
    create: (remainingSeconds: number) => Promise<ModalJobJournal>
  ): Promise<void> => {
    const encoded = JSON.stringify(intent)
    if (!(await repo.replaceModalJournal(job, encoded, true))) return
    const fenced = { ...job, remote_handle: encoded }
    let receipt: ModalJobJournal
    try {
      const remainingSeconds = remaining(job)
      if (remainingSeconds < 1) throw new DeadlineElapsedBeforeCreate()
      receipt = await create(remainingSeconds)
    } catch (error) {
      if (error instanceof DeadlineElapsedBeforeCreate) {
        if (await repo.expireUnlaunchedModalJob(fenced, !intent.volume?.id))
          await publish(job.job_id)
      } else if (error instanceof ModalCreateRejectedError) {
        if (
          await repo.rejectModalSubmission(
            fenced,
            'Modal rejected resource creation. Review the approved environment, account and resource settings before submitting again.'
          )
        )
          await publish(job.job_id)
      } else await markUncertain(fenced)
      return
    }
    await repo.replaceModalJournal(fenced, JSON.stringify(receipt), false)
  }
  const reconcile = async (job: ComputeJob, signal: AbortSignal): Promise<void> => {
    const j = readModalJournal(job)
    if (uncertain(j)) {
      await markUncertain(job)
      return
    }
    if (job.harvested_at && !repo.canCleanJournalResources(job, j)) return
    if (
      !j.sandbox &&
      (job.status === 'submitted' || job.status === 'running') &&
      remaining(job) < 1
    ) {
      if (await repo.expireUnlaunchedModalJob(job, !j.volume?.id)) await publish(job.job_id)
      return
    }
    const binding = base(j)
    if ((await resolveModalApp(binding, signal)).appId !== binding.appId)
      throw new Error('Modal App identity changed after approval.')
    const files = frozen.parse(JSON.parse(job.input_manifest ?? '[]')).map((entry) => ({
      path: entry.dstFilename,
      localPath: decodeDataPath(entry.localPath, deps.storageRoot)!,
      bytes: entry.sizeBytes,
      sha256: entry.checksum
    }))
    if (!j.volume) {
      await verifyInputs(files, signal)
      const intent = { ...j, volume: {} }
      await createOnce(job, intent, async () => ({
        ...intent,
        volume: { id: (await createModalVolume(binding, signal)).volumeId }
      }))
      return
    }
    const scope = { ...binding, volumeId: j.volume.id! }
    if (job.status === 'submitted' || job.status === 'running') {
      if (!j.sandbox) {
        await stageModalInputs(
          { ...scope, files, maxBytes: LOCAL_RESOURCE_BUDGETS.artifactTurnBytes },
          signal
        )
        const intent = { ...j, sandbox: {} }
        const config = {
          ...scope,
          image: j.target.image,
          cpus: j.target.cpus,
          memoryMiB: j.target.memoryMiB,
          gpu: j.target.gpu,
          command: job.command
        }
        await createOnce(job, intent, async (timeoutSeconds) => ({
          ...intent,
          sandbox: {
            id: (await createModalSandbox({ ...config, timeoutSeconds }, signal)).sandboxId
          }
        }))
        return
      }
      const state = await inspectModalSandbox({ ...scope, sandboxId: j.sandbox.id! }, signal)
      const final = settlement(state)
      if (
        !final &&
        job.status === 'running' &&
        !job.last_poll_error &&
        (!state.stdoutTail || state.stdoutTail === job.stdout_tail) &&
        (!state.stderrTail || state.stderrTail === job.stderr_tail)
      )
        return
      const updated = await repo.updateIfStatus(job.job_id, [job.status], {
        ...(final ?? {
          status: 'running',
          startedAt: job.started_at ? undefined : new Date(),
          stdoutTail: state.stdoutTail,
          stderrTail: state.stderrTail
        }),
        lastPollError: null
      })
      if (updated) await deps.onJobUpdated(updated)
      return
    }
    if (!job.harvested_at) {
      await deps.harvest(job, scope, signal)
      return
    }
    await cleanupModalVolume(scope, signal)
    await deps.onJobUpdated(await repo.confirmModalCleanup(job))
  }
  const cancelOne = async (signal: AbortSignal): Promise<void> => {
    if (!operations) return
    const claim = await operations.claimNext(
      'cancel',
      new Date(),
      120000,
      randomUUID(),
      'modal_sandbox'
    )
    if (!claim) return
    const retry = (): Promise<boolean> =>
      operations.retry(claim, new Date(), new Date(Date.now() + 5000))
    try {
      const job = await repo.get(claim.jobId)
      if (!job) throw new Error('Missing Modal job.')
      const j = readModalJournal(job)
      if (uncertain(j)) {
        await markUncertain(job)
        await retry()
        return
      }
      if (j.sandbox?.id) {
        const scope = { ...base(j), volumeId: j.volume!.id!, sandboxId: j.sandbox.id }
        if ((await resolveModalApp(scope, signal)).appId !== scope.appId)
          throw new Error('Modal App changed.')
        let state = await inspectModalSandbox(scope, signal)
        if (state.status === 'running') {
          await terminateModalSandbox(scope, signal)
          state = await inspectModalSandbox(scope, signal)
          if (state.status === 'running') {
            await retry()
            return
          }
        }
        if (state.status !== 'cancelled') {
          await operations.settle(claim, new Date(), {
            outcome: 'superseded',
            job: settlement(state)
          })
          await publish(job.job_id)
          return
        }
      }
      if (await operations.fulfill(claim, new Date(), !j.volume, !!j.volume && !j.sandbox))
        await publish(job.job_id)
    } catch {
      await retry()
    }
  }
  const failures = new Map<string, { until: number; delay: number }>()
  const pass = async (signal: AbortSignal): Promise<void> => {
    await cancelOne(signal)
    const jobs = await repo.findModalWork()
    const ids = new Set(jobs.map((job) => job.job_id))
    for (const id of failures.keys()) if (!ids.has(id)) failures.delete(id)
    for (const job of jobs) {
      signal.throwIfAborted()
      const previous = failures.get(job.job_id)
      if (previous && Date.now() < previous.until) continue
      try {
        await reconcile(job, signal)
        failures.delete(job.job_id)
      } catch {
        signal.throwIfAborted()
        const delay = Math.min((previous?.delay ?? 2500) * 2, 300000)
        failures.set(job.job_id, { delay, until: Date.now() + delay })
        const message =
          'Modal job reconciliation is pending. Check the approved account, environment and App.'
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
        if (controller && !controller.signal.aborted) log.warn('Modal job recovery deferred.')
      })
      .finally(() => {
        active = undefined
      }))
  }
  const start = (): void => {
    if (stopped || controller) return
    controller = new AbortController()
    timer = setInterval(() => void tick(), 5000)
    timer.unref()
    void tick()
  }
  const pause = async (): Promise<void> => {
    clearInterval(timer)
    controller?.abort()
    controller = undefined
    await active
  }
  return {
    start,
    resume: start,
    pause,
    tick,
    manualCleanup: async (job) => {
      if (!controller) throw new Error('Compute recovery is paused.')
      const journal = readModalJournal(job)
      if (!journal.volume?.id || !repo.getManualStagedCleanup(job))
        throw new Error('Cannot verify staged resources.')
      await cleanupModalVolume({ ...base(journal), volumeId: journal.volume.id }, controller.signal)
      await deps.onJobUpdated(await repo.confirmManualStagedCleanup(job))
    },
    retry: async (jobId: string) => {
      await active
      failures.delete(jobId)
      await tick()
    },
    stop: async () => {
      stopped = true
      await pause()
    }
  }
}
