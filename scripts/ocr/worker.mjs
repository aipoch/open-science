/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createWorker } from 'tesseract.js'

const asset = (name) => fileURLToPath(new URL(name, import.meta.url))
let engine
parentPort.on('message', async (image) => {
  try {
    engine ??= await createWorker(
      ['eng', 'chi_sim'].map((code) => ({
        code,
        data: readFileSync(asset(`${code}.traineddata.gz`))
      })),
      1,
      {
        workerPath: asset('ocr-engine.mjs'),
        cacheMethod: 'none',
        gzip: true,
        errorHandler: () => {}
      }
    )
    const { data } = await engine.recognize(Buffer.from(image))
    parentPort.postMessage({ text: data.text.slice(0, 1000000), confidence: data.confidence })
  } catch {
    parentPort.postMessage({ error: true })
  }
})
