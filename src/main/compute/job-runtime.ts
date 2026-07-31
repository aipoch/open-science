import { broadcastJobUpdated } from './ipc'
import { harvestJob } from './harvest-engine'
import { JobPoller, type JobPollerDeps } from './job-poller'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ComputeService } from './compute-service'
import { SystemScpRunner, type ScpRunner } from './scp-runner'
import { SystemSshRunner, type SshRunner } from './ssh-runner'

type ComputeJobRuntime = Pick<JobPoller, 'start' | 'stop'>

type ComputeJobRuntimeDeps = {
  computeService: Pick<ComputeService, 'handleJobUpdated'>
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  storageRoot: string
}

type ComputeJobRuntimeAdapters = {
  runner?: SshRunner
  scpRunner?: ScpRunner
  broadcast?: typeof broadcastJobUpdated
  harvest?: typeof harvestJob
  createPoller?: (deps: JobPollerDeps) => ComputeJobRuntime
}

// Owns the production poller's complete job-update contract. Main-process startup supplies only the
// long-lived compute handles; every update is routed through ComputeService, while notifications and
// harvesting retain their dedicated projections.
export const createComputeJobRuntime = (
  deps: ComputeJobRuntimeDeps,
  adapters: ComputeJobRuntimeAdapters = {}
): ComputeJobRuntime => {
  const runner = adapters.runner ?? new SystemSshRunner()
  const scpRunner = adapters.scpRunner ?? new SystemScpRunner()
  const broadcast = adapters.broadcast ?? broadcastJobUpdated
  const harvest = adapters.harvest ?? harvestJob
  const pollerDeps: JobPollerDeps = {
    runner,
    hostRepository: deps.hostRepository,
    jobRepository: deps.jobRepository,
    onJobUpdated: deps.computeService.handleJobUpdated,
    broadcast,
    storageRoot: deps.storageRoot,
    harvestFn: (job) =>
      harvest(job, {
        sshRunner: runner,
        scpRunner,
        hostRepository: deps.hostRepository,
        jobRepository: deps.jobRepository,
        storageRoot: deps.storageRoot,
        broadcast
      })
  }

  return adapters.createPoller?.(pollerDeps) ?? new JobPoller(pollerDeps)
}

export type { ComputeJobRuntime, ComputeJobRuntimeAdapters, ComputeJobRuntimeDeps }
