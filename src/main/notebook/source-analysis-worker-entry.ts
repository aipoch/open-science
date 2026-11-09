import { parentPort } from 'node:worker_threads'
import { runSourceAnalysis, type SourceAnalysisRequest } from './source-analysis-request'

parentPort?.on('message', ({ id, request }: { id: number; request: SourceAnalysisRequest }) => {
  runSourceAnalysis(request).then(
    (result) => parentPort!.postMessage({ id, result }),
    (error: unknown) =>
      parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  )
})
