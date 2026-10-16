import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { createLocalTextRuntime, type LocalTextRuntime, type LocalProcessOwner } from '../local'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

type FakeWorker = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number | undefined
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  requests: { id: string; directory: string; prompt: string }[]
}
function worker(): FakeWorker {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123,
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true),
    exitCode: null,
    signalCode: null,
    requests: [] as { id: string; directory: string; prompt: string }[]
  })
  child.stdin.on('data', (chunk: Buffer) => child.requests.push(JSON.parse(chunk.toString())))
  return child
}
function setup(): {
  runtime: LocalTextRuntime
  workers: FakeWorker[]
  launch: ReturnType<typeof vi.fn<LocalProcessOwner['launch']>>
  terminate: ReturnType<typeof vi.fn<LocalProcessOwner['terminate']>>
  reply(index?: number, value?: Record<string, unknown>): boolean
} {
  const workers: ReturnType<typeof worker>[] = []
  const launch = vi.fn(() => {
    const child = worker()
    workers.push(child)
    return child as unknown as ChildProcessWithoutNullStreams
  })
  const terminate = vi.fn<LocalProcessOwner['terminate']>(async () => {})
  const runtime = createLocalTextRuntime({ process: { launch, terminate }, timeoutMs: 1000 })
  const reply = (index = 0, value: Record<string, unknown> = {}): boolean =>
    workers[index].stdout.write(
      JSON.stringify({
        id: workers[index].requests.at(-1)!.id,
        text: 'answer',
        stopReason: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 1 },
        ...value
      }) + '\n'
    )
  return { runtime, workers, launch, terminate, reply }
}
afterEach(() => vi.useRealTimers())

it('owns request framing, serialization, worker reuse and opaque model handles', async () => {
  const { runtime, workers, launch, terminate, reply } = setup()
  const a = runtime.createModel({ directory: '/models/a' }),
    b = runtime.createModel({ directory: '/models/a' })
  const first = a.generate({ prompt: 'first' }),
    second = b.generate({ prompt: 'second' })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
  expect(a).toMatchObject({ providerId: 'local', capability: 'text-generation' })
  expect(a).not.toHaveProperty('directory')
  reply()
  expect(await first).toEqual({
    text: 'answer',
    stopReason: 'end_turn',
    usage: { inputTokens: 3, outputTokens: 1, cacheTokens: 0 }
  })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(2), { interval: 1 })
  reply()
  await second
  await a.dispose()
  expect(terminate).not.toHaveBeenCalled()
  await b.dispose()
  expect(terminate).toHaveBeenCalledOnce()
  expect(launch).toHaveBeenCalledOnce()
  await expect(b.generate({ prompt: 'closed' })).rejects.toThrow('no longer available')
  await runtime.dispose()
})

it.each([
  { id: 'wrong' },
  { usage: { inputTokens: -1, outputTokens: 1 } },
  { stopReason: 'unknown' },
  { error: 'inference-failed' },
  { text: 'x'.repeat(33) }
])(
  'rejects invalid worker results and terminates before permitting another run: %j',
  async (value) => {
    const { runtime, workers, reply, terminate } = setup(),
      model = runtime.createModel({ directory: '/models/a' })
    const result = model.generate({ prompt: 'test', outputLimitBytes: 32 })
    const rejected = expect(result).rejects.toThrow()
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
    reply(0, value)
    await rejected
    expect(terminate).toHaveBeenCalledOnce()
    await runtime.dispose()
  }
)

it('waits for active inference before releasing its handle even when another handle exists', async () => {
  const { runtime, workers, reply, terminate } = setup(),
    a = runtime.createModel({ directory: '/models/a' })
  const b = runtime.createModel({ directory: '/models/a' })
  const work = a.generate({ prompt: 'test' })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
  let disposed = false
  const disposal = a.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  reply()
  await work
  await disposal
  expect(terminate).not.toHaveBeenCalled()
  await b.dispose()
  await runtime.dispose()
})

it('keeps the process after unconfirmed termination and retries disposal', async () => {
  const { runtime, workers, reply, terminate } = setup(),
    model = runtime.createModel({ directory: '/models/a' })
  const work = model.generate({ prompt: 'test' })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
  reply()
  await work
  terminate.mockRejectedValueOnce(new Error('termination unconfirmed'))
  await expect(model.dispose()).rejects.toThrow('unconfirmed')
  await model.dispose()
  expect(terminate).toHaveBeenCalledTimes(2)
  await runtime.dispose()
})

it('restarts the worker for a different model directory rather than mixing revisions', async () => {
  const { runtime, workers, reply, terminate } = setup(),
    a = runtime.createModel({ directory: '/models/a' }),
    b = runtime.createModel({ directory: '/models/b' })
  const first = a.generate({ prompt: 'a' })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
  reply()
  await first
  const second = b.generate({ prompt: 'b' })
  await vi.waitFor(() => expect(workers[1]?.requests).toHaveLength(1), { interval: 1 })
  reply(1)
  await second
  expect(terminate).toHaveBeenCalledOnce()
  expect(workers[1].requests[0].directory).toBe('/models/b')
  await runtime.dispose()
})

it.each([false, true])(
  'confirms directory release with a different handle present (active: %s)',
  async (active) => {
    const { runtime, workers, reply, terminate } = setup()
    const a = runtime.createModel({ directory: '/models/a' })
    const b = runtime.createModel({ directory: '/models/b' })
    const work = a.generate({ prompt: 'a' })
    await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
    if (!active) {
      reply()
      await work
    }
    let reaped!: () => void
    terminate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          reaped = resolve
        })
    )
    let disposed = false
    const disposal = a.dispose().then(() => {
      disposed = true
    })
    if (active) {
      reply()
      await work
    }
    await vi.waitFor(() => expect(reaped).toBeTypeOf('function'), { interval: 1 })
    expect(disposed).toBe(false)
    const next = b.generate({ prompt: 'b' })
    await Promise.resolve()
    expect(workers).toHaveLength(1)
    reaped()
    await disposal
    await vi.waitFor(() => expect(workers[1]?.requests).toHaveLength(1), { interval: 1 })
    reply(1)
    await next
    await runtime.dispose()
  }
)

it('retains a directory after failed disposal even with another directory registered', async () => {
  const { runtime, workers, reply, terminate } = setup()
  const a = runtime.createModel({ directory: '/models/a' })
  runtime.createModel({ directory: '/models/b' })
  const work = a.generate({ prompt: 'a' })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
  reply()
  await work
  terminate.mockRejectedValueOnce(new Error('unconfirmed'))
  await expect(a.dispose()).rejects.toThrow('unconfirmed')
  await a.dispose()
  expect(terminate).toHaveBeenCalledTimes(2)
  await runtime.dispose()
})

it('bounds hung inference and prevents calls after runtime disposal', async () => {
  vi.useFakeTimers()
  const { runtime, terminate } = setup(),
    model = runtime.createModel({ directory: '/models/a' })
  const result = model.generate({ prompt: 'test' }),
    rejected = expect(result).rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(1001)
  await rejected
  expect(terminate).toHaveBeenCalledOnce()
  await runtime.dispose()
  expect(() => runtime.createModel({ directory: '/models/b' })).toThrow('closed')
})

it('does not launch a new revision after shutdown starts during worker termination', async () => {
  const { runtime, workers, reply, terminate, launch } = setup()
  const a = runtime.createModel({ directory: '/models/a' }),
    b = runtime.createModel({ directory: '/models/b' })
  const first = a.generate({ prompt: 'first' })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
  reply()
  await first
  let reaped!: () => void
  terminate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        reaped = resolve
      })
  )
  const next = b.generate({ prompt: 'second' }),
    rejected = expect(next).rejects.toThrow('closed')
  await vi.waitFor(() => expect(reaped).toBeTypeOf('function'), { interval: 1 })
  const closed = runtime.dispose()
  reaped()
  await rejected
  await closed
  expect(launch).toHaveBeenCalledOnce()
})

it('accepts explicitly undefined optional settings and cancels queued work without killing active inference', async () => {
  const { runtime, workers, reply, terminate } = setup()
  const a = runtime.createModel({ directory: '/models/a' }),
    b = runtime.createModel({ directory: '/models/a' })
  const first = a.generate({
    prompt: 'first',
    systemPrompt: undefined,
    signal: undefined,
    outputLimitBytes: undefined
  })
  const controller = new AbortController()
  const queued = b.generate({ prompt: 'second', signal: controller.signal }),
    rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(workers[0]?.requests).toHaveLength(1), { interval: 1 })
  controller.abort()
  await rejected
  await b.dispose()
  expect(terminate).not.toHaveBeenCalled()
  reply()
  await first
  await a.dispose()
  await runtime.dispose()
  expect(workers[0].requests).toHaveLength(1)
})

it('preserves a failed default spawn and disposes without waiting for an impossible exit', async () => {
  vi.useFakeTimers()
  const child = worker()
  child.pid = undefined
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams)
  const runtime = createLocalTextRuntime()
  const model = runtime.createModel({ directory: '/models/a' })
  const failure = Object.assign(new Error('spawn failed'), { code: 'EAGAIN' })
  const result = model.generate({ prompt: 'hello' })
  const rejected = expect(result).rejects.toBe(failure)
  await vi.advanceTimersByTimeAsync(0)
  child.emit('error', failure)
  await rejected
  await runtime.dispose()
  expect(child.kill).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('default disposal confirms exit and supports a retry after unconfirmed termination', async () => {
  vi.useFakeTimers()
  const child = worker()
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams)
  const runtime = createLocalTextRuntime()
  const model = runtime.createModel({ directory: '/models/a' })
  const result = model.generate({ prompt: 'hello' })
  await vi.advanceTimersByTimeAsync(0)
  child.stdout.write(
    JSON.stringify({
      id: child.requests[0].id,
      text: 'hello',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 }
    }) + '\n'
  )
  await result
  const disposal = model.dispose()
  const rejected = expect(disposal).rejects.toThrow('unconfirmed')
  await vi.advanceTimersByTimeAsync(5000)
  await rejected
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  let disposed = false
  const retried = model.dispose().then(() => {
    disposed = true
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(disposed).toBe(false)
  child.signalCode = 'SIGKILL'
  child.emit('exit', null, 'SIGKILL')
  await retried
  await runtime.dispose()
  expect(child.listenerCount('exit')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
