import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { startOpenCodeService } from './opencode-service'
import type { ResolvedAgentBackend } from '../agent-framework'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  terminate: vi.fn(async () => ({ reaped: true }))
}))
vi.mock('../agent-framework/opencode', () => ({ spawnOpenCodeProcess: mocks.spawn }))
vi.mock('../process-tree', () => ({
  terminateProcessTree: mocks.terminate,
  onProcessTreeReaped: vi.fn()
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

const createChild = (): ChildProcessWithoutNullStreams & { stdout: PassThrough } =>
  Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  }) as unknown as ChildProcessWithoutNullStreams & { stdout: PassThrough }
const backend: ResolvedAgentBackend = {
  framework: { id: 'opencode' } as ResolvedAgentBackend['framework'],
  executablePath: '/runtime/opencode',
  env: { XDG_DATA_HOME: '/isolated/data' }
}

it('owns an authenticated ephemeral loopback service until one idempotent release', async () => {
  const child = createChild()
  mocks.spawn.mockReturnValue(child)
  const unexpected = vi.fn()
  const pending = startOpenCodeService(backend, unexpected)
  await Promise.resolve()
  child.stdout.write('log line\n{"url":"http://127.0.0.1:')
  child.stdout.write('42876"}\n')
  const service = await pending
  const input = mocks.spawn.mock.calls[0][0]
  expect(input.args).toEqual(['--stdio', '--port', '0', '--hostname', '127.0.0.1'])
  expect(input.env.XDG_DATA_HOME).toBe('/isolated/data')
  expect(service.api).toEqual({
    version: 2,
    baseUrl: 'http://127.0.0.1:42876',
    authorization: `Basic ${Buffer.from(`opencode:${input.env.OPENCODE_PASSWORD}`).toString('base64')}`
  })
  expect(mocks.spawn.mock.calls[0][1]).toBe('serve')
  await service.release()
  await service.release()
  expect(child.stdin.writableEnded).toBe(true)
  expect(mocks.terminate).toHaveBeenCalledExactlyOnceWith(child)
  child.emit('exit', 0)
  expect(unexpected).not.toHaveBeenCalled()
})

it.each(['exit', 'error', 'timeout', 'remote-address'] as const)(
  'reaps a service that fails startup: %s',
  async (failure) => {
    vi.useFakeTimers()
    const child = createChild()
    mocks.spawn.mockReturnValue(child)
    const pending = startOpenCodeService(backend, vi.fn())
    await Promise.resolve()
    const rejection = expect(pending).rejects.toThrow(/OpenCode HTTP service/)
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_000)
    else if (failure === 'remote-address')
      child.stdout.write('{"url":"https://external.example:443"}\n')
    else child.emit(failure, failure === 'error' ? new Error('secret diagnostic') : 1)
    await rejection
    expect(mocks.terminate).toHaveBeenCalledExactlyOnceWith(child)
    expect(child.stdin.writableEnded).toBe(true)
  }
)

it('reports an unexpected service exit after readiness', async () => {
  const child = createChild()
  mocks.spawn.mockReturnValue(child)
  const unexpected = vi.fn()
  const pending = startOpenCodeService(backend, unexpected)
  await Promise.resolve()
  child.stdout.write('{"url":"http://127.0.0.1:42876"}\n')
  const service = await pending
  child.emit('exit', 1)
  expect(unexpected).toHaveBeenCalledOnce()
  await service.release()
})

it.each([true, false])(
  'keeps the stdio lifetime lease open until tree termination settles (reaped: %s)',
  async (reaped) => {
    const child = createChild()
    mocks.spawn.mockReturnValue(child)
    let finish!: (result: { reaped: boolean }) => void
    mocks.terminate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = startOpenCodeService(backend, vi.fn())
    await Promise.resolve()
    child.stdout.write('{"url":"http://127.0.0.1:42876"}\n')
    const service = await pending
    const release = service.release()
    try {
      // An EOF can make serve exit before taskkill discovers its descendants.
      expect(child.stdin.writableEnded).toBe(false)
      expect(service.release()).toBe(release)
      expect(mocks.terminate).toHaveBeenCalledExactlyOnceWith(child)
    } finally {
      finish({ reaped })
      await release
    }
    expect(await release).toEqual({ reaped })
    expect(child.stdin.writableEnded).toBe(true)
  }
)
