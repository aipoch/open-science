import type { ComputeJob } from '../../shared/compute'
import { sharedDispatchTracker, type DispatchTracker } from './dispatch-tracker'
import { computeRemoteWorkdir, quoteRemotePath, type RemoteHandle } from './job-dispatcher'
import { ComputeJobLifecycle } from './compute-job-lifecycle'
import type {
  ComputeJobOwner,
  ComputeJobRepository,
  ComputeJobSessionOwner
} from './job-repository'
import type { ComputeHostRepository } from './repository'
import { resolveSshTarget, type ResolvedSshTarget, type SshRunner } from './ssh-runner'

type ComputeJobDeletionRepository = Pick<ComputeJobRepository, 'findByOwner' | 'listOwners'>

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
  target: ResolvedSshTarget
  command: string
}

type PreparedOwnerDeletion = {
  owner: ComputeJobOwner
  remoteCleanups: PreparedRemoteCleanup[]
}

type ComputeJobDeletionOwnerDeps = {
  jobRepository: ComputeJobDeletionRepository
  lifecycle: ComputeJobDeletionLifecycle
  queueManager?: ComputeJobQueuePause
  hostRepository: Pick<ComputeHostRepository, 'get'>
  runner: SshRunner
  dispatchTracker?: Pick<DispatchTracker, 'waitFor'>
  resolveTarget?: (
    alias: string,
    overrides: Parameters<typeof resolveSshTarget>[1]
  ) => Promise<ResolvedSshTarget>
}

const ACTIVE_STATUSES = new Set<ComputeJob['status']>(['submitted', 'running'])

const validatedRemoteWorkdir = (job: ComputeJob, fallback?: string): string => {
  const workdir = job.remote_workdir ?? fallback
  const safeJobId = /^[A-Za-z0-9_-]+$/.test(job.job_id)
  const hasTraversal = workdir?.split('/').some((part) => part === '.' || part === '..')
  if (
    !workdir ||
    !safeJobId ||
    /[\0\r\n]/.test(workdir) ||
    hasTraversal ||
    !workdir.endsWith(`/.openscience/jobs/${job.job_id}`)
  ) {
    throw new Error(`Unsafe remote work directory for Compute Job ${job.job_id}.`)
  }
  return workdir
}

const sshAliasFromProviderId = (providerId: string): string => {
  const alias = providerId.startsWith('ssh:') ? providerId.slice(4).trim() : ''
  if (!alias || /[\0\r\n]/.test(alias)) {
    throw new Error(`Invalid Compute Job provider ${providerId}.`)
  }
  return alias
}

const activeRemoteHandle = (job: ComputeJob, workdir: string): RemoteHandle | undefined => {
  if (!ACTIVE_STATUSES.has(job.status)) return undefined
  if (!job.remote_handle) {
    if (job.status === 'submitted') return undefined
    throw new Error(`Invalid remote handle for active Compute Job ${job.job_id}.`)
  }
  try {
    const handle = JSON.parse(job.remote_handle) as RemoteHandle
    if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0 || handle.workdir !== workdir) {
      throw new Error('invalid handle')
    }
    return handle
  } catch {
    throw new Error(`Invalid remote handle for active Compute Job ${job.job_id}.`)
  }
}

const cleanupCommand = (workdir: string, handle: RemoteHandle | undefined): string => {
  const quotedWorkdir = quoteRemotePath(workdir)
  const quotedPidFile = quoteRemotePath(`${workdir}/job.pid`)
  const lines = handle
    ? [
        `kill -TERM -- -${handle.pid} 2>/dev/null || true`,
        `kill -TERM ${handle.pid} 2>/dev/null || true`,
        `kill -KILL -- -${handle.pid} 2>/dev/null || true`,
        `kill -KILL ${handle.pid} 2>/dev/null || true`
      ]
    : []
  lines.push(
    `if [ -f ${quotedPidFile} ]; then pid=$(cat ${quotedPidFile} 2>/dev/null || true); case $pid in ''|*[!0-9]*) ;; *) kill -TERM -- -$pid 2>/dev/null || true; kill -TERM $pid 2>/dev/null || true; kill -KILL -- -$pid 2>/dev/null || true; kill -KILL $pid 2>/dev/null || true ;; esac; fi`,
    `rm -rf -- ${quotedWorkdir}`,
    `test ! -e ${quotedWorkdir}`
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
  private readonly resolveTarget: NonNullable<ComputeJobDeletionOwnerDeps['resolveTarget']>

  constructor(private readonly deps: ComputeJobDeletionOwnerDeps) {
    this.dispatchTracker = deps.dispatchTracker ?? sharedDispatchTracker
    this.resolveTarget = deps.resolveTarget ?? resolveSshTarget
  }

  bindRuntime(runtime: ComputeJobRuntimePause): () => void {
    this.runtime = runtime
    return () => {
      if (this.runtime === runtime) this.runtime = undefined
    }
  }

  prepareSessionJobDeletion(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => this.prepareOwner({ projectId, sessionId }))
  }

  commitSessionJobDeletion(projectId: string, sessionId: string): Promise<void> {
    return this.enqueue(() => this.commitOwner({ projectId, sessionId }))
  }

  prepareProjectJobDeletion(projectId: string): Promise<void> {
    return this.enqueue(() => this.prepareOwner({ projectId }))
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

  restoreOrphanJobDeletionBarriers(
    isOwnerLive: (owner: ComputeJobSessionOwner) => Promise<boolean>
  ): Promise<void> {
    return this.enqueue(async () => {
      const owners = await this.deps.jobRepository.listOwners()
      for (const owner of owners) {
        if (await isOwnerLive(owner)) continue
        await this.armOwner(owner, true)
      }
    })
  }

  reconcileOrphanJobs(
    isOwnerLive: (owner: ComputeJobSessionOwner) => Promise<boolean>
  ): Promise<void> {
    return this.enqueue(async () => {
      const owners = await this.deps.jobRepository.listOwners()
      for (const owner of owners) {
        if (await isOwnerLive(owner)) continue
        await this.prepareOwner(owner)
        await this.commitOwner(owner)
      }
    })
  }

  private enqueue(operationOwner: () => Promise<void>): Promise<void> {
    const operation = this.operationQueue.then(operationOwner)
    this.operationQueue = operation.catch(() => undefined)
    return operation
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
    let runtimePaused = false
    try {
      if (this.runtime) {
        await this.runtime.pause()
        runtimePaused = true
      }
      const observed = await this.deps.jobRepository.findByOwner(owner)
      await this.dispatchTracker.waitFor(observed.map((job) => job.job_id))
      const jobs = await this.deps.jobRepository.findByOwner(owner)
      const remoteCleanups: PreparedRemoteCleanup[] = []
      for (const job of jobs) {
        const cleanup = await this.prepareRemoteCleanup(job)
        if (cleanup) remoteCleanups.push(cleanup)
      }
      this.preparedDeletion = { owner, remoteCleanups }
    } catch (error) {
      try {
        if (!this.retainedOwners.has(this.ownerKey(owner))) {
          await this.releaseOwnerBarrier(owner)
        }
      } finally {
        if (runtimePaused) this.runtime?.resume()
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
    for (const cleanup of prepared.remoteCleanups) await this.runRemoteCleanup(cleanup)
    await this.deps.lifecycle.deleteOwnerRows(owner)
    this.preparedDeletion = undefined
    this.releaseCommittedOwnerBarriers(owner)
    this.runtime?.resume()
  }

  private async abortOwner(owner: ComputeJobOwner): Promise<void> {
    if (this.preparedDeletion && !this.sameOwner(this.preparedDeletion.owner, owner)) {
      throw new Error('A different Compute Job owner deletion is prepared.')
    }
    const prepared = this.preparedDeletion !== undefined
    await this.releaseOwnerBarrier(owner)
    if (prepared) {
      this.preparedDeletion = undefined
      this.runtime?.resume()
    }
  }

  private async prepareRemoteCleanup(job: ComputeJob): Promise<PreparedRemoteCleanup | undefined> {
    if (job.status === 'queued') return undefined
    const host = await this.deps.hostRepository.get(job.provider_id)
    const fallbackWorkdir = host ? computeRemoteWorkdir(host.scratchRoot, job.job_id) : undefined
    const workdir = validatedRemoteWorkdir(job, fallbackWorkdir)
    const handle = activeRemoteHandle(job, workdir)
    const target = await this.resolveTarget(
      host?.sshAlias ?? sshAliasFromProviderId(job.provider_id),
      host?.sshOverrides
    )
    return { jobId: job.job_id, target, command: cleanupCommand(workdir, handle) }
  }

  private async runRemoteCleanup(cleanup: PreparedRemoteCleanup): Promise<void> {
    const result = await this.deps.runner.run(cleanup.target, cleanup.command, {
      timeoutMs: 30_000,
      loginShell: false,
      maxOutputBytes: 4 * 1024
    })
    if (result.timedOut || result.exitCode !== 0) {
      const detail = result.stderr.trim() || `exit ${result.exitCode ?? 'null'}`
      throw new Error(`Remote Compute Job cleanup failed for ${cleanup.jobId}: ${detail}`)
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

export {
  ComputeJobDeletionOwner,
  cleanupCommand,
  createComputeJobDeletionOwner,
  validatedRemoteWorkdir
}
export type {
  ComputeJobDeletionLifecycle,
  ComputeJobDeletionOwnerDeps,
  ComputeJobDeletionRepository,
  ComputeJobQueuePause,
  ComputeJobRuntimePause
}
