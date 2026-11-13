import { EventEmitter, once } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { nodeProcessRuntime } from '../src/node-runtime.js'

const roots: string[] = [],
  children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill('SIGKILL')
        await closed
      }
    })
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(source: string): Promise<ChildProcessWithoutNullStreams> {
  const root = await mkdtemp(join(tmpdir(), 'pdf-runtime-'))
  roots.push(root)
  const entry = join(root, 'host.mjs')
  await writeFile(entry, source)
  const child = nodeProcessRuntime.spawn(entry)
  children.push(child)
  child.stderr.resume()
  return child
}
it('rejects an unowned process without sending a signal', async () => {
  const kill = vi.fn(),
    child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill
    }) as unknown as ChildProcessWithoutNullStreams
  await expect(nodeProcessRuntime.stop(child)).rejects.toThrow('termination is unconfirmed')
  expect(kill).not.toHaveBeenCalled()
})
it('requests IPC shutdown and joins close plus private IPC acknowledgement, including retry', async () => {
  const child = await fixture(
    `process.on('message',({type})=>{if(type==='pdf:stop')process.send({type:'pdf:stopped'},()=>process.exit(1))})`
  )
  child.stdout.resume()
  await nodeProcessRuntime.stop(child)
  expect(child.exitCode).toBe(1)
  await nodeProcessRuntime.stop(child)
})
it.each(['stdout-marker', 'killed'])(
  'does not certify an already exited host without its private IPC barrier: %s',
  async (mode) => {
    const child = await fixture(
      mode === 'stdout-marker'
        ? `console.log('{"type":"pdf:stopped"}')`
        : 'setInterval(()=>{},1000)'
    )
    child.stdout.resume()
    const closed = once(child, 'close')
    if (mode === 'killed') child.kill('SIGKILL')
    await closed
    await expect(nodeProcessRuntime.stop(child)).rejects.toThrow('termination is unconfirmed')
  }
)
it('bounds a missing shutdown acknowledgement without certifying a host-only forced kill', async () => {
  const child = await fixture(
    'process.on("message",()=>{});console.log("ready");setInterval(()=>{},1000)'
  )
  await once(child.stdout, 'data')
  const baseline = child.listenerCount('close')
  vi.useFakeTimers()
  const stopping = expect(nodeProcessRuntime.stop(child)).rejects.toThrow(
    'termination is unconfirmed'
  )
  await vi.advanceTimersByTimeAsync(5000)
  await stopping
  expect(child.listenerCount('close')).toBe(baseline)
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
  await expect(nodeProcessRuntime.stop(child)).rejects.toThrow('termination is unconfirmed')
})

it('cleans its listener and timer when sending the shutdown request throws', async () => {
  const child = await fixture('setInterval(()=>{},1000)'),
    baseline = child.listenerCount('close')
  vi.spyOn(child, 'send').mockImplementation(() => {
    throw Error('closed channel')
  })
  await expect(nodeProcessRuntime.stop(child)).rejects.toThrow('termination is unconfirmed')
  expect(child.listenerCount('close')).toBe(baseline)
})
