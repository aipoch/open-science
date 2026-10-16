import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPdfTranslationLocalRuntime } from './local'
import type { LocalModelOwner } from '../../local-models/owner'
import { terminateProcessTree } from '../../process-tree'
import { LOCAL_MODEL_NOT_INSTALLED } from '../../../shared/local-models'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../../process-tree', () => ({
  registerOwnedPosixProcessGroup: vi.fn(),
  terminateProcessTree: vi.fn()
}))
const workers: ReturnType<typeof fakeWorker>[] = []
type FakeWorker = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: string | null
  requests: { id: string; prompt: string }[]
}
function fakeWorker(): FakeWorker {
  const worker = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    requests: [] as { id: string; prompt: string }[]
  })
  worker.stdin.on('data', (data: Buffer) => worker.requests.push(JSON.parse(data.toString())))
  return worker
}
const release = vi.fn()
const models = {
  acquireUse: vi.fn(async () => ({
    revision: 'model-v1',
    assets: [{ path: '/models/v1/config.json', file: 'config.json', sha256: 'x', size: 1 }],
    release
  }))
} as unknown as LocalModelOwner
const request = (
  target: Awaited<ReturnType<ReturnType<typeof createPdfTranslationLocalRuntime>['acquireTarget']>>,
  signal = new AbortController().signal
): Parameters<ReturnType<typeof createPdfTranslationLocalRuntime>['run']>[0] => ({
  target,
  signal,
  systemPrompt: 'Translate',
  prompt: 'source',
  outputLimitBytes: 1024
})
const respond = (worker = workers[0], text = '译文'): boolean =>
  worker.stdout.write(
    JSON.stringify({
      id: worker.requests.at(-1)!.id,
      text,
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2 }
    }) + '\n'
  )
beforeEach(() => {
  vi.clearAllMocks()
  workers.length = 0
  vi.mocked(spawn).mockImplementation(() => {
    const worker = fakeWorker()
    workers.push(worker)
    return worker as unknown as ReturnType<typeof spawn>
  })
  vi.mocked(terminateProcessTree).mockImplementation(async (child) => {
    const worker = child as unknown as ReturnType<typeof fakeWorker>
    worker.signalCode = 'SIGKILL'
    worker.emit('exit', null, 'SIGKILL')
    return { reaped: true }
  })
})
afterEach(() => vi.useRealTimers())

it('serializes across documents, reuses one worker, and holds files until the last target is released', async () => {
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  const a = await runtime.acquireTarget(),
    b = await runtime.acquireTarget()
  const first = runtime.run(request(a)),
    second = runtime.run(request(b))
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1))
  expect(workers).toHaveLength(1)
  respond()
  expect((await first).usage).toEqual({ inputTokens: 5, outputTokens: 2, cacheTokens: 0 })
  await vi.waitFor(() => expect(workers[0].requests).toHaveLength(2))
  respond()
  await second
  await runtime.release(a)
  expect(terminateProcessTree).not.toHaveBeenCalled()
  await runtime.release(b)
  expect(terminateProcessTree).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledTimes(2)
})

it('kills cancelled inference before releasing its lease and can start a fresh worker', async () => {
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  const target = await runtime.acquireTarget(),
    abort = new AbortController()
  const result = runtime.run(request(target, abort.signal))
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  abort.abort()
  await rejected
  expect(terminateProcessTree).toHaveBeenCalledOnce()
  expect(release).not.toHaveBeenCalled()
  const resumed = runtime.run(request(target))
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  respond(workers[1])
  await resumed
  await runtime.release(target)
})

it('rejects oversized or malformed output and tears down the worker', async () => {
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  const target = await runtime.acquireTarget()
  const output = runtime.run(request(target))
  const rejected = expect(output).rejects.toThrow('output limit')
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  workers[0].stdout.write('x'.repeat(6000))
  await rejected
  expect(terminateProcessTree).toHaveBeenCalledOnce()
  await runtime.release(target)
})

it('bounds hung inference and preserves a typed timeout error', async () => {
  vi.useFakeTimers()
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  const target = await runtime.acquireTarget()
  const output = runtime.run(request(target))
  const rejected = expect(output).rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(180_001)
  await rejected
  expect(terminateProcessTree).toHaveBeenCalledOnce()
  await runtime.release(target)
})

it('does not release files after unconfirmed termination; shutdown can retry', async () => {
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  const target = await runtime.acquireTarget()
  const output = runtime.run(request(target))
  await vi.waitFor(() => expect(workers).toHaveLength(1))
  respond()
  await output
  vi.mocked(terminateProcessTree).mockResolvedValueOnce({ reaped: false })
  await expect(runtime.release(target)).rejects.toThrow('unconfirmed')
  expect(release).not.toHaveBeenCalled()
  await runtime.shutdown()
  expect(release).toHaveBeenCalledOnce()
})

it('reports missing local assets without starting inference', async () => {
  vi.mocked(models.acquireUse).mockRejectedValueOnce(new Error(LOCAL_MODEL_NOT_INSTALLED))
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  await expect(runtime.acquireTarget()).rejects.toMatchObject({ code: 'unsupported-model' })
  expect(spawn).not.toHaveBeenCalled()
})

it('cancels queued work without stopping another document or holding its lease', async () => {
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  const a = await runtime.acquireTarget(),
    b = await runtime.acquireTarget()
  const first = runtime.run(request(a)),
    controller = new AbortController()
  const second = runtime.run(request(b, controller.signal))
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1))
  controller.abort()
  await rejected
  await runtime.release(b)
  expect(release).toHaveBeenCalledOnce()
  expect(terminateProcessTree).not.toHaveBeenCalled()
  respond()
  await first
  await runtime.release(a)
  expect(workers[0].requests).toHaveLength(1)
})

it('does not kill a new document acquired while the previous last lease waits for inference', async () => {
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  const a = await runtime.acquireTarget()
  const first = runtime.run(request(a))
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1))
  const releasing = runtime.release(a)
  const b = await runtime.acquireTarget()
  const next = runtime.run(request(b))
  respond()
  await first
  await releasing
  await vi.waitFor(() => expect(workers[0].requests).toHaveLength(2))
  expect(terminateProcessTree).not.toHaveBeenCalled()
  respond()
  await next
  await runtime.release(b)
  expect(terminateProcessTree).toHaveBeenCalledOnce()
})

it('waits for in-flight teardown before starting a newly acquired document', async () => {
  const runtime = createPdfTranslationLocalRuntime('/resources', models)
  const a = await runtime.acquireTarget()
  const first = runtime.run(request(a))
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1))
  respond()
  await first
  let reap: (() => void) | undefined
  vi.mocked(terminateProcessTree).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      reap = resolve
    })
    return { reaped: true }
  })
  const releasing = runtime.release(a)
  await vi.waitFor(() => expect(reap).toBeDefined())
  const b = await runtime.acquireTarget(),
    second = runtime.run(request(b))
  await Promise.resolve()
  expect(workers).toHaveLength(1)
  expect(workers[0].requests).toHaveLength(1)
  reap!()
  await releasing
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  respond(workers[1])
  await second
  await runtime.release(b)
})
