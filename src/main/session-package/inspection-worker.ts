import type { Worker, WorkerOptions } from 'node:worker_threads'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionPackagePreview } from '../../shared/session-package'
import { PackageCapacityError } from './capacity'
import { PackageCleanupPendingError, withPackageCleanup } from './cleanup'
import { withPackageTransfer } from './transfer'
import type { inspectSessionPackage } from './inspection'

export type InspectionWorkerInput = {
  path: string
  directory: string
  temporaryRoot: string
}
export type InspectionWorkerMessage =
  | { kind: 'pace'; id: number; bytes: number }
  | { kind: 'result'; preview: SessionPackagePreview }
  | {
      kind: 'error'
      message: string
      capacity?: { directory: string; requiredBytes: number; freeBytes: number }
    }

// The composition root supplies electron-vite's bundled worker constructor. Neither application
// DB access nor a Session graph crosses this boundary; the caller owns source staging.
export const createPackageInspector =
  (createWorker: (options: WorkerOptions) => Worker): typeof inspectSessionPackage =>
  async (path, directory, signal) =>
    withPackageTransfer(async (transfer) => {
      signal = AbortSignal.any([signal, transfer.signal])
      signal.throwIfAborted()
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporaryRoot = await mkdtemp(join(directory, '.inspection-'))
      try {
        return await withPackageCleanup(
          async () => {
            signal.throwIfAborted()
            const worker = createWorker({
              execArgv: [],
              resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 32 },
              workerData: { path, directory, temporaryRoot } satisfies InspectionWorkerInput
            })
            let active = true
            let detach = (): void => undefined
            try {
              return await new Promise<SessionPackagePreview>((resolve, reject) => {
                const abort = (): void => reject(signal.reason)
                const exited = (): void => reject(new Error('Session package inspection stopped.'))
                const message = (value: InspectionWorkerMessage): void => {
                  if (!active) return
                  if (value.kind === 'result') resolve(value.preview)
                  else if (value.kind === 'error') {
                    const capacity = value.capacity
                    reject(
                      capacity
                        ? new PackageCapacityError(
                            capacity.directory,
                            capacity.requiredBytes,
                            capacity.freeBytes,
                            new Error(value.message)
                          )
                        : new Error(value.message)
                    )
                  } else if (value.kind === 'pace') {
                    // Use the parent's live rate, speed meter and inactivity budget. AsyncLocalStorage
                    // does not propagate into workers; each request waits for this explicit grant.
                    void transfer
                      .pace(value.bytes, signal)
                      .then(() => {
                        if (active) worker.postMessage({ id: value.id })
                      })
                      .catch(reject)
                  }
                }
                signal.addEventListener('abort', abort, { once: true })
                worker.on('message', message)
                worker.once('error', reject)
                worker.once('exit', exited)
                detach = () => {
                  signal.removeEventListener('abort', abort)
                  worker.off('message', message)
                  worker.off('error', reject)
                  worker.off('exit', exited)
                }
                if (signal.aborted) abort()
              })
            } finally {
              active = false
              // A terminated worker cannot run finally reliably. Join it before deleting any of
              // its files, including temporary Prisma databases and sidecars.
              await worker.terminate()
              detach()
            }
          },
          () => rm(temporaryRoot, { recursive: true, force: true })
        )
      } catch (error) {
        if (error instanceof PackageCleanupPendingError && 'value' in error.outcome) {
          // Inspection is an intermediate step: a cleanup failure must not masquerade as a
          // successfully published import when the desktop unwraps cleanup-pending outcomes.
          throw new PackageCleanupPendingError(
            { error: new Error('Session package inspection cleanup failed.') },
            error.retryCleanup,
            error
          )
        }
        throw error
      }
    })
