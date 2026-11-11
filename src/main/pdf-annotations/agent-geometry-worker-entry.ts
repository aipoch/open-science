import { parentPort, workerData } from 'node:worker_threads'
import { locatePdfAnnotationGeometry, type PdfAnnotationGeometryInput } from './agent-geometry-core'

if (parentPort) {
  void locatePdfAnnotationGeometry(workerData as PdfAnnotationGeometryInput).then(
    (result) => parentPort!.postMessage({ result }),
    () =>
      parentPort!.postMessage({
        error: 'PDF_ANNOTATION_TARGET_UNAVAILABLE: The PDF target could not be located reliably.'
      })
  )
}
