/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { parentPort, workerData } from 'node:worker_threads'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorker } from 'tesseract.js'

const asset = (name) => fileURLToPath(new URL(name, import.meta.url))
let engine
let languagePath
let temporaryLanguagePath
parentPort.on('message', async (image) => {
  try {
    const languageAssets = workerData?.languageAssets ?? {}
    // Tesseract's first language biases mixed-text recognition; keep Chinese ahead of English.
    const languages = [...(workerData?.languages ?? ['eng', 'chi_sim'])].sort(
      (left, right) => Number(right === 'chi_sim') - Number(left === 'chi_sim')
    )
    const paths = languages.map((code) => languageAssets[code] ?? asset(`${code}.traineddata.gz`))
    const directories = new Set(paths.map((path) => dirname(path)))
    if (!languagePath) {
      if (directories.size === 1) languagePath = [...directories][0]
      else {
        languagePath = mkdtempSync(join(tmpdir(), 'open-science-ocr-'))
        temporaryLanguagePath = languagePath
        process.once('exit', () => rmSync(temporaryLanguagePath, { recursive: true, force: true }))
        languages.forEach((code, index) =>
          copyFileSync(paths[index], join(languagePath, `${code}.traineddata.gz`))
        )
      }
    }
    engine ??= await createWorker(languages.join('+'), 1, {
      workerPath: asset('ocr-engine.mjs'),
      langPath: languagePath,
      cacheMethod: 'none',
      gzip: true,
      errorHandler: () => {}
    })
    const { data } = await engine.recognize(Buffer.from(image))
    parentPort.postMessage({ text: data.text.slice(0, 1000000), confidence: data.confidence })
  } catch {
    parentPort.postMessage({ error: true })
  }
})
