import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createPdfStructureEngine } from './engine'
import { readWorkerResult } from './worker-result'

vi.mock('./worker-result', () => ({ readWorkerResult: vi.fn() }))
const roots: string[] = []
it('resolves the actual engine recipe with the installed package exports', async () => {
  const recipe = await createPdfStructureEngine(
    join(process.cwd(), 'resources', 'pdf-structure')
  ).describe()
  expect(recipe.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(recipe.modelRevision).toBe('pdf-figures-tables-v1')
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
  const handle = createPdfStructureEngine(root).start({
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
  await vi.waitFor(() => expect(readWorkerResult).toHaveBeenCalledOnce())
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
})
