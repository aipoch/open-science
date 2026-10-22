import type { PackageProgress } from '../../shared/session-package'
import { parentPort, workerData } from 'node:worker_threads'
import { inspectSessionPackage } from './inspection'
import { withFileIoPacing } from '../file-io-pacing'
import { PackageCapacityError } from './capacity'
import type { InspectionWorkerInput, InspectionWorkerMessage } from './inspection-worker'

if (!parentPort) throw new Error('Session package inspection requires a worker.')
const port = parentPort
const input = workerData as InspectionWorkerInput
const grants = new Map<number, () => void>()
let sequence = 0
port.on('message', ({ id }: { id: number }) => {
  const grant = grants.get(id)
  grants.delete(id)
  grant?.()
})
const post = (message: InspectionWorkerMessage): void => port.postMessage(message)
let lastProgressAt = 0
let previousStage = ''
const reportProgress = (progress: PackageProgress): void => {
  const stage =
    progress.totalBytes !== undefined
      ? 'reading'
      : progress.totalFiles !== undefined
        ? 'files'
        : 'records'
  const complete =
    progress.totalBytes !== undefined
      ? progress.completedBytes === progress.totalBytes
      : progress.totalFiles !== undefined && progress.completedFiles === progress.totalFiles
  const now = performance.now()
  if (stage !== previousStage || complete || now - lastProgressAt >= 150) {
    previousStage = stage
    lastProgressAt = now
    post({ kind: 'progress', progress })
  }
}
void withFileIoPacing(
  (bytes) =>
    new Promise<void>((resolve) => {
      const id = sequence++
      grants.set(id, resolve)
      post({ kind: 'pace', id, bytes })
    }),
  () =>
    inspectSessionPackage(
      input.path,
      input.directory,
      new AbortController().signal,
      input.temporaryRoot,
      reportProgress
    )
)
  .then(
    (preview) => post({ kind: 'result', preview }),
    (error: unknown) =>
      post({
        kind: 'error',
        message: (error instanceof Error
          ? error.message
          : 'Session package inspection failed.'
        ).slice(0, 8192),
        ...(error instanceof PackageCapacityError
          ? {
              capacity: {
                directory: error.directory,
                requiredBytes: error.requiredBytes,
                freeBytes: error.freeBytes
              }
            }
          : {})
      })
  )
  .finally(() => port.close())
