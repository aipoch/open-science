import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hoisted spawn double: process-tree spawns `taskkill` (win32) or `ps` (posix); each test wires the
// return value to a controllable EventEmitter so it can drive exit/close/error and ps output.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { terminateProcessTree } = await import('./process-tree')

// Minimal ChildProcess stand-in: an EventEmitter (so waitForExit's once('exit') resolves) exposing the
// pid/kill/killed/exitCode surface the code under test touches.
class FakeChild extends EventEmitter {
  kill = vi.fn(() => true)
  killed = false
  exitCode: number | null = null
  signalCode: string | null = null
  constructor(public pid: number | undefined) {
    super()
  }
}

// A ps stand-in: an EventEmitter with its own stdout EventEmitter, matching spawn('ps', ...).
class FakePs extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn(() => true)
}

const originalPlatform = process.platform
const setPlatform = (value: string): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  setPlatform(originalPlatform)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('terminateProcessTree (win32)', () => {
  it('kills the whole tree via taskkill and resolves when taskkill exits cleanly', async () => {
    setPlatform('win32')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(4321)

    const pending = terminateProcessTree(child as never)

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true })
    )

    killer.emit('exit', 0, null)
    await expect(pending).resolves.toBeUndefined()
    // A clean taskkill reaps the tree; no direct fallback kill is needed.
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('falls back to a direct kill when taskkill exits non-zero', async () => {
    setPlatform('win32')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(999)
    const log = { error: vi.fn() }

    const pending = terminateProcessTree(child as never, undefined, log)
    killer.emit('exit', 1, null)

    await expect(pending).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled()
  })

  it('falls back to a direct kill when taskkill emits an error', async () => {
    setPlatform('win32')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(999)
    const log = { error: vi.fn() }

    const pending = terminateProcessTree(child as never, undefined, log)
    killer.emit('error', new Error('taskkill not found'))

    await expect(pending).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled()
  })

  it('falls back to a direct kill when spawn itself throws synchronously', async () => {
    setPlatform('win32')
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    const child = new FakeChild(555)
    const log = { error: vi.fn() }

    await expect(terminateProcessTree(child as never, undefined, log)).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled()
  })

  it('with an undefined pid does not spawn taskkill and does not kill', async () => {
    setPlatform('win32')
    const child = new FakeChild(undefined)

    await expect(terminateProcessTree(child as never)).resolves.toBeUndefined()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })
})

describe('terminateProcessTree (posix)', () => {
  it('reaps descendants discovered via ps, kills the direct child, and awaits its exit', async () => {
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = new FakeChild(1000)

    const pending = terminateProcessTree(child as never, 'SIGTERM')

    expect(spawnMock).toHaveBeenCalledWith(
      'ps',
      ['-A', '-o', 'pid=,ppid='],
      expect.objectContaining({ windowsHide: true })
    )

    // 1000 -> 1001 -> 1002, plus an unrelated tree that must be ignored.
    ps.stdout.emit('data', Buffer.from('1000 1\n1001 1000\n1002 1001\n2000 1\n'))
    ps.emit('close', 0)

    // Let collectDescendantPids resolve and the kills run.
    await Promise.resolve()
    await Promise.resolve()

    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(1002, 'SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith(2000, 'SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    // Still pending until the direct child actually exits.
    child.emit('exit', 0, null)
    await expect(pending).resolves.toBeUndefined()
  })

  it('still kills the direct child when ps fails to produce a tree', async () => {
    setPlatform('darwin')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = new FakeChild(1234)

    const pending = terminateProcessTree(child as never)
    ps.emit('error', new Error('ps missing'))

    await Promise.resolve()
    await Promise.resolve()

    expect(killSpy).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith(undefined)

    child.emit('exit', 0, null)
    await expect(pending).resolves.toBeUndefined()
  })

  it('resolves via the grace timer when the child never emits exit', async () => {
    vi.useFakeTimers()
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = new FakeChild(1234)

    const pending = terminateProcessTree(child as never)
    ps.emit('close', 0)

    // Advance past the descendant-wait and the exit grace; the promise must still settle.
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('resolves immediately when the child has already exited', async () => {
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = new FakeChild(1234)
    child.exitCode = 0

    const pending = terminateProcessTree(child as never)
    ps.emit('close', 0)

    await expect(pending).resolves.toBeUndefined()
  })
})
