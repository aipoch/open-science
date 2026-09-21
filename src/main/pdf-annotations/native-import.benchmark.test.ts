import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseNativePdfAnnotations } from './native-import'

const cases = ([100, 500, 1000] as const).map((pages) => ({
  pages,
  path: process.env[`PDF_BENCHMARK_${pages}`]
}))
let directory: string | undefined
let workerPath: string
const measurements: Record<string, unknown>[] = []

beforeAll(async () => {
  // Keep node_modules visible to the bundled worker's external PDF.js import. This exercises a
  // real Node worker without depending on electron-vite's ?nodeWorker transform inside Vitest.
  const cache = resolve('node_modules/.cache')
  await mkdir(cache, { recursive: true })
  directory = await mkdtemp(join(cache, 'pdf-native-benchmark-'))
  workerPath = join(directory, 'worker.mjs')
  await build({
    entryPoints: ['src/main/pdf-annotations/native-import-worker-entry.ts'],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external'
  })
})
afterAll(async () => {
  if (process.env.PDF_BENCHMARK_OUTPUT)
    await writeFile(process.env.PDF_BENCHMARK_OUTPUT, JSON.stringify(measurements, null, 2))
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('native PDF annotation import benchmark (real caller-provided PDFs)', () => {
  for (const { pages, path } of cases) {
    it.skipIf(!path || !existsSync(path))(
      `${pages} pages: current thread versus worker`,
      async () => {
        for (let run = 0; run < 3; run += 1) {
          for (const mode of run % 2
            ? ['worker', 'current-thread']
            : ['current-thread', 'worker']) {
            let lastTick = performance.now()
            let maxEventLoopDelayMs = 0
            const timer = setInterval(() => {
              const now = performance.now()
              maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now - lastTick - 10)
              lastTick = now
            }, 10)
            const started = performance.now()
            const cpuStarted = process.cpuUsage()
            try {
              const result = await parseNativePdfAnnotations(resolve(path!), {
                execution: mode as 'worker' | 'current-thread',
                createWorker: (options) => new Worker(workerPath, options)
              })
              const elapsedMs = performance.now() - started
              const cpu = process.cpuUsage(cpuStarted)
              await new Promise((resolve) => setTimeout(resolve, 20))
              expect(result.pageCount, 'The fixture must have the advertised page count').toBe(
                pages
              )
              const measurement = {
                benchmark: 'pdf-native-annotation-import',
                pages,
                run,
                mode,
                elapsedMs: Math.round(elapsedMs),
                processCpuMs: Math.round((cpu.user + cpu.system) / 1000),
                maxEventLoopDelayMs: Math.round(maxEventLoopDelayMs),
                annotations: result.annotations.length,
                unsupported: result.unsupportedCount,
                truncated: result.truncated
              }
              measurements.push(measurement)
              console.info(JSON.stringify(measurement))
            } finally {
              clearInterval(timer)
            }
          }
        }
      },
      120_000
    )
  }
})

it('runs the bundled native parser in a real worker and preserves a foreign sticky note', async () => {
  const document = await PDFDocument.create()
  const page = document.addPage([200, 200])
  page.node.set(
    PDFName.of('Annots'),
    document.context.obj([
      document.context.register(
        document.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [10, 10, 30, 30],
          Contents: PDFString.of('External native note')
        })
      )
    ])
  )
  const path = join(directory!, 'worker-smoke.pdf')
  await writeFile(path, await document.save())
  const progress = [] as unknown[]
  const result = await parseNativePdfAnnotations(path, {
    onProgress: (event) => progress.push(event),
    createWorker: (options) => new Worker(workerPath, options)
  })
  expect(result).toMatchObject({
    pageCount: 1,
    unsupportedCount: 0,
    annotations: [expect.objectContaining({ subtype: 'Text', note: 'External native note' })]
  })
  expect(progress).toContainEqual({
    pagesProcessed: 1,
    pageCount: 1,
    annotationsFound: 1,
    unsupportedCount: 0
  })
})
