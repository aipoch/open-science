import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { analyzeNotebookCodeRisk } from '@aipoch/notebook-code-risk'
import { analyzePythonNotebookSource } from '@aipoch/notebook-analysis'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const worker = vi.hoisted(() => ({ path: '', created: 0 }))
vi.mock('./source-analysis-worker-entry?nodeWorker', () => ({
  default: (options: ConstructorParameters<typeof Worker>[1]) => {
    worker.created++
    return new Worker(worker.path, options)
  }
}))

import {
  analyzeNotebookCodeRiskOffMainThread,
  analyzeNotebookSourceOffMainThread,
  SOURCE_ANALYSIS_WORKER_MIN_BYTES
} from './source-analysis-worker'

let directory: string | undefined
beforeAll(async () => {
  // Keep node_modules visible to the bundled worker's external package imports.
  const cache = resolve('node_modules/.cache')
  await mkdir(cache, { recursive: true })
  directory = await mkdtemp(join(cache, 'source-analysis-worker-'))
  worker.path = join(directory, 'worker.cjs')
  await build({
    entryPoints: ['src/main/notebook/source-analysis-worker-entry.ts'],
    outfile: worker.path,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external'
  })
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

const cell = (bytes: number): string => {
  const block = "import shutil\ndf = pd.read_csv('data/in.csv')\nshutil.rmtree('data/out')\n"
  return block.repeat(Math.ceil(bytes / block.length))
}

it('runs large sources in the worker with the same results as the main thread', async () => {
  const large = cell(SOURCE_ANALYSIS_WORKER_MIN_BYTES)
  const context = { workingDirectory: resolve('.') }
  await expect(analyzeNotebookCodeRiskOffMainThread('python', large, context)).resolves.toEqual(
    await analyzeNotebookCodeRisk('python', large, context)
  )
  const fileContext = { staticStrings: [], staticCollections: [], localFileWrappers: [] }
  await expect(analyzeNotebookSourceOffMainThread('python', large, fileContext)).resolves.toEqual(
    await analyzePythonNotebookSource(large, fileContext)
  )
  expect(worker.created).toBe(1)

  await analyzeNotebookCodeRiskOffMainThread('python', cell(1024), context)
  expect(worker.created).toBe(1)
})

it('rejects a cancelled worker analysis without waiting for the worker', async () => {
  const controller = new AbortController()
  const analysis = analyzeNotebookCodeRiskOffMainThread(
    'python',
    cell(4 * SOURCE_ANALYSIS_WORKER_MIN_BYTES),
    { workingDirectory: resolve('.') },
    undefined,
    controller.signal
  )
  controller.abort()
  // The worker cannot reply before the next macrotask, so only a cancelled request settles first.
  const settled = await Promise.race([
    analysis.catch((error: Error) => error.name),
    new Promise((resolve) => setImmediate(() => resolve('pending')))
  ])
  expect(settled).toBe('AbortError')
})
