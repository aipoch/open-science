import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A terminateProcessTree double whose promise we resolve by hand, so the test can prove shutdown()
// actually awaits an in-flight tree-kill that a hard timeout started (rather than racing app.exit).
const { terminateMock, resolveTermination } = vi.hoisted(() => {
  let resolveFn: (result: { reaped: boolean }) => void = () => {}
  const terminateMock = vi.fn(
    () =>
      new Promise<{ reaped: boolean }>((resolve) => {
        resolveFn = resolve
      })
  )
  return { terminateMock, resolveTermination: (): void => resolveFn({ reaped: true }) }
})
vi.mock('../process-tree', () => ({ terminateProcessTree: terminateMock }))

// A spawn double whose child accepts stdin writes but never answers, forcing execute() to time out.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

const { NotebookPythonExecutor } = await import('./python-executor')

class FakeChild extends EventEmitter {
  pid = 4321
  killed = false
  stdin = { write: vi.fn() }
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}

const baseRequest = {
  cwd: '/tmp/session',
  notebookSessionRoot: '/tmp/session/notebooks',
  dataRoot: '/tmp/session/data',
  runtimeRoot: '/tmp/session/runtime'
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('NotebookPythonExecutor shutdown after a hard timeout', () => {
  it('awaits the timeout-triggered tree-kill before resolving', async () => {
    const child = new FakeChild()
    // Let ensureStarted resolve its 'spawn' wait; the child never emits a bridge response line.
    spawnMock.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'))
      return child
    })

    const executor = new NotebookPythonExecutor('python3')
    const result = await executor.execute({ ...baseRequest, code: 'sleep', timeoutMs: 20 })

    // The hard timeout dropped the interpreter from reuse and started a tree-kill we control.
    expect(result.status).toBe('timeout')
    expect(terminateMock).toHaveBeenCalledTimes(1)

    let shutdownDone = false
    const shutdown = executor.shutdown().then(() => {
      shutdownDone = true
    })

    // shutdown() must not resolve while the tree-kill is still in flight.
    await new Promise((resolve) => setImmediate(resolve))
    expect(shutdownDone).toBe(false)

    resolveTermination()
    await shutdown
    expect(shutdownDone).toBe(true)
  })
})
