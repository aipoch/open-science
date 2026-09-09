import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  fixture: undefined as unknown as (
    options: unknown,
    use: () => Promise<void>,
    info: unknown
  ) => Promise<void>,
  launch: vi.fn(),
  reap: vi.fn(),
  rendererFailure: vi.fn(),
  ready: vi.fn()
}))
vi.mock('@playwright/test', () => ({
  test: {
    extend: (fixtures: { app: typeof boundary.fixture }) => {
      boundary.fixture = fixtures.app
      return {}
    }
  },
  expect: { poll: () => ({ toMatchObject: boundary.ready }) }
}))
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
  boundary.rendererFailure.mockImplementation(() => undefined)
  boundary.ready.mockResolvedValue(undefined)
  close.mockResolvedValue(undefined)
  boundary.reap.mockResolvedValue({ reaped: false })
  boundary.launch.mockImplementation(async ({ env }) => {
    root = dirname(env.OPEN_SCIENCE_STORAGE_ROOT)
    const logs = join(root, 'logs')
    await mkdir(logs)
    await writeFile(join(logs, 'main.log'), 'fixture shutdown diagnostic')
    const page = {
      emulateMedia: async () => undefined,
      waitForLoadState: async () => undefined,
      evaluate: async () => ({ phase: 'ready' }),
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
