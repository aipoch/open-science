import type {
  ComputeDriverId,
  ComputeExecutionMode,
  ComputeHost,
  ComputeJob
} from '../../shared/compute'
import type { ComputeConnectionLease } from './connection-broker'
import type { ComputeJobLifecycle } from './compute-job-lifecycle'
import type { ComputeRemoteHandle } from './remote-job-contract'
import { DirectSshDriver } from './direct-ssh-driver'
import { SlurmDriver } from './slurm-driver'

export type DriverSubmitContext = {
  job: ComputeJob
  connection: ComputeConnectionLease
  workdir: string
  lifecycle: ComputeJobLifecycle
}

export type DriverRecoveryContext = {
  job: ComputeJob
  connection: ComputeConnectionLease
}

export type DriverPollEntry<Handle extends ComputeRemoteHandle = ComputeRemoteHandle> = {
  job: ComputeJob
  handle: Handle
}

export type DriverPollOptions = {
  signal?: AbortSignal
  nonce?: string
}

export type DriverCancelContext<Handle extends ComputeRemoteHandle = ComputeRemoteHandle> = {
  job: ComputeJob
  handle: Handle | null
  connection: ComputeConnectionLease
}

export type DriverCancelResult<Handle extends ComputeRemoteHandle = ComputeRemoteHandle> = {
  confirmed: boolean
  remoteWorkdirAbsent?: boolean
  recoveredHandle?: Handle
}

export interface ComputeJobDriver<
  Handle extends ComputeRemoteHandle = ComputeRemoteHandle,
  Observation = unknown
> {
  readonly id: ComputeDriverId
  submit(context: DriverSubmitContext): Promise<void>
  recover(context: DriverRecoveryContext): Promise<Handle | undefined>
  poll(
    entries: readonly DriverPollEntry<Handle>[],
    connection: ComputeConnectionLease,
    options?: DriverPollOptions
  ): Promise<Map<string, Observation>>
  cancel(context: DriverCancelContext<Handle>): Promise<DriverCancelResult<Handle>>
}

export const createComputeJobDriver = (
  id: ComputeDriverId
): ComputeJobDriver<ComputeRemoteHandle, unknown> =>
  id === 'slurm'
    ? (new SlurmDriver() as unknown as ComputeJobDriver<ComputeRemoteHandle, unknown>)
    : (new DirectSshDriver() as unknown as ComputeJobDriver<ComputeRemoteHandle, unknown>)

export class UnsupportedSchedulerDriverError extends Error {
  constructor(readonly scheduler: 'pbs' | 'lsf') {
    super(
      `This Compute Host advertises ${scheduler.toUpperCase()}, but Open-Science has no ${scheduler.toUpperCase()} submission driver yet. Choose Direct SSH explicitly to override scheduler detection, or wait for ${scheduler.toUpperCase()} support.`
    )
    this.name = 'UnsupportedSchedulerDriverError'
  }
}

export const resolveComputeDriverId = (
  host: Pick<ComputeHost, 'executionMode' | 'probeResult'>
): ComputeDriverId => {
  const configured: ComputeExecutionMode = host.executionMode ?? 'auto'
  if (configured !== 'auto') return configured

  const detected = host.probeResult?.detectedScheduler
  if (detected === 'pbs' || detected === 'lsf') {
    throw new UnsupportedSchedulerDriverError(detected)
  }
  return detected === 'slurm' ? 'slurm' : 'direct_ssh'
}

export const computeJobDriverId = (job: Pick<ComputeJob, 'execution_mode'>): ComputeDriverId =>
  job.execution_mode === 'slurm' ? 'slurm' : 'direct_ssh'
