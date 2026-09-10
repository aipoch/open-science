import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  fixture: undefined as unknown as (
    options: unknown,
    use: (app: { restartAfterCrash: () => Promise<unknown> }) => Promise<void>,
    info: unknown
  ) => Promise<void>,
  launch: vi.fn(),
  reap: vi.fn(),
  rendererFailure: vi.fn(),
  ready: vi.fn(),
  realPolling: false,
  readyAt: 0,
  evaluated: vi.fn()
}))
vi.mock('@playwright/test', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@playwright/test')>()
  return {
    test: {
      extend: (fixtures: { app: typeof boundary.fixture }) => {
        boundary.fixture = fixtures.app
        return {}
      }
    },
    expect: {
      poll: (...args: Parameters<typeof actual.expect.poll>) =>
        boundary.realPolling ? actual.expect.poll(...args) : { toMatchObject: boundary.ready }
    }
  }
})
vi.mock('playwright', () => ({ _electron: { launch: boundary.launch } }))
vi.mock('../src/main/process-tree', () => ({ terminateProcessTree: boundary.reap }))
vi.mock('../e2e/fixtures/renderer-failure-gate', () => ({
  RendererFailureGate: class {
    observe = async (): Promise<void> => undefined
    assertNoFailures = boundary.rendererFailure
  }
}))
import '../e2e/fixtures/electron-app'

let root: string
const close = vi.fn()
const attach = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  boundary.realPolling = false
  boundary.readyAt = 0
  boundary.rendererFailure.mockImplementation(() => undefined)
  boundary.ready.mockResolvedValue(undefined)
  close.mockResolvedValue(undefined)
  boundary.reap.mockResolvedValue({ reaped: false })
  boundary.launch.mockImplementation(async ({ env }) => {
    root = dirname(env.OPEN_SCIENCE_STORAGE_ROOT)
    const logs = join(root, 'logs')
    await mkdir(logs, { recursive: true })
    await writeFile(join(logs, 'main.log'), 'fixture shutdown diagnostic')
    const page = {
      emulateMedia: async () => undefined,
      waitForLoadState: async () => undefined,
      evaluate: async () => {
        boundary.evaluated()
        return { phase: performance.now() >= boundary.readyAt ? 'ready' : 'starting' }
      },
      getByText: () => ({ waitFor: async () => undefined }),
      reload: async () => undefined
    }
    return {
      firstWindow: async () => page,
      evaluate: async () => logs,
      close,
      process: () => ({ pid: 12345 })
    }
  })
})
afterEach(async () => {
  vi.useRealTimers()
  if (root) await rm(root, { recursive: true, force: true })
})

it('removes the owned root after successful fixture teardown', async () => {
  await boundary.fixture({ windowMode: 'hidden' }, async () => undefined, {
    status: 'passed',
    expectedStatus: 'passed',
    attach
  })
  expect(existsSync(root)).toBe(false)
})

it.each(['not reaped', 'rejected', 'timeout'])(
  'fails teardown and retains diagnostics when forced cleanup is %s',
  async (failure) => {
    close.mockRejectedValue(new Error('graceful close failed'))
    if (failure === 'rejected')
      boundary.reap.mockRejectedValue(new Error('forced cleanup rejected'))
    if (failure === 'timeout') {
      vi.useFakeTimers()
      boundary.reap.mockReturnValue(new Promise(() => {}))
    }
    const operation = boundary.fixture({ windowMode: 'hidden' }, async () => undefined, {
      status: 'passed',
      expectedStatus: 'passed',
      attach
    })
    const rejected = expect(operation).rejects.toThrow(/reap|forced/i)
    if (failure === 'timeout') {
      await vi.waitFor(() => expect(boundary.reap).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await rejected
    expect(existsSync(join(root, 'logs', 'main.log'))).toBe(true)
    expect(attach).toHaveBeenCalledWith(
      'cleanup-main-process-log',
      expect.objectContaining({ contentType: 'text/plain' })
    )
  }
)

it('preserves test-body and cleanup errors together', async () => {
  const bodyError = new Error('original assertion failed')
  close.mockRejectedValue(new Error('graceful close failed'))
  const operation = boundary.fixture(
    { windowMode: 'hidden' },
    async () => {
      throw bodyError
    },
    { status: 'failed', expectedStatus: 'passed', attach }
  )
  const error = await operation.catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(AggregateError)
  expect((error as AggregateError).errors[0]).toBe(bodyError)
  expect(String((error as AggregateError).errors[1])).toContain('did not reap')
  expect(existsSync(root)).toBe(true)
})

it('preserves renderer and cleanup errors together', async () => {
  close.mockRejectedValue(new Error('graceful close failed'))
  boundary.rendererFailure.mockImplementation(() => {
    throw new Error('renderer exception')
  })
  await expect(
    boundary.fixture({ windowMode: 'hidden' }, async () => undefined, {
      status: 'passed',
      expectedStatus: 'passed',
      attach
    })
  ).rejects.toThrow(/did not reap.*renderer exception/)
})

it('preserves a renderer-only failure after successful cleanup', async () => {
  const rendererError = new Error('renderer exception')
  boundary.rendererFailure.mockImplementation(() => {
    throw rendererError
  })
  await expect(
    boundary.fixture({ windowMode: 'hidden' }, async () => undefined, {
      status: 'passed',
      expectedStatus: 'passed',
      attach
    })
  ).rejects.toBe(rendererError)
  expect(existsSync(root)).toBe(false)
})

it('attaches startup diagnostics before disposing a failed renderer launch', async () => {
  const startupError = new Error('database remained migrating')
  boundary.ready.mockRejectedValue(startupError)
  await expect(
    boundary.fixture({ windowMode: 'hidden' }, async () => undefined, {
      status: 'failed',
      expectedStatus: 'passed',
      attach
    })
  ).rejects.toBe(startupError)
  expect(attach).toHaveBeenCalledWith(
    'startup-main-process-log',
    expect.objectContaining({ contentType: 'text/plain' })
  )
  expect(existsSync(root)).toBe(false)
})

it('allows a fresh profile to finish initialization after a minute of migration work', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  boundary.realPolling = true
  boundary.readyAt = 65_000
  const install = vi.fn(async () => undefined)
  const operation = boundary
    .fixture({ windowMode: 'hidden' }, install, {
      status: 'passed',
      expectedStatus: 'passed',
      attach
    })
    .then(
      () => undefined,
      (error: unknown) => error
    )
  await vi.waitFor(() => expect(boundary.evaluated).toHaveBeenCalled())
  await vi.advanceTimersByTimeAsync(70_000)
  expect(await operation).toBeUndefined()
  expect(install).toHaveBeenCalledOnce()
})

it('still fails with diagnostics when initialization never finishes', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  boundary.realPolling = true
  boundary.readyAt = Number.POSITIVE_INFINITY
  const install = vi.fn(async () => undefined)
  const operation = boundary
    .fixture({ windowMode: 'hidden' }, install, {
      status: 'failed',
      expectedStatus: 'passed',
      attach
    })
    .then(
      () => undefined,
      (error: unknown) => error
    )
  await vi.waitFor(() => expect(boundary.evaluated).toHaveBeenCalled())
  await vi.advanceTimersByTimeAsync(100_000)
  expect(String(await operation)).toContain('while waiting on the predicate')
  expect(install).not.toHaveBeenCalled()
  expect(attach).toHaveBeenCalledWith(
    'startup-main-process-log',
    expect.objectContaining({ contentType: 'text/plain' })
  )
})

it.each([true, false])(
  'requires confirmed process termination before a crash restart (reaped=%s)',
  async (reaped) => {
    boundary.reap.mockResolvedValue({ reaped })
    const operation = boundary.fixture(
      { windowMode: 'hidden' },
      async (app) => {
        await app.restartAfterCrash()
      },
      { status: reaped ? 'passed' : 'failed', expectedStatus: 'passed', attach }
    )
    if (reaped) await operation
    else await expect(operation).rejects.toThrow('crash simulation did not reap')
    expect(boundary.reap).toHaveBeenCalledOnce()
    expect(boundary.launch).toHaveBeenCalledTimes(reaped ? 2 : 1)
  }
)
