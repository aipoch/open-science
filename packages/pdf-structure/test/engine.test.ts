import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createEngineAt } from '../src/engine.js'
import { createPdfStructureEngine } from '../src/index.js'
const modelRecipe = { revision: 'test' }
import * as workerResult from '../src/worker-result.js'
import { isPdfStructureResourceLimitError } from '../src/errors.js'

beforeEach(() => {
  vi.spyOn(workerResult, 'readWorkerResult')
})
const roots: string[] = []
it.each([
  'worker-heap',
  'process-rss',
  'scratch-bytes',
  'combined-rss',
  'deadline',
  'duplicate-start'
])('reports the exact %s supervisor limit without changing the budgets', async (reason) => {
  const { readFile } = await import('node:fs/promises')
  const { EventEmitter } = await import('node:events')
  const { runInNewContext } = await import('node:vm')
  const source = (await readFile(new URL('../resources/host.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*$/gm, '')
    .replaceAll('import.meta.url', "'file:///resources/host.mjs'")
  let limits: unknown,
    inspect: () => Promise<void>,
    rss = reason === 'combined-rss' ? 1024 ** 3 : 2 * 1024 ** 3,
    childRss = reason === 'combined-rss' ? 1024 ** 3 : 0,
    deadlineCallback: () => void,
    memoryCallback: () => void,
    scratch = 256 * 1024 ** 2
  const workers: StubWorker[] = [],
    stdin = new EventEmitter(),
    exit = vi.fn(),
    error = vi.fn(),
    deadlines: number[] = [],
    inspectScratch = vi.fn(async () => scratch),
    childStop = vi.fn(async () => undefined),
    createOnnxProcess = vi.fn((_args, memory) => {
      memoryCallback = memory
      return {
        stdout: new EventEmitter(),
        result: new Promise(() => undefined),
        stop: childStop,
        get rssBytes() {
          return childRss
        }
      }
    })
  class StubWorker extends EventEmitter {
    stdout = Object.assign(new EventEmitter(), { pipe: vi.fn() })
    stderr = new EventEmitter()
    terminate = vi.fn(async () => undefined)
    constructor(_url: URL, options: { resourceLimits: unknown }) {
      super()
      workers.push(this)
      limits = options.resourceLimits
    }
  }
  runInNewContext(source, {
    Worker: StubWorker,
    URL,
    join,
    process: {
      platform: 'linux',
      on: vi.fn(),
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      memoryUsage: () => ({ rss }),
      exit
    },
    console: { error },
    inspectScratch,
    createOnnxProcess,
    setTimeout: (callback: () => void, ms: number) => {
      if (ms === 120000) deadlineCallback = callback
      deadlines.push(ms)
    },
    clearTimeout: vi.fn(),
    setInterval: (callback: () => Promise<void>, ms: number) => {
      expect(ms).toBe(250)
      inspect = callback
    },
    clearInterval: vi.fn()
  })
  stdin.emit('data', '{"input":"source.pdf","output":"scratch","pages":[1]}\n')
  if (reason === 'combined-rss' || reason === 'deadline' || reason === 'duplicate-start')
    workers[0].emit('message', { type: 'onnx:start', args: ['ignored'] })
  expect(limits).toEqual({ maxOldGenerationSizeMb: 512 })
  expect(deadlines).toEqual([120000])
  await inspect!()
  expect(exit).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  if (reason === 'worker-heap') {
    workers[0].emit('error', new Error('Worker terminated: JS heap out of memory'))
  } else if (reason === 'combined-rss') {
    childRss++
    memoryCallback!()
  } else if (reason === 'duplicate-start') {
    workers[0].emit('message', { type: 'onnx:start' })
  } else if (reason === 'deadline') {
    deadlineCallback!()
  } else {
    if (reason === 'process-rss') rss++
    else scratch++
    await inspect!()
  }
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
  const message = error.mock.calls.map((args) => args.join(' ')).join('\n')
  if (reason === 'duplicate-start') {
    expect(createOnnxProcess).toHaveBeenCalledOnce()
    expect(childStop).toHaveBeenCalledOnce()
    return
  }
  if (reason === 'deadline') {
    expect(message).toContain('PDF execution deadline exceeded. Last phase: startup')
    expect(childStop).toHaveBeenCalledOnce()
    return
  }
  expect(message).toContain('PDF execution resource limit exceeded. Last phase: startup.')
  expect(message).toContain(`Reason: ${reason === 'combined-rss' ? 'process-rss' : reason}.`)
  const stats = JSON.parse(message.split('Stats: ')[1])
  expect(stats).toMatchObject({
    workerHeapLimitMb: 512,
    rssLimitBytes: 2 * 1024 ** 3,
    scratchLimitBytes: 256 * 1024 ** 2,
    deadlineMs: 120000,
    rssBytes: rss + childRss
  })
  if (reason === 'scratch-bytes') expect(stats.scratchBytes).toBe(scratch)
  if (reason === 'combined-rss') {
    expect(stats).toMatchObject({ hostRssBytes: rss, childRssBytes: childRss })
    expect(createOnnxProcess.mock.calls[0][0]).toEqual([
      'source.pdf',
      undefined,
      undefined,
      '1',
      'scratch/inference',
      'production'
    ])
    expect(childStop).toHaveBeenCalledOnce()
  }
  expect(
    Object.values(stats).every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
  ).toBe(true)
  expect(message).not.toContain('source.pdf')
  expect(message).not.toContain('"scratch"')
})
it('resolves the actual engine recipe with the installed package exports', async () => {
  const recipe = await createPdfStructureEngine({ modelRecipe }).describe()
  expect(recipe.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(recipe.modelRevision).toBe('test')
})
it('rejects inputs above the bounded 50 MiB snapshot limit before spawning a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-input-limit-'))
  roots.push(root)
  const runtime = {
    spawn: vi.fn(() => {
      throw new Error('worker must not start for an oversized input')
    }),
    stop: vi.fn(async () => undefined)
  }
  const request = requestAt(root)
  request.identity.sourceSizeBytes = 50 * 1024 ** 2 + 1
  const job = createEngineAt(root, { modelRecipe, runtime }).start(request)
  await expect(job.result).rejects.toThrow('PDF resources or request limits are unsupported.')
  expect(runtime.spawn).not.toHaveBeenCalled()
  await job.stop()
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('joins main-process result conversion before deleting scratch after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-stop-'))
  roots.push(root)
  await mkdir(join(root, 'job'))
  await writeFile(
    join(root, 'host.mjs'),
    `import {mkdir} from 'node:fs/promises'; process.stdin.once('data', async chunk => { const request=JSON.parse(chunk); await mkdir(request.output); process.send({type:"pdf:stopped"},()=>process.exit(0)) })`
  )
  await writeFile(
    join(root, 'scratch.mjs'),
    `import {rmdir} from 'node:fs/promises'; export async function inspectScratch(root, remove) { if (remove) await rmdir(root); return 0 }`
  )
  let rejectConversion!: (error: Error) => void
  vi.mocked(workerResult.readWorkerResult).mockImplementation(
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
  await vi.waitFor(() => expect(workerResult.readWorkerResult).toHaveBeenCalledOnce(), {
    timeout: 15_000
  })
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
  await writeFile(
    join(root, 'host.mjs'),
    `process.stdin.resume();process.on('message',({type})=>{if(type==='pdf:stop')process.send({type:'pdf:stopped'},()=>process.exit(1))})`
  )
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
  await writeFile(
    join(root, 'host.mjs'),
    `process.stdin.resume();process.on('message',({type})=>{if(type==='pdf:stop')process.send({type:'pdf:stopped'},()=>process.exit(1))})`
  )
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
      ', () => process.send({type:"pdf:stopped"},()=>process.exit(37))))'
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
  expect(workerResult.readWorkerResult).not.toHaveBeenCalled()
})

it('classifies a host resource-limit failure for an explicit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-resource-limit-'))
  roots.push(root)
  await writeFile(
    join(root, 'host.mjs'),
    'process.stdin.once("data", () => process.stderr.write("PDF execution resource limit exceeded.", () => process.send({type:"pdf:stopped"},()=>process.exit(1))))'
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
    'process.stdin.once("data", () => process.stderr.write("PDF execution deadline exceeded. Last phase: onnx", () => process.send({type:"pdf:stopped"},()=>process.exit(1))))'
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
    'process.stdin.once("data", () => process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", () => process.send({type:"pdf:stopped"},()=>process.exit(1))))'
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
  expect(runtime.stop).toHaveBeenCalledOnce()
  expect(workerResult.readWorkerResult).not.toHaveBeenCalled()
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
  expect(workerResult.readWorkerResult).not.toHaveBeenCalled()
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

it.each([
  'success',
  'transfer-success',
  'render-failure',
  'inference-failure',
  'detection-create-failure',
  'detection-release-failure',
  'structure-success',
  'structure-failure'
])('releases completed page resources and inference tensors on %s', async (mode) => {
  const { readFile } = await import('node:fs/promises'),
    { runInNewContext } = await import('node:vm'),
    assert = (await import('node:assert/strict')).default,
    { dirname, resolve } = await import('node:path'),
    { pathToFileURL } = await import('node:url'),
    { createOnnxSessionLifecycle } = await import(
      new URL('../resources/literature-pdf-onnx-sessions.mjs', import.meta.url).href
    ),
    { installPdfCanvasReset: installCanvasReset } = await import(
      new URL('../resources/literature-pdf-canvas-reset.mjs', import.meta.url).href
    )
  const source = (
    await readFile(new URL('../resources/literature-pdf-onnx.mjs', import.meta.url), 'utf8')
  )
    .replace(/^import\b[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
    .replace(
      'await import(pathToFileURL(runtimeEntry).href)',
      '({ ...runtime, InferenceSession: { create: async (...args) => { const session = await runtime.InferenceSession.create(...args); return { ...session, inputNames: Array.from(session.inputNames) } } } })'
    )
    .replaceAll('import.meta.url', "'file:///resources/literature-pdf-onnx.mjs'")
  const factory = { reset: vi.fn() },
    installPdfCanvasReset = vi.fn((value: typeof factory) => {
      expect(value).toBe(factory)
      installCanvasReset(value)
    })
  const events: string[] = [],
    png = Buffer.from('same-pixels'),
    canvas = {
      width: 300,
      height: 300,
      getContext: () => ({}),
      encode: async () => png
    },
    backing = Buffer.alloc(40),
    pdfBytes = backing.subarray(7, 20),
    observed: {
      data?: Uint8Array
      offset?: number
      length?: number
      sourceSha256?: string
      rulesReady?: boolean
    } = {},
    page = {
      getTextContent: async () => ({
        items: [{ str: 'Native value', transform: [10, 0, 0, 10, 30, 270], width: 40, height: 10 }]
      }),
      getViewport: () => ({
        width: 300,
        height: 300,
        convertToViewportPoint: (x: number, y: number) => [x, 300 - y]
      }),
      render: () => {
        expect(installPdfCanvasReset).toHaveBeenCalledExactlyOnceWith(factory)
        factory.reset({}, 300, 300)
        return {
          promise: mode === 'render-failure' ? Promise.reject(Error(mode)) : Promise.resolve()
        }
      },
      getOperatorList: async () => ({}),
      cleanup: () => {
        events.push('page')
      }
    },
    document = {
      canvasFactory: factory,
      numPages: 1,
      getPage: async () => page,
      cleanup: async () => {
        events.push('document')
      }
    },
    task = {
      promise: Promise.resolve(document),
      destroy: async () => {
        events.push('destroy')
      }
    }
  let sessionIndex = 0
  class Tensor {
    dispose(): void {
      events.push('tensor')
    }
  }
  const runtime = {
    env: { versions: { web: '1.29.0' }, wasm: {} },
    Tensor,
    InferenceSession: {
      create: async () => {
        const index = sessionIndex++
        expect(events.slice(0, 3)).toEqual(['page', 'document', 'destroy'])
        expect([canvas.width, canvas.height]).toEqual([1, 1])
        expect(observed.rulesReady).toBe(true)
        if (index === 0 && mode === 'detection-create-failure') throw Error(mode)
        if (index === 1)
          expect(events).toEqual([
            'page',
            'document',
            'destroy',
            'tensor',
            'logits',
            'boxes',
            'session:0'
          ])
        return {
          inputNames: ['pixel_values'],
          release: async () => {
            events.push(`session:${index}`)
            if (index === 0 && mode === 'detection-release-failure') throw Error(mode)
          },
          run: async () => {
            if (mode === 'inference-failure' || (mode === 'structure-failure' && index === 1))
              throw Error(mode)
            return {
              logits: {
                dims: [1, 1, index === 0 ? 3 : 7],
                data: Float32Array.from(
                  index === 1
                    ? [-10, -10, -10, -10, -10, -10, 10]
                    : mode.startsWith('structure-')
                      ? [10, -10, -10]
                      : [-10, -10, 10]
                ),
                dispose: () => events.push('logits')
              },
              pred_boxes: {
                dims: [1, 1, 4],
                data: Float32Array.from([0.5, 0.5, 1, 1]),
                dispose: () => events.push('boxes')
              }
            }
          }
        }
      }
    }
  }
  const chain = {
      resize: (width: number, height: number) => {
        expect([width, height]).toEqual([800, 800])
        return chain
      },
      removeAlpha: () => chain,
      toColourspace: () => chain,
      raw: () => chain,
      extract: (rect: { width: number; height: number }) => {
        expect(rect.width).toBe(300)
        expect(rect.height).toBe(300)
        return chain
      },
      png: () => chain,
      toBuffer: async () => Buffer.alloc(800 * 800 * 3)
    },
    sharp = Object.assign(
      (input: unknown) => {
        if (!sessionIndex || sessionIndex === 1) expect(input).toBe(png)
        return chain
      },
      {
        versions: { sharp: 'test' },
        kernel: { linear: 'linear' }
      }
    )
  const run = runInNewContext(`(async()=>{${source}})()`, {
    assert,
    dirname,
    join,
    resolve,
    pathToFileURL,
    runtime,
    createOnnxSessionLifecycle,
    installPdfCanvasReset,
    sharp,
    performance,
    process: {
      argv: ['node', 'script', 'source.pdf', 'assets', 'runtime.mjs', '1', 'out', 'production'],
      versions: {},
      memoryUsage: () => ({}),
      resourceUsage: () => ({ maxRSS: 0 })
    },
    stat: async () => ({ size: 13, isDirectory: () => false }),
    readFile: async (path: string) =>
      path.endsWith('.onnx')
        ? Buffer.from(path.includes('detection') ? 'detection' : 'structure')
        : pdfBytes,
    createReadStream: async function* (path: string) {
      yield Buffer.from(path.includes('detection') ? 'detection' : 'structure')
    },
    createHash: () => {
      const chunks: Buffer[] = []
      const hash = {
        update(bytes: Buffer) {
          chunks.push(Buffer.from(bytes))
          return hash
        },
        digest: () => {
          const bytes = Buffer.concat(chunks)
          return bytes.toString() === 'detection'
            ? '5be82ec9d157814ea8616588398d7baec17aed0780b870f7adf24b280ee1b5aa'
            : bytes.toString() === 'structure'
              ? '2c90a63298df61006a45267932f47b345a8b104ce53fd504eacf11aee3c05a41'
              : 'source'
        }
      }
      return hash
    },
    createRequire: () => ({ resolve: () => '/pdfjs/package.json' }),
    getDocument: (options: { data: Uint8Array }) => {
      observed.data = options.data
      observed.offset = options.data.byteOffset
      observed.length = options.data.byteLength
      if (mode === 'transfer-success')
        structuredClone(options.data.buffer, { transfer: [options.data.buffer] })
      return task
    },
    createCanvas: () => canvas,
    mkdir: async () => undefined,
    writeFile: async (_path: string, data: string) => {
      observed.sourceSha256 = JSON.parse(data).sourceSha256
    },
    repairPdfSymbolText: async (_page: unknown, content: unknown) => content,
    readingRotation: () => 0,
    isUprightText: () => true,
    collectTableRules: () => {
      observed.rulesReady = true
      return [[20, 40, 60, 40]]
    },
    findCaptionedNumericTableRegions: (text: unknown, rules: unknown) => {
      expect(text).toEqual([
        { text: 'Native value', x: 30, baseline: 30, width: 60, height: 15, horizontal: true }
      ])
      expect(rules).toEqual([[20, 40, 60, 40]])
      return []
    },
    deduplicateTableDetections: (objects: unknown) => objects,
    cpus: () => [],
    platform: () => 'test',
    arch: () => 'test',
    version: 'test',
    console: { log: () => undefined }
  })
  if (mode.endsWith('success')) await run
  else await expect(run).rejects.toThrow(mode)
  expect.soft(observed.data?.buffer).toBe(pdfBytes.buffer)
  expect.soft(observed.data?.byteOffset).toBe(pdfBytes.byteOffset)
  expect(observed.data?.byteLength).toBe(pdfBytes.byteLength)
  expect(observed.offset).toBe(7)
  expect(observed.length).toBe(13)
  if (mode === 'transfer-success') expect(observed.data?.byteLength).toBe(0)
  expect.soft([canvas.width, canvas.height]).toEqual([1, 1])
  expect(events).toContain('page')
  expect.soft(events).toContain('document')
  expect(events).toContain('destroy')
  if (mode === 'render-failure') expect(sessionIndex).toBe(0)
  else if (mode === 'detection-create-failure') expect(sessionIndex).toBe(1)
  else expect(events).toContain('session:0')
  if (mode.startsWith('structure-')) expect(events).toContain('session:1')
  else expect(events).not.toContain('session:1')
  if (!['render-failure', 'detection-create-failure'].includes(mode))
    expect.soft(events).toContain('tensor')
  if (mode.endsWith('success')) {
    expect(observed.sourceSha256).toBe('source')
    expect(events).toEqual([
      'page',
      'document',
      'destroy',
      'tensor',
      'logits',
      'boxes',
      'session:0',
      ...(mode === 'structure-success' ? ['tensor', 'logits', 'boxes'] : []),
      ...(mode === 'structure-success' ? ['session:1'] : [])
    ])
  }
})

it('retains scratch after an unexpectedly killed default supervisor, including repeated stop', async () => {
  const { once } = await import('node:events')
  const { nodeProcessRuntime } = await import('../src/node-runtime.js')
  const root = await mkdtemp(join(tmpdir(), 'pdf-engine-unconfirmed-'))
  roots.push(root)
  await mkdir(join(root, 'extractor'))
  await writeFile(
    join(root, 'host.mjs'),
    'process.stdin.resume();console.log("ready");setInterval(()=>{},1000)'
  )
  await writeFile(
    join(root, 'scratch.mjs'),
    `import{rmdir}from'node:fs/promises';export async function inspectScratch(root){await rmdir(root)}`
  )
  const runtime = { ...nodeProcessRuntime, spawn: vi.fn(nodeProcessRuntime.spawn) },
    job = createEngineAt(root, { modelRecipe, runtime }).start(requestAt(root)),
    child = runtime.spawn.mock.results[0].value
  const failed = expect(job.result).rejects.toThrow('signal=SIGKILL')
  await once(child.stdout, 'data')
  child.kill('SIGKILL')
  await failed
  await expect(job.stop()).rejects.toThrow('termination is unconfirmed')
  await expect(job.stop()).rejects.toThrow('termination is unconfirmed')
  expect((await stat(join(root, 'extractor'))).isDirectory()).toBe(true)
  expect(workerResult.readWorkerResult).not.toHaveBeenCalled()
})
