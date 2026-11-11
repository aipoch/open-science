/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile } from 'node:fs/promises'
import { createWorker } from 'tesseract.js'

import { Worker, parentPort, workerData } from 'node:worker_threads'

// Isolate initialization too: Tesseract does not always settle createWorker when
// language initialization fails. Terminating this wrapper stops its nested worker.
if (workerData?.scanOcr) {
  const { options, image } = workerData.scanOcr
  try {
    const languages = await Promise.all(
      options.languages.map(async (code) => ({
        code,
        data: new Uint8Array(await readFile(options.languageAssets[code]))
      }))
    )
    const current = await createWorker(languages, 1, {
      workerPath: options.enginePath,
      cacheMethod: 'none',
      errorHandler: (error) => parentPort.postMessage({ error: String(error) })
    })
    const { data } = await current.recognize(image, {}, { text: true, tsv: true })
    parentPort.postMessage({ data: { confidence: data.confidence, tsv: data.tsv } })
  } catch (error) {
    parentPort.postMessage({ error: String(error) })
  }
}

// Bound optional OCR across the entire extraction batch, preserving time for the
// non-OCR result within the supervisor's existing execution deadline.
let deadline
export function createScanOcr(options) {
  let worker,
    closed = false
  const close = async () => {
    closed = true
    if (worker) await worker.terminate()
  }
  return {
    close,
    async recognize(image, width, height, bounds) {
      if (!options || closed) return
      deadline ??= Date.now() + 30000
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      let timer
      try {
        const result = await new Promise((resolve) => {
          worker = new Worker(new URL(import.meta.url), {
            workerData: { scanOcr: { options, image } },
            execArgv: []
          })
          worker.once('message', (message) => resolve(message.data))
          worker.once('error', () => resolve(undefined))
          worker.once('exit', () => resolve(undefined))
          timer = setTimeout(() => resolve(undefined), remaining)
        })
        if (
          !result ||
          !Number.isFinite(result.confidence) ||
          result.confidence < 50 ||
          typeof result.tsv !== 'string' ||
          result.tsv.length > 1000000
        )
          return
        const tokens = []
        for (const row of result.tsv.split('\n').slice(1)) {
          const fields = row.split('\t')
          if (fields[0] !== '5') continue
          const [x, y, w, h, confidence] = fields.slice(6, 11).map(Number),
            text = fields.slice(11).join('\t').trim()
          if (!text) continue
          if (
            ![x, y, w, h, confidence].every(Number.isFinite) ||
            confidence < 0 ||
            confidence > 100 ||
            x < 0 ||
            y < 0 ||
            w <= 0 ||
            h <= 0 ||
            x + w > width ||
            y + h > height ||
            tokens.length >= 20000
          )
            return
          tokens.push({
            text,
            confidence,
            rect: [
              (x / width) * bounds.width,
              (y / height) * bounds.height,
              ((x + w) / width) * bounds.width,
              ((y + h) / height) * bounds.height
            ]
          })
        }
        return tokens.length ? tokens : undefined
      } catch {
        return
      } finally {
        clearTimeout(timer)
        await close()
      }
    }
  }
}
