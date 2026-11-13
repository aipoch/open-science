import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { nodeProcessRuntime } from '../src/node-runtime.js'

type Owner = { result: Promise<void>; stop(): Promise<void>; readonly rssBytes: number }
const directories: string[] = [],
  owners: Owner[] = [],
  hosts: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.stop()))
  for (const host of hosts.splice(0)) if (host.exitCode === null) host.kill('SIGKILL')
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(program: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'onnx-process-'))
  directories.push(root)
  for (const name of [
    'onnx-process.mjs',
    'literature-pdf-onnx-host.mjs',
    'host.mjs',
    'scratch.mjs'
  ]) {
    await cp(new URL(`../resources/${name}`, import.meta.url), join(root, name))
  }
  await writeFile(
    join(root, 'literature-pdf-onnx.mjs'),
    `import{writeFileSync}from"node:fs";writeFileSync(new URL("pid",import.meta.url),String(process.pid));console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));${program}`
  )
  return root
}
async function running(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false
    }
    return true
  } catch {
    return false
  }
}
async function gone(pid: number): Promise<void> {
  await expect.poll(() => running(pid), { timeout: 5000 }).toBe(false)
}
it.each(['success', 'throw', 'nonzero', 'sink-error', 'sink-throws', 'cancel'])(
  'joins the actual owned process and its forwarded output before geometry: %s',
  async (mode) => {
    const root = await fixture(
        mode === 'throw'
          ? 'throw Error("inference failed")'
          : mode === 'nonzero'
            ? 'process.exit(7)'
            : mode === 'success'
              ? 'process.stderr.write("stderr marker")'
              : 'setInterval(()=>process.stdout.write("tick\\n"),20)'
      ),
      { createOnnxProcess } = await import(pathToFileURL(join(root, 'onnx-process.mjs')).href),
      args = ['snapshot.pdf', 'assets', 'runtime', '1', 'output', 'production'],
      events: string[] = [],
      samples: number[] = [],
      chunks: string[] = [],
      errors: string[] = []
    let pid = 0
    const stdout = new Writable({
        write(chunk, _encoding, done) {
          const text = chunk.toString()
          chunks.push(text)
          const match = chunks.join('').match(/"pid":(\d+)/)
          if (match) pid = Number(match[1])
          if (mode === 'sink-throws') throw Error('sink threw')
          setTimeout(() => {
            events.push('sink-finished')
            // The host logs its phase before the inference worker can report its PID.
            done(mode === 'sink-error' && pid ? Error('sink failed') : undefined)
          }, 30)
        }
      }),
      stderr = new Writable({
        write(chunk, _encoding, done) {
          errors.push(chunk.toString())
          done()
        }
      })
    // Writable.write can throw before a bridge callback, as well as fail asynchronously.
    if (mode === 'sink-throws')
      stdout.write = (() => {
        throw Error('sink threw')
      }) as typeof stdout.write
    const owner = createOnnxProcess(
      args,
      (rss: number) => samples.push(rss),
      stdout,
      stderr
    ) as Owner
    owners.push(owner)
    const result = owner.result.then(() => events.push('geometry'))
    const settled =
      mode === 'success'
        ? result
        : expect(result).rejects.toThrow(
            mode === 'throw'
              ? 'inference failed'
              : mode === 'nonzero'
                ? '(7)'
                : mode === 'sink-error'
                  ? 'sink failed'
                  : mode === 'sink-throws'
                    ? 'sink threw'
                    : 'cancelled'
          )
    if (mode === 'cancel') {
      await expect.poll(() => pid).toBeGreaterThan(0)
      await Promise.all([owner.stop(), owner.stop()])
    }
    await settled
    if (mode === 'sink-error') expect(pid).toBeGreaterThan(0)
    if (!pid && mode !== 'sink-throws') pid = Number(await readFile(join(root, 'pid'), 'utf8'))
    if (pid) {
      expect(pid).not.toBe(process.pid)
      await gone(pid)
    }
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.every((sample) => Number.isSafeInteger(sample) && sample > 0)).toBe(true)
    expect(owner.rssBytes).toBe(0)
    expect(stdout.writableEnded).toBe(false)
    expect(stderr.writableEnded).toBe(false)
    expect(stdout.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('error')).toBe(0)
    if (mode === 'success') {
      expect(events.at(-1)).toBe('geometry')
      expect(events.slice(0, -1).every((event) => event === 'sink-finished')).toBe(true)
      expect(
        chunks
          .join('')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((value) => value.pid).args
      ).toEqual(args)
      expect(errors.join('')).toBe('stderr marker')
    } else expect(events).not.toContain('geometry')
  }
)
async function startHost(mode: string): Promise<{
  root: string
  host: ChildProcessWithoutNullStreams
  pid: Promise<number>
  closed: Promise<number | null>
}> {
  const root = await fixture(
      mode === 'connected-success' ? '' : 'setInterval(()=>process.stdout.write("tick\\n"),20)'
    ),
    job = join(root, 'job'),
    output = join(job, 'out')
  await mkdir(output, { recursive: true })
  await writeFile(join(job, 'snapshot.pdf'), 'snapshot')
  await writeFile(
    join(root, 'literature-pdf-extract.mjs'),
    `import{parentPort}from'node:worker_threads';import{requestOnnxProcess}from'./onnx-process.mjs';const pending=requestOnnxProcess(parentPort);${mode === 'worker-exit' ? 'setTimeout(()=>process.exit(9),250);' : ''}await pending;${mode === 'connected-success' ? `const {readFileSync,writeFileSync}=await import('node:fs');const pid=Number(readFileSync(new URL('pid',import.meta.url)));let alive=false;try{process.kill(pid,0);alive=true}catch{};writeFileSync(new URL('geometry-proof.json',import.meta.url),JSON.stringify({priorProcessAlive:alive}));` : ''}console.log('geometry');`
  )
  const host =
    mode === 'adapter-stop'
      ? nodeProcessRuntime.spawn(join(root, 'host.mjs'))
      : spawn(process.execPath, [join(root, 'host.mjs')], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
  hosts.push(host)
  host.stderr.resume()
  let text = ''
  const pid = new Promise<number>((resolve) =>
    host.stdout.on('data', (chunk) => {
      text += chunk.toString()
      const match = text.match(/"pid":(\d+)/)
      if (match) resolve(Number(match[1]))
    })
  )
  const closed = new Promise<number | null>((resolve) => host.once('close', resolve))
  host.stdin.write(
    JSON.stringify({
      input: join(job, 'snapshot.pdf'),
      assets: 'assets',
      runtime: 'runtime',
      pages: [1],
      output
    }) + '\n'
  )
  return { root, host, pid, closed }
}
it.each(['stdin-close', 'host-killed', 'worker-exit', 'stdout-close', 'adapter-stop'])(
  'leaves no running inference process after its owner fails: %s',
  async (mode) => {
    const { root, host, pid, closed } = await startHost(mode),
      childPid = await pid
    expect(await running(childPid)).toBe(true)
    if (mode === 'adapter-stop') await nodeProcessRuntime.stop(host)
    if (mode === 'stdin-close') host.stdin.end()
    if (mode === 'host-killed') host.kill('SIGKILL')
    if (mode === 'stdout-close') host.stdout.destroy()
    await closed
    await gone(childPid)
    const snapshot = join(root, 'job', 'snapshot.pdf')
    if (mode === 'adapter-stop') expect(await readFile(snapshot, 'utf8')).toBe('snapshot')
    if (mode === 'stdin-close')
      await expect(stat(join(root, 'job'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

it('forcibly reclaims a child whose inference ignores cancellation', async () => {
  const root = await fixture(''),
    helper = join(root, 'onnx-process.mjs'),
    source = await readFile(helper, 'utf8')
  const start = source.indexOf('export const runOnnxWorker ='),
    end = source.indexOf('// Only host owns')
  await writeFile(
    helper,
    source.slice(0, start) +
      `export const runOnnxWorker=async()=>{console.log(JSON.stringify({pid:process.pid}));await new Promise(()=>{})}\n` +
      source.slice(end)
  )
  const { createOnnxProcess } = await import(pathToFileURL(helper).href)
  let pid = 0
  const sink = new Writable({
      write(chunk, _encoding, done) {
        const value = JSON.parse(chunk.toString())
        pid = value.pid
        done()
      }
    }),
    owner = createOnnxProcess([], () => {}, sink, sink) as Owner
  owners.push(owner)
  const rejected = expect(owner.result).rejects.toThrow('SIGKILL')
  await expect.poll(() => pid).toBeGreaterThan(0)
  await owner.stop()
  await rejected
  await gone(pid)
})

it('rejects corrupt memory telemetry and kills a child that ignores its stop protocol', async () => {
  const root = await fixture('')
  await writeFile(
    join(root, 'literature-pdf-onnx-host.mjs'),
    `process.on('message',()=>{});console.log(JSON.stringify({pid:process.pid}));process.send({type:'onnx:rss',rssBytes:'invalid'});setInterval(()=>{},1000)`
  )
  const { createOnnxProcess } = await import(pathToFileURL(join(root, 'onnx-process.mjs')).href)
  let pid = 0
  const sink = new Writable({
      write(chunk, _encoding, done) {
        pid = JSON.parse(chunk.toString()).pid
        done()
      }
    }),
    owner = createOnnxProcess([], () => {}, sink, sink) as Owner
  owners.push(owner)
  await expect(owner.result).rejects.toThrow('Invalid ONNX process memory sample')
  expect(pid).toBeGreaterThan(0)
  await gone(pid)
})

it('releases the actual process before resuming geometry through the complete supervisor IPC path', async () => {
  const { root, pid, closed } = await startHost('connected-success')
  expect(await closed).toBe(0)
  await gone(await pid)
  expect(JSON.parse(await readFile(join(root, 'geometry-proof.json'), 'utf8'))).toEqual({
    priorProcessAlive: false
  })
})
