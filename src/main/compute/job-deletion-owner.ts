import type { ComputeJob, SetComputeJobRemoteCleanupRequest } from '../../shared/compute'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { computeRemoteWorkdir, quoteRemotePath, type RemoteHandle } from './job-dispatcher'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import type {
  ComputeJobOwner,
  ComputeJobRepository,
  ComputeJobSessionOwner
} from './job-repository'
import type { ComputeHostRepository } from './repository'
import {
  classifyConnectionFailure,
  type ComputeConnectionBrokerAcquirer
} from './connection-broker'
import { remoteJobPidTerminationFunctionLines } from './remote-job-process'
import { parseRemoteJobHandle, parseRemoteJobWorkdir } from './remote-job-handle'

type ComputeJobDeletionRepository = Pick<
  ComputeJobRepository,
  'findByOwner' | 'listOwners' | 'get' | 'settleRemoteCleanup'
>
type ComputeJobOwnerLiveness = boolean | 'unknown'

type ComputeJobDeletionLifecycle = Pick<
  ComputeJobLifecycle,
  'beginOwnerDeletion' | 'deleteOwnerRows' | 'abortOwnerDeletion'
>

type ComputeJobQueuePause = {
  pauseOwner(owner: ComputeJobOwner): Promise<void>
  resumeOwner(owner: ComputeJobOwner): void
}

type ComputeJobRuntimePause = {
  pause(): Promise<void>
  resume(): void
}

type PreparedRemoteCleanup = {
  jobId: string
  providerId: string
  command: string
}

type PreparedDeletionOutcome = { status: 'released' } | { status: 'retained'; error: unknown }

type PreparedOwnerDeletion = {
  owner: ComputeJobOwner
  remoteCleanups: PreparedRemoteCleanup[]
  outcome: Promise<PreparedDeletionOutcome>
  settleOutcome(outcome: PreparedDeletionOutcome): void
}

type ComputeJobDeletionOwnerDeps = {
  jobRepository: ComputeJobDeletionRepository
  lifecycle: ComputeJobDeletionLifecycle
  queueManager?: ComputeJobQueuePause
  hostRepository: Pick<ComputeHostRepository, 'get'>
  connectionBroker: ComputeConnectionBrokerAcquirer
  dispatchTracker?: Pick<DispatchTracker, 'waitFor'>
  requestCancellation?: (job: ComputeJob) => Promise<void>
  confirmCancellation?: (job: ComputeJob) => Promise<void>
}

const ACTIVE_STATUSES = new Set<ComputeJob['status']>(['submitted', 'running'])
const HARVESTABLE_TERMINAL_STATUSES = new Set<ComputeJob['status']>([
  'success',
  'failed',
  'timeout'
])

const activeRemoteHandle = (job: ComputeJob, workdir: string): RemoteHandle | undefined => {
  if (!ACTIVE_STATUSES.has(job.status)) return undefined
  if (!job.remote_handle) {
    if (job.status === 'submitted') return undefined
    throw new Error(`Invalid remote handle for active Compute Job ${job.job_id}.`)
  }
  const handle = parseRemoteJobHandle(job.remote_handle, workdir)
  if (!handle) {
    throw new Error(`Invalid remote handle for active Compute Job ${job.job_id}.`)
  }
  return handle
}

const cleanupCommand = (
  workdir: string,
  handle: RemoteHandle | undefined,
  requirePidWitness = false
): string => {
  const marker = '/.openscience/jobs/'
  const markerIndex = workdir.lastIndexOf(marker)
  if (markerIndex < 0) throw new Error('Unsafe remote Compute Job cleanup path.')
  const scratchRoot = markerIndex === 0 ? '/' : workdir.slice(0, markerIndex)
  const workdirSuffix = workdir.slice(markerIndex + 1)
  const parentSeparatorIndex = workdir.lastIndexOf('/')
  const workdirParent = workdir.slice(0, parentSeparatorIndex)
  const workdirParentSuffix = workdirSuffix.slice(0, workdirSuffix.lastIndexOf('/'))
  const quotedScratchRoot = quoteRemotePath(scratchRoot)
  const quotedWorkdirSuffix = quoteRemotePath(workdirSuffix)
  const quotedWorkdirParent = quoteRemotePath(workdirParent)
  const quotedWorkdirParentSuffix = quoteRemotePath(workdirParentSuffix)
  const quotedWorkdir = quoteRemotePath(workdir)
  const quotedPidFile = quoteRemotePath(`${workdir}/job.pid`)
  // Retried plans may contain stale PIDs. Signal only while cwd still proves Job ownership;
  // permit stale/absent PIDs, but fail closed when ownership cannot be determined.
  const lines = [
    `[ ! -L ${quotedWorkdir} ] || exit 1`,
    `scratch_root=$(cd -- ${quotedScratchRoot} 2>/dev/null && pwd -P) || exit 1`,
    `workdir_parent=$(cd -- ${quotedWorkdirParent} 2>/dev/null && pwd -P) || exit 1`,
    'expected_workdir_parent=${scratch_root%/}/' + quotedWorkdirParentSuffix,
    '[ "$workdir_parent" = "$expected_workdir_parent" ] || exit 1',
    `if [ -e ${quotedWorkdir} ]; then`,
    `  [ -d ${quotedWorkdir} ] || exit 1`,
    `  workdir=$(cd -- ${quotedWorkdir} 2>/dev/null && pwd -P) || exit 1`,
    'else',
    '  workdir=',
    'fi',
    'expected_workdir=${scratch_root%/}/' + quotedWorkdirSuffix,
    '[ -z "$workdir" ] || [ "$workdir" = "$expected_workdir" ] || exit 1',
    ...remoteJobPidTerminationFunctionLines(),
    'cleanup_job_pid() {',
    '  kill_job_pid "$1"',
    '  ownership=$?',
    '  case $ownership in 0|1|3) return 0 ;; *) return 2 ;; esac',
    '}'
  ]
  if (handle) lines.push(`cleanup_job_pid ${handle.pid} || exit 1`)
  if (requirePidWitness) {
    lines.push(`[ -z "$workdir" ] || [ -f ${quotedPidFile} ] || exit 1`)
  }
  lines.push(
    `if [ -f ${quotedPidFile} ]; then cleanup_job_pid "$(cat ${quotedPidFile} 2>/dev/null || true)" || exit 1; fi`,
    'if [ -n "$workdir" ]; then rm -rf -- "$workdir"; fi',
    `test ! -e ${quotedWorkdir} && test ! -L ${quotedWorkdir}`
  )
  return lines.join('\n')
}

class ComputeJobDeletionOwner {
  private operationQueue: Promise<unknown> = Promise.resolve()
  private runtime: ComputeJobRuntimePause | undefined
  private preparedDeletion: PreparedOwnerDeletion | undefined
  private readonly armedOwners = new Map<string, ComputeJobOwner>()
  private readonly retainedOwners = new Set<string>()
  private readonly dispatchTracker: Pick<DispatchTracker, 'waitFor'>

  constructor(private readonly deps: ComputeJobDeletionOwnerDeps) {
    this.dispatchTracker = deps.dispatchTracker ?? sharedDispatchTracker
  }

  bindRuntime(runtime: ComputeJobRuntimePause): () => void {
    this.runtime = runtime
    return () => {
      if (this.runtime === runtime) this.runtime = undefined
    }
  }

  prepareSessionJobDeletion(projectId: string, sessionId: string): Promise<void> {
    return this.prepareOwnerWhenAvailable({ projectId, sessionId })
  }

  commitSessionJobDeletion(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => this.commitOwner({ projectId, sessionId }))
  }

  prepareProjectJobDeletion(projectId: string): Promise<void> {
    return this.prepareOwnerWhenAvailable({ projectId })
  }

  commitProjectJobDeletion(projectId: string): Promise<void> {
    return this.enqueue(() => this.commitOwner({ projectId }))
  }

  abortSessionJobDeletion(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => this.abortOwner({ projectId, sessionId }))
  }

  abortProjectJobDeletion(projectId: string): Promise<void> {
    return this.enqueue(() => this.abortOwner({ projectId }))
  }

  restoreProjectJobDeletion(projectId: string): Promise<void> {
    return this.enqueue(() => this.armOwner({ projectId }, true))
  }

  cleanupJobRemote(request: SetComputeJobRemoteCleanupRequest): Promise<ComputeJob> {
    return this.enqueue(async () => {
      const job = await this.deps.jobRepository.get(request.jobId)
      if (
        !job ||
        job.provider_id !== request.providerId ||
        job.project_id !== request.projectId ||
        job.session_id !== request.sessionId
      ) {
        throw new Error('Compute Job cleanup scope does not match.')
      }
      if (request.disposition !== 'cleaned') {
        throw new Error('Remote cleanup requires the cleaned disposition.')
      }
      if (
        job.remote_cleanup_disposition !== undefined &&
        job.remote_cleanup_disposition !== 'pending'
      ) {
        return this.deps.jobRepository.settleRemoteCleanup(request)
      }
      if (HARVESTABLE_TERMINAL_STATUSES.has(job.status) && job.harvested_at === undefined) {
        throw new Error('Compute Job results must be harvested before remote cleanup.')
      }
      const cancellationRequired = ACTIVE_STATUSES.has(job.status) || job.status === 'queued'
      const runtime = this.runtime
      if (cancellationRequired && !runtime) {
        throw new Error('Compute Job cancellation runtime is unavailable.')
      }
      const queueManager = this.deps.queueManager
      if (cancellationRequired && !queueManager) {
        throw new Error('Compute Job cancellation queue manager is unavailable.')
      }
      const owner = { projectId: job.project_id, sessionId: job.session_id }
      let queuePaused = false
      let runtimePaused = false
      try {
        let currentJob = job
        if (cancellationRequired && runtime && queueManager) {
          await queueManager.pauseOwner(owner)
          queuePaused = true
          await runtime.pause()
          runtimePaused = true
          const refreshedJob = await this.deps.jobRepository.get(request.jobId)
          if (
            !refreshedJob ||
            refreshedJob.provider_id !== request.providerId ||
            refreshedJob.project_id !== request.projectId ||
            refreshedJob.session_id !== request.sessionId
          ) {
            throw new Error('Compute Job cleanup scope does not match.')
          }
          currentJob = refreshedJob
          if (
            currentJob.remote_cleanup_disposition !== undefined &&
            currentJob.remote_cleanup_disposition !== 'pending'
          ) {
            return await this.deps.jobRepository.settleRemoteCleanup(request)
          }
          if (
            HARVESTABLE_TERMINAL_STATUSES.has(currentJob.status) &&
            currentJob.harvested_at === undefined
          ) {
            throw new Error('Compute Job results must be harvested before remote cleanup.')
          }
        }
        const currentCancellationRequired =
          ACTIVE_STATUSES.has(currentJob.status) || currentJob.status === 'queued'
        const requestCancellation = this.deps.requestCancellation
        const confirmCancellation = this.deps.confirmCancellation
        if (currentCancellationRequired && (!requestCancellation || !confirmCancellation)) {
          throw new Error('Compute Job cancellation is unavailable.')
        }
        if (currentCancellationRequired) await requestCancellation?.(currentJob)
        await this.dispatchTracker.waitFor([currentJob.job_id])
        const cleanup = await this.prepareRemoteCleanup(currentJob)
        if (cleanup) await this.runRemoteCleanup(cleanup)
        if (currentCancellationRequired) await confirmCancellation?.(currentJob)
        return await this.deps.jobRepository.settleRemoteCleanup(request)
      } finally {
        if (runtimePaused) runtime?.resume()
        if (queuePaused) queueManager?.resumeOwner(owner)
      }
    })
  }

  abandonJobRemoteCleanup(request: SetComputeJobRemoteCleanupRequest): Promise<ComputeJob> {
    return this.enqueue(async () => {
      if (request.disposition !== 'abandoned') {
        throw new Error('Abandoning remote cleanup requires the abandoned disposition.')
      }
      const job = await this.deps.jobRepository.get(request.jobId)
      if (
        !job ||
        job.provider_id !== request.providerId ||
        job.project_id !== request.projectId ||
        job.session_id !== request.sessionId
      ) {
        throw new Error('Compute Job cleanup scope does not match.')
      }
      if (ACTIVE_STATUSES.has(job.status) || job.status === 'queued') {
        throw new Error('Active Compute Jobs must be cancelled and cleaned remotely.')
      }
      return this.deps.jobRepository.settleRemoteCleanup(request)
    })
  }

  restoreOrphanJobDeletionBarriers(
    isOwnerLive: (owner: ComputeJobSessionOwner) => Promise<ComputeJobOwnerLiveness>
  ): Promise<void> {
    return this.enqueue(async () => {
      const owners = await this.deps.jobRepository.listOwners()
      for (const owner of owners) {
        if ((await isOwnerLive(owner)) === true) continue
        await this.armOwner(owner, true)
      }
    })
  }

  reconcileOrphanJobs(
    isOwnerLive: (owner: ComputeJobSessionOwner) => Promise<ComputeJobOwnerLiveness>
  ): Promise<void> {
    return this.enqueue(() => this.reconcileOrphanOwners(isOwnerLive))
  }

  reconcileProjectOrphanJobs(
    projectId: string,
    isOwnerLive: (owner: ComputeJobSessionOwner) => Promise<ComputeJobOwnerLiveness>
  ): Promise<void> {
    return this.enqueue(() => this.reconcileOrphanOwners(isOwnerLive, projectId))
  }

  private enqueue<Result>(operationOwner: () => Promise<Result>): Promise<Result> {
    const operation = this.operationQueue.then(operationOwner)
    this.operationQueue = operation.catch(() => undefined)
    return operation
  }

  private async prepareOwnerWhenAvailable(owner: ComputeJobOwner): Promise<void> {
    while (true) {
      const decision = await this.enqueue(async () => {
        const prepared = this.preparedDeletion
        if (prepared && !this.sameOwner(prepared.owner, owner)) {
          return { status: 'wait' as const, outcome: prepared.outcome }
        }
        await this.prepareOwner(owner)
        return { status: 'prepared' as const }
      })
      if (decision.status === 'prepared') return

      const outcome = await decision.outcome
      if (outcome.status === 'retained') throw outcome.error
    }
  }

  private sameOwner(left: ComputeJobOwner, right: ComputeJobOwner): boolean {
    return left.projectId === right.projectId && left.sessionId === right.sessionId
  }

  private ownerKey(owner: ComputeJobOwner): string {
    return JSON.stringify([owner.projectId, owner.sessionId])
  }

  private async armOwner(owner: ComputeJobOwner, retainOnFailure: boolean): Promise<void> {
    const key = this.ownerKey(owner)
    if (this.armedOwners.has(key)) {
      if (retainOnFailure) this.retainedOwners.add(key)
      return
    }

    await this.deps.lifecycle.beginOwnerDeletion(owner)
    try {
      await this.deps.queueManager?.pauseOwner(owner)
      this.armedOwners.set(key, owner)
      if (retainOnFailure) this.retainedOwners.add(key)
    } catch (error) {
      try {
        await this.deps.lifecycle.abortOwnerDeletion(owner)
      } finally {
        this.deps.queueManager?.resumeOwner(owner)
      }
      throw error
    }
  }

  private async releaseOwnerBarrier(owner: ComputeJobOwner): Promise<void> {
    const key = this.ownerKey(owner)
    await this.deps.lifecycle.abortOwnerDeletion(owner)
    this.armedOwners.delete(key)
    this.retainedOwners.delete(key)
    this.deps.queueManager?.resumeOwner(owner)
  }

  private releaseCommittedOwnerBarriers(owner: ComputeJobOwner): void {
    for (const [key, candidate] of this.armedOwners) {
      if (
        candidate.projectId !== owner.projectId ||
        (owner.sessionId !== undefined && candidate.sessionId !== owner.sessionId)
      ) {
        continue
      }
      this.armedOwners.delete(key)
      this.retainedOwners.delete(key)
      this.deps.queueManager?.resumeOwner(candidate)
    }
  }

  private async prepareOwner(owner: ComputeJobOwner): Promise<void> {
    if (this.preparedDeletion) {
      if (this.sameOwner(this.preparedDeletion.owner, owner)) return
      throw new Error('Another Compute Job owner deletion is already prepared.')
    }

    await this.armOwner(owner, false)
    // Runtime pause is global. Hold it only through the owner-scoped barrier and dispatch drain;
    // durable remote cleanup runs later under that barrier without freezing unrelated owners.
    const runtime = this.runtime
    let runtimePaused = false
    try {
      try {
        if (runtime) {
          await runtime.pause()
          runtimePaused = true
        }
        const observed = await this.deps.jobRepository.findByOwner(owner)
        await this.dispatchTracker.waitFor(observed.map((job) => job.job_id))
      } finally {
        if (runtimePaused) runtime?.resume()
      }

      // The owner barrier now excludes these rows from new polling/dispatch. Build the cleanup plan
      // without holding the global runtime pause so unrelated owners keep making progress.
      const jobs = await this.deps.jobRepository.findByOwner(owner)
      const remoteCleanups: PreparedRemoteCleanup[] = []
      for (const job of jobs) {
        const cleanup = await this.prepareRemoteCleanup(job)
        if (cleanup) remoteCleanups.push(cleanup)
      }
      let settleOutcome!: (outcome: PreparedDeletionOutcome) => void
      const outcome = new Promise<PreparedDeletionOutcome>((resolve) => {
        settleOutcome = resolve
      })
      this.preparedDeletion = { owner, remoteCleanups, outcome, settleOutcome }
    } catch (error) {
      if (!this.retainedOwners.has(this.ownerKey(owner))) {
        await this.releaseOwnerBarrier(owner)
      }
      throw error
    }
  }

  private async commitOwner(owner: ComputeJobOwner): Promise<void> {
    const prepared = this.preparedDeletion
    if (!prepared || !this.sameOwner(prepared.owner, owner)) {
      throw new Error('Compute Job owner deletion is not prepared.')
    }
    // The caller invokes this phase only after Session JSON deletion or the Project Session
    // tombstone is durable. Keep Job rows until every idempotent remote cleanup succeeds.
    try {
      for (const cleanup of prepared.remoteCleanups) await this.runRemoteCleanup(cleanup)
      await this.deps.lifecycle.deleteOwnerRows(owner)
    } catch (error) {
      prepared.settleOutcome({ status: 'retained', error })
      throw error
    }
    this.preparedDeletion = undefined
    prepared.settleOutcome({ status: 'released' })
    this.releaseCommittedOwnerBarriers(owner)
  }

  private async abortOwner(owner: ComputeJobOwner): Promise<void> {
    if (this.preparedDeletion && !this.sameOwner(this.preparedDeletion.owner, owner)) {
      // A parent Project abort can race a retained child Session cleanup plan. The parent never
      // armed a new barrier because prepareOwner rejected before armOwner, so leave the child plan
      // and any restored durable Project barrier untouched for the next recovery attempt.
      return
    }
    const prepared = this.preparedDeletion
    await this.releaseOwnerBarrier(owner)
    if (prepared) {
      this.preparedDeletion = undefined
      prepared.settleOutcome({ status: 'released' })
    }
  }

  private async reconcileOrphanOwners(
    isOwnerLive: (owner: ComputeJobSessionOwner) => Promise<ComputeJobOwnerLiveness>,
    projectId?: string
  ): Promise<void> {
    const owners = (await this.deps.jobRepository.listOwners()).filter(
      (owner) => projectId === undefined || owner.projectId === projectId
    )
    const prepared = this.preparedDeletion?.owner
    if (prepared?.sessionId !== undefined) {
      const preparedIndex = owners.findIndex((owner) => this.sameOwner(owner, prepared))
      if (preparedIndex > 0) owners.unshift(...owners.splice(preparedIndex, 1))
    }
    for (const owner of owners) {
      const liveness = await isOwnerLive(owner)
      if (liveness === 'unknown') continue
      if (liveness) {
        const key = this.ownerKey(owner)
        if (
          this.retainedOwners.has(key) &&
          (!this.preparedDeletion || !this.sameOwner(this.preparedDeletion.owner, owner))
        ) {
          await this.releaseOwnerBarrier(owner)
        }
        continue
      }
      await this.prepareOwner(owner)
      await this.commitOwner(owner)
    }
  }

  private async prepareRemoteCleanup(job: ComputeJob): Promise<PreparedRemoteCleanup | undefined> {
    if (
      job.remote_cleanup_disposition !== undefined &&
      job.remote_cleanup_disposition !== 'pending'
    ) {
      return undefined
    }
    if (job.status === 'queued') return undefined
    const host = await this.deps.hostRepository.get(job.provider_id)
    const fallbackWorkdir = host ? computeRemoteWorkdir(host.scratchRoot, job.job_id) : undefined
    const workdir = parseRemoteJobWorkdir(job.job_id, job.remote_workdir, fallbackWorkdir)
    if (!workdir) {
      throw new Error(`Unsafe remote work directory for Compute Job ${job.job_id}.`)
    }
    const handle = activeRemoteHandle(job, workdir)
    return {
      jobId: job.job_id,
      providerId: job.provider_id,
      command: cleanupCommand(workdir, handle, job.status === 'submitted' && !handle)
    }
  }

  private async runRemoteCleanup(cleanup: PreparedRemoteCleanup): Promise<void> {
    const connection = await this.deps.connectionBroker.acquire(cleanup.providerId, {
      intent: 'job_cleanup'
    })
    const result = await connection.run(cleanup.command, {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4 * 1024
    })
    const connectionFailure = classifyConnectionFailure(result, false)
    if (connectionFailure) throw connectionFailure
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`Remote Compute Job cleanup failed for ${cleanup.jobId}.`)
    }
  }
}

const createComputeJobDeletionOwner = (
  deps: Omit<ComputeJobDeletionOwnerDeps, 'jobRepository' | 'lifecycle'> & {
    jobRepository: ComputeJobRepository
  }
): ComputeJobDeletionOwner =>
  new ComputeJobDeletionOwner({
    ...deps,
    lifecycle: new ComputeJobLifecycle(deps.jobRepository)
  })

export { ComputeJobDeletionOwner, cleanupCommand, createComputeJobDeletionOwner }
export type {
  ComputeJobDeletionLifecycle,
  ComputeJobDeletionOwnerDeps,
  ComputeJobDeletionRepository,
  ComputeJobOwnerLiveness,
  ComputeJobQueuePause,
  ComputeJobRuntimePause
}
