import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Writable } from 'node:stream'
import { MessageChannel, Worker, type WorkerOptions } from 'node:worker_threads'
import { afterEach, expect, it } from 'vitest'

const extract = await readFile(
    new URL('../resources/literature-pdf-extract.mjs', import.meta.url),
    'utf8'
  ),
  runner = await readFile(new URL('../resources/onnx-process.mjs', import.meta.url), 'utf8'),
  declaration = runner
    .slice(runner.indexOf('export const runOnnxWorker ='), runner.indexOf('\n// Only host owns'))
    .replace('export const', 'const')
    .replaceAll(
      'import.meta.url',
      JSON.stringify(new URL('../resources/literature-pdf-extract.mjs', import.meta.url).href)
    )
const directories: string[] = [],
  workers: Worker[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.terminate()))
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function fixture(program: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'onnx-stage-'))
  directories.push(directory)
  const file = join(directory, 'stage.mjs')
  await writeFile(file, program)
  return file
}

it.each([
  'success',
  'delayed-success',
  'delayed-error',
  'throw',
  'nonzero',
  'pipe-error',
  'pipe-throws'
])('awaits the owned actual Worker exit before resolving or rejecting: %s', async (mode) => {
  const file = await fixture(
      mode === 'throw'
        ? 'throw Error("stage failed")'
        : mode === 'nonzero'
          ? 'process.exit(7)'
          : mode.startsWith('pipe-')
            ? 'process.stdout.write("output");setInterval(()=>{},1000)'
            : 'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.stderr.write("stderr marker")'
    ),
    args = ['source.pdf', 'assets', 'runtime.mjs', '1', 'out', 'production'],
    events: string[] = [],
    chunks: string[] = [],
    errors: string[] = [],
    stdout = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString())
        if (mode.startsWith('delayed-')) {
          setTimeout(() => {
            events.push('sink-callback')
            done(mode === 'delayed-error' ? Error('delayed sink failed') : undefined)
          }, 100)
        } else done(mode === 'pipe-error' ? Error('sink failed') : undefined)
      }
    }),
    stderr = new Writable({
      write(chunk, _encoding, done) {
        errors.push(chunk.toString())
        done()
      }
    }),
    observed: { entry?: URL; options?: WorkerOptions; worker?: Worker } = {}
  class StageWorker extends Worker {
    constructor(entry: URL, options: WorkerOptions) {
      super(pathToFileURL(file), options)
      workers.push(this)
      observed.entry = entry
      observed.options = options
      observed.worker = this
      this.once('exit', (code) => events.push(`exit:${code}`))
      if (mode === 'pipe-throws') {
        const stream = this.stdout!
        stream.pipe = (() => {
          throw Error('pipe setup failed')
        }) as typeof stream.pipe
      }
    }
  }
  const pending = runInNewContext(`${declaration}\nrunOnnxWorker(args)`, {
    Worker: StageWorker,
    Writable,
    URL,
    args,
    process: { stdout, stderr },
    console: { log: () => undefined }
  }) as Promise<void>
  const finished = pending.then(() => events.push('geometry'))
  if (mode === 'success' || mode === 'delayed-success') {
    await finished
    expect(events).toEqual(
      mode === 'success' ? ['exit:0', 'geometry'] : ['exit:0', 'sink-callback', 'geometry']
    )
    expect(JSON.parse(chunks.join(''))).toEqual(args)
    expect(errors.join('')).toBe('stderr marker')
    expect(stdout.writableEnded).toBe(false)
    expect(stderr.writableEnded).toBe(false)
    await new Promise<void>((resolve, reject) =>
      stdout.write('parent continues', (error) => (error ? reject(error) : resolve()))
    )
    expect(chunks.at(-1)).toBe('parent continues')
  } else {
    await expect(finished).rejects.toThrow(
      mode === 'throw'
        ? 'stage failed'
        : mode === 'nonzero'
          ? '(7)'
          : mode === 'delayed-error'
            ? 'delayed sink failed'
            : mode === 'pipe-error'
              ? 'sink failed'
              : 'pipe setup failed'
    )
    expect(events.some((e) => e.startsWith('exit:'))).toBe(true)
    expect(events).not.toContain('geometry')
    if (mode === 'delayed-error') expect(events).toEqual(['exit:0', 'sink-callback'])
  }
  expect(observed.worker!.threadId).toBe(-1)
  expect(observed.entry!.pathname.endsWith('/literature-pdf-onnx.mjs')).toBe(true)
  expect(observed.options).toEqual({
    argv: args,
    execArgv: [],
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 512 }
  })
  expect(stdout.listenerCount('error')).toBe(0)
  expect(stderr.listenerCount('error')).toBe(0)
})

it('terminates a hanging stage when its owning extraction Worker is aborted', async () => {
  const child = await fixture(
      'import{workerData}from"node:worker_threads";workerData.port.postMessage("alive");setInterval(()=>{},1000)'
    ),
    { port1, port2 } = new MessageChannel(),
    alive = new Promise((resolve) => port1.once('message', resolve)),
    closed = new Promise<void>((resolve) => port1.once('close', resolve)),
    parent = new Worker(
      `const{Writable}=require('node:stream');const{Worker:RealWorker,workerData}=require('node:worker_threads');
      class Worker extends RealWorker{constructor(entry,options){super(workerData.child,{...options,workerData:{port:workerData.port},transferList:[workerData.port]})}}
      ${declaration}
      runOnnxWorker([]).catch(()=>{});`,
      {
        eval: true,
        execArgv: [],
        stdout: true,
        stderr: true,
        workerData: { child, port: port2 },
        transferList: [port2],
        resourceLimits: { maxOldGenerationSizeMb: 512 }
      }
    )
  workers.push(parent)
  parent.stdout!.resume()
  parent.stderr!.resume()
  await alive
  await parent.terminate()
  await closed
  expect(parent.threadId).toBe(-1)
  port1.close()
})

it('finishes ONNX before importing geometry and retains its original same-thread cleanup', () => {
  expect(extract.indexOf('\nawait runOnnxWorker(')).toBeLessThan(
    extract.indexOf("const structurePhase = await run('./literature-pdf-structure.mjs'")
  )
  expect(extract).toContain('structurePhase.nativeFigureRenderContexts.clear()')
  expect(extract).toContain('const runOnnxWorker = () => requestOnnxProcess(parentPort)')
  expect(extract).not.toContain("await run('./literature-pdf-onnx.mjs'")
})
