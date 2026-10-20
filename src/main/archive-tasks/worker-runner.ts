import type { Worker, WorkerOptions } from 'node:worker_threads'

// Bound concurrency: importing a bundle must not spawn one memory-heavy worker per contained skill.
// The Node backend retains candidate/transaction ownership. Inputs are cloned, never transferred/detached.
let tail: Promise<unknown> = Promise.resolve()
export const runArchiveTask = <T>(
  createWorker: (options: WorkerOptions) => Worker,
  task: unknown
): Promise<T> => {
  const pending = tail.then(
    () =>
      new Promise<T>((resolve, reject) => {
        const worker = createWorker({
          workerData: task,
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 1024 }
        })
        let settled = false
        const finish = (error?: Error, result?: T): void => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          void worker.terminate().then(() => {
            if (error) reject(error)
            else resolve(result!)
          }, reject)
        }
        const timeout = setTimeout(() => finish(new Error('Archive task timed out.')), 60_000)
        worker.once('message', (message: { ok: boolean; result?: T; error?: string }) =>
          finish(message.ok ? undefined : new Error(message.error), message.result)
        )
        worker.once('error', (error) => finish(error))
        worker.once('exit', () => {
          if (!settled) finish(new Error('Archive worker exited without a result.'))
        })
      })
  )
  tail = pending.catch(() => undefined)
  return pending
}
