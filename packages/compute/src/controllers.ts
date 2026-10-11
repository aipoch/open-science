import { ComputeJobCancellationOwner as Cancellation } from './compute-job-cancellation-owner'
import { ComputeJobLifecycle as Lifecycle } from './compute-job-lifecycle'
import { JobHarvestScheduler as HarvestScheduler } from './job-harvest-scheduler'
import { SystemScpRunner } from './scp-runner'
import { SystemSshRunner } from './ssh-runner'

/** Public controller contracts expose operations, never implementation fields or constructors. */
export type ComputeJobLifecycle = Pick<Lifecycle, keyof Lifecycle>
export type ComputeJobCancellationOwner = Pick<Cancellation, keyof Cancellation>
export type JobHarvestScheduler = Pick<HarvestScheduler, keyof HarvestScheduler>
export type JobPoller = Pick<
  import('./job-poller').JobPoller,
  keyof import('./job-poller').JobPoller
>
export type ConcurrencyManager = Pick<
  import('./concurrency-manager').ConcurrencyManager,
  keyof import('./concurrency-manager').ConcurrencyManager
>
export type ComputeJobCancellationReaper = Pick<
  import('./compute-job-cancellation-owner').ComputeJobCancellationReaper,
  keyof import('./compute-job-cancellation-owner').ComputeJobCancellationReaper
>
export type ComputeJobDeletionOwner = Pick<
  import('./job-deletion-owner').ComputeJobDeletionOwner,
  keyof import('./job-deletion-owner').ComputeJobDeletionOwner
>
export const createJobLifecycle = (
  ...args: ConstructorParameters<typeof Lifecycle>
): ComputeJobLifecycle => new Lifecycle(...args)
export const createJobCancellation = (
  ...args: ConstructorParameters<typeof Cancellation>
): ComputeJobCancellationOwner => new Cancellation(...args)
export const createHarvestScheduler = (
  ...args: ConstructorParameters<typeof HarvestScheduler>
): JobHarvestScheduler => new HarvestScheduler(...args)
export const createSshRunner = (
  ...args: ConstructorParameters<typeof SystemSshRunner>
): import('./ssh-runner').SshRunner => new SystemSshRunner(...args)
export const createScpRunner = (
  ...args: ConstructorParameters<typeof SystemScpRunner>
): import('./scp-runner').ScpRunner => new SystemScpRunner(...args)

export type DispatcherDeps = Omit<import('./job-dispatcher').DispatcherDeps, 'dispatchTracker'>
export type JobPollerDeps = Omit<import('./job-poller').JobPollerDeps, 'dispatchTracker'>
