import { Worker } from 'node:worker_threads'
import { researchFilmResources } from './resources.js'
import type { SpeechReply, SpeechRequest } from './speech-client.js'

// Only threads run ONNX. This event loop stays free to stop the process if its parent disappears.
const stop = (): void => {
  try {
    process.kill(process.pid, 'SIGKILL')
  } catch {
    process.exit(1)
  }
}
process.once('disconnect', stop)
if (!process.connected) stop()

const workers = new Map<number, Worker>()
const send = (message: SpeechReply): void => {
  if (process.connected)
    process.send?.(message, (error) => {
      if (error) stop()
    })
}
process.on('message', ({ input, ...request }: SpeechRequest) => {
  const { lane } = request
  const fail = (error: Error): void => {
    send({
      kind: 'error',
      lane,
      message: error.message,
      code: (error as NodeJS.ErrnoException).code
    })
  }
  try {
    let worker = workers.get(lane)
    if (!worker) {
      worker = new Worker(researchFilmResources().workerPath, {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
        workerData: input
      })
      workers.set(lane, worker)
      worker.on('message', (message: SpeechReply) => send({ ...message, lane }))
      worker.once('error', fail)
      worker.once('exit', (code) => fail(new Error(`Film narration worker exited (${code}).`)))
    }
    worker.postMessage(request)
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
  }
})
