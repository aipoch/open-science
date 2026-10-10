import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createEngineAt } from '../src/engine.js'
import { createPdfStructureEngine } from '../src/index.js'
const modelRecipe = { revision: 'test' }
import { readWorkerResult } from '../src/worker-result.js'

vi.mock('../src/worker-result.js', () => ({ readWorkerResult: vi.fn() }))
const roots: string[] = []
it('resolves the actual engine recipe with the installed package exports', async () => {
  const recipe = await createPdfStructureEngine({ modelRecipe }).describe()
  expect(recipe.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(recipe.modelRevision).toBe('test')
})
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  vi.clearAllMocks()
})
it('joins main-process result conversion before deleting scratch after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-stop-'))
  roots.push(root)
  await mkdir(join(root, 'job'))
  await writeFile(
    join(root, 'host.mjs'),
    `import {mkdir} from 'node:fs/promises'; process.stdin.once('data', async chunk => { const request=JSON.parse(chunk); await mkdir(request.output); process.exit(0) })`
  )
  await writeFile(
    join(root, 'scratch.mjs'),
    `import {rmdir} from 'node:fs/promises'; export async function inspectScratch(root, remove) { if (remove) await rmdir(root); return 0 }`
  )
  let rejectConversion!: (error: Error) => void
  vi.mocked(readWorkerResult).mockImplementation(
    () =>
      new Promise((_, reject) => {
        rejectConversion = reject
      })
  )
  const controller = new AbortController()
  const handle = createEngineAt(root, { modelRecipe }).start({
    inputPath: join(root, 'job/input.pdf'),
    model: {
      revision: 'test',
      assets: [
        {
          file: 'ort.wasm.min.mjs',
          path: join(root, 'ort.wasm.min.mjs'),
          size: 1,
          sha256: 'a'.repeat(64)
        }
      ]
    },
    identity: {
      extractionId: 'job',
      sourceChecksum: 'a'.repeat(64),
      engineFingerprint: 'b'.repeat(64),
      sourceSizeBytes: 1,
      requestedPages: [1]
    },
    signal: controller.signal,
    onProgress: () => undefined
  })
  // This waits for a real Node process; startup under suite load can exceed
  // waitFor's one-second default before result conversion even begins.
  await vi.waitFor(() => expect(readWorkerResult).toHaveBeenCalledOnce(), { timeout: 5_000 })
  controller.abort()
  let stopped = false
  const stopping = handle.stop().then(() => {
    stopped = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(stopped).toBe(false)
  expect((await stat(join(root, 'job/extractor'))).isDirectory()).toBe(true)
  rejectConversion(new Error('conversion cancelled'))
  await expect(handle.result).rejects.toThrow('conversion cancelled')
  await stopping
  await expect(stat(join(root, 'job/extractor'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 10_000)

it('retains the stop handle when the initial progress observer throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-observer-'))
  roots.push(root)
  await writeFile(join(root, 'host.mjs'), 'setInterval(() => {}, 1000)')
  await writeFile(join(root, 'scratch.mjs'), 'export async function inspectScratch() { return 0 }')
  const { nodeProcessRuntime } = await import('../src/node-runtime.js')
  const runtime = { ...nodeProcessRuntime, stop: vi.fn(nodeProcessRuntime.stop) }
  const job = createEngineAt(root, { modelRecipe, runtime }).start({
    ...requestAt(root),
    onProgress: () => {
      throw new Error('observer failed')
    }
  })
  await expect(job.result).rejects.toThrow('observer failed')
  await job.stop()
  expect(runtime.stop).toHaveBeenCalledOnce()
})

it('retains scratch and retries when termination cannot be confirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-retry-'))
  roots.push(root)
  await mkdir(join(root, 'extractor'))
  await writeFile(join(root, 'host.mjs'), 'setInterval(() => {}, 1000)')
  await writeFile(
    join(root, 'scratch.mjs'),
    `import { rmdir } from 'node:fs/promises'; export async function inspectScratch(path) { await rmdir(path) }`
  )
  const { nodeProcessRuntime } = await import('../src/node-runtime.js')
  const runtime = {
    ...nodeProcessRuntime,
    stop: vi.fn(nodeProcessRuntime.stop).mockRejectedValueOnce(new Error('termination uncertain'))
  }
  const job = createEngineAt(root, { modelRecipe, runtime }).start(requestAt(root))
  await expect(job.stop()).rejects.toThrow('termination uncertain')
  expect((await stat(join(root, 'extractor'))).isDirectory()).toBe(true)
  await job.stop()
  await expect(job.result).rejects.toThrow('PDF extraction failed')
  await expect(stat(join(root, 'extractor'))).rejects.toMatchObject({ code: 'ENOENT' })
  await job.stop()
  expect(runtime.stop).toHaveBeenCalledTimes(2)
})

const requestAt = (root: string): Parameters<ReturnType<typeof createEngineAt>['start']>[0] => ({
  inputPath: join(root, 'input.pdf'),
  model: {
    revision: 'test',
    assets: [
      {
        file: 'ort.wasm.min.mjs',
        path: join(root, 'ort.wasm.min.mjs'),
        size: 1,
        sha256: 'a'.repeat(64)
      }
    ]
  },
  identity: {
    extractionId: 'job',
    sourceChecksum: 'a'.repeat(64),
    engineFingerprint: 'b'.repeat(64),
    sourceSizeBytes: 1,
    requestedPages: [1]
  },
  signal: new AbortController().signal,
  onProgress: () => undefined
})
