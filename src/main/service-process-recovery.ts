import { realpathSync } from 'node:fs'
import { DelegatedProcessOwnership } from './delegation/process-ownership'
import { KernelProcessLifecycleOwner } from './notebook/kernel-process-lifecycle.windows-posix'
import { acquireRuntimeDirectorySync, type RuntimeDirectoryLease } from './runtime-ownership'

export class StoppedServiceProcessRecoveryError extends Error {
  constructor(
    readonly code: 'service-process-recovery-incomplete' | 'service-process-recovery-timeout',
    message: string,
    options?: ErrorOptions,
    readonly settlement?: Promise<void>
  ) {
    super(message, options)
    this.name = 'StoppedServiceProcessRecoveryError'
  }
}

/** Called only after exact service exit and Config Root lock ownership have been established. */
export async function recoverStoppedServiceProcesses(options: {
  configRoot: string
  dataRoot: string
  lease: RuntimeDirectoryLease
  deadlineAt: number
}): Promise<void> {
  if (realpathSync(options.configRoot) !== options.lease.directory)
    throw new Error('Stopped service recovery requires the matching Config Root lease.')
  if (Date.now() >= options.deadlineAt)
    throw new Error('Stopped service process recovery deadline expired.')
  const dataRoot = realpathSync(options.dataRoot)
  const dataLease =
    dataRoot === options.lease.directory ? undefined : acquireRuntimeDirectorySync(dataRoot)
  let timer: ReturnType<typeof setTimeout> | undefined
  const recovery = (async () => {
    try {
      if (Date.now() >= options.deadlineAt)
        throw new Error('Stopped service process recovery deadline expired.')
      // These owners already validate birth identities, POSIX groups/markers, Windows Jobs and
      // kernel receipts. Unknown ownership remains recorded and makes strict recovery fail.
      const outcomes = await Promise.allSettled([
        new DelegatedProcessOwnership(
          options.lease.directory,
          'main-agent-process-ownership'
        ).recover(),
        new DelegatedProcessOwnership(dataRoot).recover(),
        new KernelProcessLifecycleOwner({ storageRoot: dataRoot }).recover()
      ])
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : []
      )
      if (failures.length)
        throw new StoppedServiceProcessRecoveryError(
          'service-process-recovery-incomplete',
          'Stopped service process recovery is incomplete.',
          { cause: new AggregateError(failures) }
        )
    } finally {
      // A timed-out caller must not let a replacement service race a still-running reaper.
      dataLease?.release()
    }
  })()
  try {
    await Promise.race([
      recovery,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new StoppedServiceProcessRecoveryError(
                'service-process-recovery-timeout',
                'Stopped service process recovery deadline expired.',
                undefined,
                recovery.then(
                  () => undefined,
                  () => undefined
                )
              )
            ),
          Math.max(0, options.deadlineAt - Date.now())
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
