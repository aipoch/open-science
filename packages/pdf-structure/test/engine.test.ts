import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createEngineAt } from '../src/engine.js'
import { createPdfStructureEngine } from '../src/index.js'
const modelRecipe = { revision: 'test' }
import { readWorkerResult } from '../src/worker-result.js'
import { isPdfStructureResourceLimitError } from '../src/errors.js'

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
  await vi.waitFor(() => expect(readWorkerResult).toHaveBeenCalledOnce(), { timeout: 15_000 })
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
}, 30_000)

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

it.each([
  { label: 'empty stderr', stderr: '' },
  { label: 'bounded stderr tail', stderr: 'discarded-head:' + 'x'.repeat(5000) + ':kept-tail' }
])('retains actual exit diagnostics with $label', async ({ stderr }) => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-exit-'))
  roots.push(root)
  await writeFile(
    join(root, 'host.mjs'),
    'process.stdin.once("data", () => process.stderr.write(' +
      JSON.stringify(stderr) +
      ', () => process.exit(37)))'
  )
  await writeFile(join(root, 'scratch.mjs'), 'export async function inspectScratch() { return 0 }')
  const job = createEngineAt(root, { modelRecipe }).start(requestAt(root))
  const error = await job.result.catch((error: unknown) => error)
  await job.stop()
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toBe(
    (stderr.slice(-4000).trim() || 'PDF extraction failed.') + ' (exitCode=37, signal=null)'
  )
  expect((error as Error).stack).toContain('(exitCode=37, signal=null)')
  expect(message).not.toContain('discarded-head:')
  expect(readWorkerResult).not.toHaveBeenCalled()
})

it('classifies a host resource-limit failure for an explicit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-resource-limit-'))
  roots.push(root)
  await writeFile(
    join(root, 'host.mjs'),
    'process.stdin.once("data", () => process.stderr.write("PDF execution resource limit exceeded.", () => process.exit(1)))'
  )
  await writeFile(join(root, 'scratch.mjs'), 'export async function inspectScratch() { return 0 }')
  const job = createEngineAt(root, { modelRecipe }).start(requestAt(root))
  const error = await job.result.catch((value: unknown) => value)
  await job.stop()
  expect(isPdfStructureResourceLimitError(error)).toBe(true)
  expect(error).toMatchObject({ code: 'PDF_RESOURCE_LIMIT' })
  expect((error as Error).message).toContain('PDF execution resource limit exceeded.')
})

it('classifies a host deadline failure for an explicit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-deadline-'))
  roots.push(root)
  await writeFile(
    join(root, 'host.mjs'),
    'process.stdin.once("data", () => process.stderr.write("PDF execution deadline exceeded. Last phase: onnx", () => process.exit(1)))'
  )
  await writeFile(join(root, 'scratch.mjs'), 'export async function inspectScratch() { return 0 }')
  const job = createEngineAt(root, { modelRecipe }).start(requestAt(root))
  const error = await job.result.catch((value: unknown) => value)
  await job.stop()
  expect(isPdfStructureResourceLimitError(error)).toBe(true)
  expect(error).toMatchObject({ code: 'PDF_RESOURCE_LIMIT' })
  expect((error as Error).message).toContain('PDF execution deadline exceeded.')
})

it('classifies a worker JavaScript heap-limit failure for an explicit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-heap-limit-'))
  roots.push(root)
  await writeFile(
    join(root, 'host.mjs'),
    'process.stdin.once("data", () => process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", () => process.exit(1)))'
  )
  await writeFile(join(root, 'scratch.mjs'), 'export async function inspectScratch() { return 0 }')
  const job = createEngineAt(root, { modelRecipe }).start(requestAt(root))
  const error = await job.result.catch((value: unknown) => value)
  await job.stop()
  expect(isPdfStructureResourceLimitError(error)).toBe(true)
  expect(error).toMatchObject({ code: 'PDF_RESOURCE_LIMIT' })
  expect((error as Error).message).toContain('JavaScript heap out of memory')
})

it('retains an actual nullable exit code and signal from the owned runtime close', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: 'SIGTERM'
  }) as unknown as import('node:child_process').ChildProcessWithoutNullStreams
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-signal-'))
  roots.push(root)
  await writeFile(join(root, 'scratch.mjs'), 'export async function inspectScratch() { return 0 }')
  const runtime = { spawn: () => child, stop: vi.fn(async () => undefined) }
  const job = createEngineAt(root, { modelRecipe, runtime }).start(requestAt(root))
  child.emit('close', null, 'SIGTERM')
  await expect(job.result).rejects.toThrow('PDF extraction failed. (exitCode=null, signal=SIGTERM)')
  await job.stop()
  expect(runtime.stop).not.toHaveBeenCalled()
  expect(readWorkerResult).not.toHaveBeenCalled()
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
})

it('keeps an earlier runtime error instance instead of replacing it with close diagnostics', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 37,
    signalCode: null
  }) as unknown as import('node:child_process').ChildProcessWithoutNullStreams
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-earlier-error-'))
  roots.push(root)
  await writeFile(join(root, 'scratch.mjs'), 'export async function inspectScratch() { return 0 }')
  const runtime = { spawn: () => child, stop: vi.fn(async () => undefined) }
  const job = createEngineAt(root, { modelRecipe, runtime }).start(requestAt(root))
  const original = new Error('spawn transport failed')
  child.emit('error', original)
  child.emit('close', 37, null)
  await expect(job.result).rejects.toBe(original)
  await job.stop()
  expect(readWorkerResult).not.toHaveBeenCalled()
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
})

it.skipIf(process.platform !== 'win32')(
  'keeps the host Canvas library resident after a native Worker exits',
  async () => {
    const { spawn } = await import('node:child_process')
    const { createRequire } = await import('node:module')
    const { resolve } = await import('./paths')
    const require = createRequire(import.meta.url)
    const canvasEntry = require.resolve('@napi-rs/canvas')
    const nativeEntry = createRequire(canvasEntry).resolve(
      '@napi-rs/canvas-win32-' + process.arch + '-msvc'
    )
    const workerScript = `
    const assert = require('node:assert/strict')
    const { parentPort, workerData } = require('node:worker_threads')
    const { createCanvas } = require(workerData.canvasEntry)
    async function encode() {
      const canvas = createCanvas(64, 64)
      canvas.getContext('2d').fillRect(0, 0, 64, 64)
      const png = await canvas.encode('png')
      assert.equal(canvas.width, 64)
      assert.equal(canvas.height, 64)
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(png.readUInt32BE(16), 64)
      assert.equal(png.readUInt32BE(20), 64)
      parentPort.postMessage({ width: canvas.width, height: canvas.height, pngBytes: png.length })
    }
    void encode().catch(error => { throw error })
  `
    const script = `
    import assert from 'node:assert/strict'
    import { realpathSync, writeSync } from 'node:fs'
    import { basename } from 'node:path'
    import { pathToFileURL } from 'node:url'
    import { Worker } from 'node:worker_threads'
    process.stdin.resume()
    await import(pathToFileURL(${JSON.stringify(resolve('resources/host.mjs'))}).href)
    const worker = new Worker(${JSON.stringify(workerScript)}, {
      eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: ${JSON.stringify({ canvasEntry })}
    })
    let result
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(Error('Native Worker deadline')) }, 10000)
      worker.once('message', value => { result = value })
      worker.once('error', reject)
      worker.once('exit', code => {
        clearTimeout(timer)
        try { assert.equal(code, 0); resolve() } catch (error) { reject(error) }
      })
    })
    assert(result && result.width === 64 && result.height === 64 && result.pngBytes > 0)
    const modules = process.report.getReport().sharedObjects
    assert(Array.isArray(modules) && modules.length > 0)
    const canonical = file => realpathSync.native(file).toLowerCase()
    assert(modules.filter(file => basename(file).toLowerCase() === basename(process.execPath).toLowerCase()).some(file => canonical(file) === canonical(process.execPath)))
    const expected = canonical(${JSON.stringify(nativeEntry)})
    const resident = modules.filter(file => basename(file).toLowerCase() === basename(expected)).some(file => canonical(file) === expected)
    assert(resident, 'The same physical Canvas library must remain loaded after Worker exit')
    writeSync(1, JSON.stringify({ workerExitCode: 0, png: true, nativeResident: resident }) + '\\n')
    process.exit(0)
  `
    const observed = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      error: string | null
      timedOut: boolean
      closed: boolean
    }>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = '',
        stderr = '',
        error: string | null = null,
        timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, 25000)
      child.stdout.on('data', (b) => {
        stdout += b.toString()
      })
      child.stderr.on('data', (b) => {
        stderr += b.toString()
      })
      child.once('error', (e) => {
        error = e.message
      })
      // Keep stdin open without sending any SDK request. The host's end handler must not run.
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, stdout, stderr, error, timedOut, closed: true })
      })
    })
    expect(observed.error).toBeNull()
    expect(observed.timedOut).toBe(false)
    expect(observed.closed).toBe(true)
    expect(observed.signal).toBeNull()
    expect(observed.code, observed.stderr).toBe(0)
    expect(JSON.parse(observed.stdout)).toEqual({
      workerExitCode: 0,
      png: true,
      nativeResident: true
    })
  },
  30000
)
