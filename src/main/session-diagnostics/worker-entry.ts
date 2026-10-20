import { parentPort, workerData } from 'node:worker_threads'
import { runSessionDiagnosticWorker } from './collector'
import type { SessionDiagnosticWorkerInput } from '../../shared/session-diagnostics'

void runSessionDiagnosticWorker(workerData as SessionDiagnosticWorkerInput).then((result) => {
  parentPort?.postMessage(result)
})
