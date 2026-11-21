const { Worker } = require('node:worker_threads')

// One native decoder and full-resolution comparison at a time across all sessions.
let busy = false
async function vectorizeImage(bytes, { ocr, signal, preserveRegion } = {}) {
  signal?.throwIfAborted()
  if (busy) throw new Error('Image conversion is busy. Retry after the current export finishes.')
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Image exceeds the conversion size limit.')
  const worker = new Worker(require.resolve('./worker.cjs'), {
    workerData: { bytes, ocr, preserveRegion },
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256 }
  })
  busy = true
  let abort
  const lifetime = AbortSignal.timeout(90000)
  const stop = signal ? AbortSignal.any([signal, lifetime]) : lifetime
  try {
    const result = await new Promise((resolve, reject) => {
      abort = () => reject(stop.reason)
      stop.addEventListener('abort', abort, { once: true })
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('Image conversion stopped before export.')))
      worker.once('message', resolve)
      if (stop.aborted) abort()
    })
    return {
      detail: result.detail,
      mimeType: result.mimeType,
      content: result.bytes ? Buffer.from(result.bytes) : bytes
    }
  } finally {
    stop.removeEventListener('abort', abort)
    try {
      await worker.terminate()
    } finally {
      busy = false
    }
  }
}
module.exports = { vectorizeImage }
