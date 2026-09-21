import { parentPort, workerData } from 'node:worker_threads'
import { executeArchiveTask, type ArchiveTask } from './archive-task-core'
try {
  parentPort?.postMessage({ ok: true, result: executeArchiveTask(workerData as ArchiveTask) })
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  })
}
