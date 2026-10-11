import { ComputeJobCancellationReaper, type ReaperOptions } from './compute-job-cancellation-owner'
import { ConcurrencyManager } from './concurrency-manager'
import type { ComputeConnectionBrokerAcquirer } from './connection'
import type * as Controllers from './controllers'
import { DispatchTracker } from './dispatch-tracker'
import { createComputeJobDeletionOwner } from './job-deletion-owner'
import { dispatchJob, type DispatcherDeps } from './job-dispatcher'
import { JobPoller, type JobPollerDeps } from './job-poller'
import type { ComputeJobOperationRepository, ComputeJobRepository } from './ports'

/** One execution scope per host runtime. In-flight dispatch never crosses scope boundaries. */
export const createComputeExecution = (): ComputeExecution => {
  const tracker = new DispatchTracker()
  return {
    holdDispatch(jobId: string): () => void {
      tracker.begin(jobId)
      let held = true
      return () => {
        if (!held) return
        held = false
        tracker.end(jobId)
      }
    },
    isDispatching: (jobId: string): boolean => tracker.has(jobId),
    waitForDispatch: (jobIds: readonly string[]): Promise<void> => tracker.waitFor(jobIds),
    dispatchJob: (jobId: string, deps: Omit<DispatcherDeps, 'dispatchTracker'>): Promise<void> =>
      dispatchJob(jobId, { ...deps, dispatchTracker: tracker }),
    createQueue: (options: ComputeQueueOptions): Controllers.ConcurrencyManager =>
      new ConcurrencyManager(
        options.jobs,
        options.hosts,
        options.dispatch,
        options.publish,
        undefined,
        tracker,
        options.sessionPolicy
      ),
    createPoller: (deps: Omit<JobPollerDeps, 'dispatchTracker'>): Controllers.JobPoller =>
      new JobPoller({ ...deps, dispatchTracker: tracker }),
    createCancellationReaper: (
      operations: ComputeJobOperationRepository,
      jobs: ComputeJobRepository,
      connections: ComputeConnectionBrokerAcquirer,
      options: Omit<ReaperOptions, 'dispatchTracker'> = {}
    ): Controllers.ComputeJobCancellationReaper =>
      new ComputeJobCancellationReaper(operations, jobs, connections, {
        ...options,
        dispatchTracker: tracker
      }),
    createDeletionOwner: (
      deps: Omit<Parameters<typeof createComputeJobDeletionOwner>[0], 'dispatchTracker'>
    ): Controllers.ComputeJobDeletionOwner =>
      createComputeJobDeletionOwner({ ...deps, dispatchTracker: tracker })
  }
}

export type ComputeQueueOptions = {
  jobs: import('./ports').ComputeJobRepository
  hosts: import('./ports').ComputeHostRepository
  dispatch: (
    jobId: string,
    onJobUpdated: (job: import('./model').ComputeJob) => void
  ) => Promise<void>
  publish?: (job: import('./model').ComputeJob) => void
  sessionPolicy?: import('./ports').SessionComputePolicyAuthority
}
export interface ComputeExecution {
  holdDispatch(jobId: string): () => void
  isDispatching(jobId: string): boolean
  waitForDispatch(jobIds: readonly string[]): Promise<void>
  dispatchJob(jobId: string, deps: Omit<DispatcherDeps, 'dispatchTracker'>): Promise<void>
  createQueue(options: ComputeQueueOptions): Controllers.ConcurrencyManager
  createPoller(deps: Omit<JobPollerDeps, 'dispatchTracker'>): Controllers.JobPoller
  createCancellationReaper(
    operations: ComputeJobOperationRepository,
    jobs: ComputeJobRepository,
    connections: ComputeConnectionBrokerAcquirer,
    options?: Omit<ReaperOptions, 'dispatchTracker'>
  ): Controllers.ComputeJobCancellationReaper
  createDeletionOwner(
    deps: Omit<Parameters<typeof createComputeJobDeletionOwner>[0], 'dispatchTracker'>
  ): Controllers.ComputeJobDeletionOwner
}
