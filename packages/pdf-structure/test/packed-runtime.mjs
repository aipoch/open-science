/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, copyFile, readFile, stat, access, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPdfStructureEngine } from '@aipoch/pdf-structure'
import { parsePdfStructureResult, decodePdfStructureResult } from '@aipoch/pdf-structure/result'

await assert.rejects(import('@aipoch/pdf-structure/src/engine.js'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
})
assert.throws(() => decodePdfStructureResult({}))
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const assets = option('--model-assets')
const pdf = option('--pdf')
assert.equal(Boolean(assets), Boolean(pdf), 'Supply both --model-assets and --pdf')
const engine = createPdfStructureEngine({ modelRecipe: { revision: 'packed-consumer-v1' } })
const recipe = await engine.describe()
assert.match(recipe.fingerprint, /^[a-f0-9]{64}$/)
const root = await mkdtemp(join(tmpdir(), 'pdf-packed-worker-'))
let stopped = true
try {
  const inputPath = join(root, 'input.pdf')
  if (pdf) await copyFile(pdf, inputPath)
  else await writeFile(inputPath, '%PDF-1.7\ninvalid worker smoke input')
  const bytes = await readFile(inputPath)
  const identity = {
    extractionId: randomUUID(),
    sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
    sourceSizeBytes: bytes.length,
    engineFingerprint: recipe.fingerprint,
    requestedPages: [Number(option('--page') ?? 1)]
  }
  const runtimePath = join(assets ?? root, 'ort.wasm.min.mjs')
  const model = {
    revision: recipe.modelRevision,
    assets: [
      {
        file: 'ort.wasm.min.mjs',
        path: runtimePath,
        size: assets ? (await stat(runtimePath)).size : 1,
        sha256: '0'.repeat(64)
      }
    ]
  }
  const controller = new AbortController()
  const progress = []
  const job = engine.start({
    inputPath,
    identity,
    model,
    signal: controller.signal,
    onProgress: (event) => progress.push(event.phase)
  })
  stopped = false
  try {
    if (pdf) {
      const value = parsePdfStructureResult(await job.result, identity)
      assert.equal(value.pageCount > 0, true)
      if (process.argv.includes('--expect-elements')) assert(value.elements.length > 0)
      for (const thumbnail of value.thumbnails) assert(job.thumbnails.has(thumbnail.id))
      assert.deepEqual(progress, ['extracting', 'complete'])
      console.log(
        JSON.stringify({
          pageCount: value.pageCount,
          elements: value.elements.length,
          thumbnails: value.thumbnails.length
        })
      )
    } else {
      // A real worker must reject malformed input and still confirm cleanup.
      await assert.rejects(job.result)
    }
  } finally {
    await job.stop()
    await job.stop()
    stopped = true
  }
  await assert.rejects(access(join(root, 'extractor')), { code: 'ENOENT' })
  const cancel = new AbortController()
  const cancelled = engine.start({
    inputPath,
    identity,
    model,
    signal: cancel.signal,
    onProgress: () => undefined
  })
  stopped = false
  cancel.abort()
  await assert.rejects(cancelled.result, { name: 'AbortError' })
  await cancelled.stop()
  stopped = true
  console.log('Real worker completed/error handled, cancellation and cleanup confirmed.')
} finally {
  // An unconfirmed stop must retain the snapshot for diagnosis/retry.
  if (stopped) await rm(root, { recursive: true, force: true })
}
