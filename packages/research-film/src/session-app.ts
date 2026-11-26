import { Worker } from 'node:worker_threads'
import type { SessionAppBundle } from './session-app-bundle.js'
export type { SessionAppDescription, SessionAppBundle } from './session-app-bundle.js'

export async function prepareFilmSessionApp(
  bytes: Uint8Array,
  name: string,
  signal: AbortSignal
): Promise<SessionAppBundle | undefined> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./session-app-worker.js', import.meta.url), {
    workerData: { bytes, name },
    resourceLimits: { maxOldGenerationSizeMb: 256 }
  })
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  let abort: () => void
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(deadline.reason)
      deadline.addEventListener('abort', abort, { once: true })
      worker.once('message', (result: SessionAppBundle | null) => resolve(result ?? undefined))
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('App bundling stopped before completion.')))
      if (deadline.aborted) abort()
    })
  } finally {
    deadline.removeEventListener('abort', abort!)
    await worker.terminate()
  }
}
