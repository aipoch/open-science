import { parentPort, workerData } from 'node:worker_threads'

import {
  parseNativePdfAnnotationsOnCurrentThread,
  type NativePdfAnnotationProgress
} from './native-import-core'

type WorkerInput = Readonly<{ filePath: string }>
type WorkerMessage =
  | Readonly<{ kind: 'progress'; progress: NativePdfAnnotationProgress }>
  | Readonly<{
      kind: 'result'
      result: Awaited<ReturnType<typeof parseNativePdfAnnotationsOnCurrentThread>>
    }>
  | Readonly<{ kind: 'error'; name?: string; message: string }>

if (parentPort) {
  const input = workerData as WorkerInput
  const post = (message: WorkerMessage): void => parentPort!.postMessage(message)

  void parseNativePdfAnnotationsOnCurrentThread(input.filePath, {
    onProgress: (progress) => post({ kind: 'progress', progress })
  }).then(
    (result) => post({ kind: 'result', result }),
    (error: unknown) =>
      post({
        kind: 'error',
        ...(error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
          ? { name: error.name }
          : {}),
        message: error instanceof Error ? error.message : 'Native PDF annotation import failed.'
      })
  )
}
