import { broadcastJobUpdated } from './ipc'
import { harvestJob } from './harvest-engine'
import { JobPoller, type JobPollerDeps } from './job-poller'
import type { ComputeJobDeletionOwner } from './job-deletion-owner'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import type { ComputeService } from './compute-service'
import type { ComputeConnectionBroker } from './connection-broker'

type ComputeJobRuntime = Pick<JobPoller, 'start' | 'stop'>

type ComputeJobRuntimeDeps = {
  computeService: Pick<ComputeService, 'handleJobUpdated'>
  jobDeletionOwner?: Pick<ComputeJobDeletionOwner, 'bindRuntime'>
  hostRepository: ComputeHostRepository
  jobRepository: ComputeJobRepository
  connectionBroker: ComputeConnectionBroker
  storageRoot: string
}

type ComputeJobRuntimeAdapters = {
  broadcast?: typeof broadcastJobUpdated
  harvest?: typeof harvestJob
  createPoller?: (deps: JobPollerDeps) => ComputeJobRuntime & Pick<JobPoller, 'pause' | 'resume'>
}

// Owns the production poller's complete job-update contract. Main-process startup supplies only the
// long-lived compute handles; every update is routed through ComputeService, while notifications and
// harvesting retain their dedicated projections.
export const createComputeJobRuntime = (
  deps: ComputeJobRuntimeDeps,
  adapters: ComputeJobRuntimeAdapters = {}
): ComputeJobRuntime => {
  const broadcast = adapters.broadcast ?? broadcastJobUpdated
  const harvest = adapters.harvest ?? harvestJob
  const pollerDeps: JobPollerDeps = {
    connectionBroker: deps.connectionBroker,
    hostRepository: deps.hostRepository,
    jobRepository: deps.jobRepository,
    onJobUpdated: deps.computeService.handleJobUpdated,
    broadcast,
    storageRoot: deps.storageRoot,
    harvestFn: (job, signal) =>
      harvest(job, {
        connectionBroker: deps.connectionBroker,
        hostRepository: deps.hostRepository,
        jobRepository: deps.jobRepository,
        storageRoot: deps.storageRoot,
        broadcast,
        signal
      })
  }

  const poller = adapters.createPoller?.(pollerDeps) ?? new JobPoller(pollerDeps)
  const unbindDeletionRuntime = deps.jobDeletionOwner?.bindRuntime(poller)
  return {
    start: () => poller.start(),
    stop: async () => {
      unbindDeletionRuntime?.()
      await poller.stop()
    }
  }
}

export type { ComputeJobRuntime, ComputeJobRuntimeAdapters, ComputeJobRuntimeDeps }
