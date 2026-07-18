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
// pid/kill/killed/exitCode surface the code under test touches. kill() flips killed like Node does.
class FakeChild extends EventEmitter {
  kill = vi.fn(() => {
    this.killed = true
    return true
  })
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

const esrch = (): NodeJS.ErrnoException => Object.assign(new Error('ESRCH'), { code: 'ESRCH' })

const originalPlatform = process.platform
const setPlatform = (value: string): void => {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  setPlatform(originalPlatform)
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
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

  it('does not fall back spuriously after a clean taskkill even once the grace elapses', async () => {
    // Regression: the grace timer must be cleared on the success path, or it fires later and produces a
    // false timeout log plus a stray direct kill while the app keeps running.
    vi.useFakeTimers()
    setPlatform('win32')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(4321)
    const log = { error: vi.fn() }

    const pending = terminateProcessTree(child as never, undefined, log)
    killer.emit('exit', 0, null)
    await pending

    await vi.advanceTimersByTimeAsync(10_000)
    expect(child.kill).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it('falls back to a direct kill and awaits the child when taskkill exits non-zero', async () => {
    setPlatform('win32')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(999)
    const log = { error: vi.fn() }

    const pending = terminateProcessTree(child as never, undefined, log)
    // Mirror Node: a settled child process exposes its exit code, which the fallback log reads back.
    ;(killer as unknown as { exitCode: number }).exitCode = 1
    killer.emit('exit', 1, null)
    // Let the fallback reach waitForExit (attaching its exit listener) before the child exits.
    await Promise.resolve()
    await Promise.resolve()
    child.emit('exit', 0, null)

    await expect(pending).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled()
  })

  it('falls back to a direct kill and awaits the child when taskkill emits an error', async () => {
    setPlatform('win32')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(999)
    const log = { error: vi.fn() }

    const pending = terminateProcessTree(child as never, undefined, log)
    killer.emit('error', new Error('taskkill not found'))
    await Promise.resolve()
    await Promise.resolve()
    child.emit('exit', 0, null)

    await expect(pending).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled()
  })

  it('falls back and logs when taskkill hangs past the grace, then awaits the child', async () => {
    vi.useFakeTimers()
    setPlatform('win32')
    const killer = new EventEmitter() // never emits exit/error
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(777)
    const log = { error: vi.fn() }

    const pending = terminateProcessTree(child as never, undefined, log)

    // taskkill grace elapses -> fallback direct kill, then wait for the child's own exit grace.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toBeUndefined()
  })

  it('falls back to a direct kill when spawn itself throws synchronously', async () => {
    setPlatform('win32')
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    const child = new FakeChild(555)
    const log = { error: vi.fn() }

    const pending = terminateProcessTree(child as never, undefined, log)
    child.emit('exit', 0, null)

    await expect(pending).resolves.toBeUndefined()
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
  it('signals descendants and the child, and returns without escalating when everything exits', async () => {
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    // Descendants accept SIGTERM, then the alive-check (signal 0) reports them gone.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, sig) => {
      if (sig === 0) throw esrch()
      return true
    })
    const child = new FakeChild(1000)

    const pending = terminateProcessTree(child as never, 'SIGTERM')

    ps.stdout.emit('data', Buffer.from('1000 1\n1001 1000\n1002 1001\n2000 1\n'))
    ps.emit('close', 0)
    await Promise.resolve()
    await Promise.resolve()

    child.emit('exit', 0, null)
    await expect(pending).resolves.toBeUndefined()

    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(1002, 'SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith(2000, 'SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    // Nothing survived, so no SIGKILL escalation.
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGKILL')
  })

  it('escalates to SIGKILL for survivors and a child that ignores the graceful signal', async () => {
    vi.useFakeTimers()
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    // Everything stays alive: signal 0 succeeds, so survivors persist and the child never exits.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = new FakeChild(1000)

    const pending = terminateProcessTree(child as never, 'SIGTERM')

    ps.stdout.emit('data', Buffer.from('1000 1\n1001 1000\n'))
    ps.emit('close', 0)

    // Graceful grace elapses with the child still alive -> escalate.
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toBeUndefined()

    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGKILL')
    // The child that ignored SIGTERM is force-killed by pid.
    expect(killSpy).toHaveBeenCalledWith(1000, 'SIGKILL')
  })

  it('still kills the direct child when ps fails to produce a tree', async () => {
    setPlatform('darwin')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch()
    })
    const child = new FakeChild(1234)

    const pending = terminateProcessTree(child as never)
    ps.emit('error', new Error('ps missing'))
    await Promise.resolve()
    await Promise.resolve()

    child.emit('exit', 0, null)
    await expect(pending).resolves.toBeUndefined()
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('falls back to an empty tree and still terminates when ps hangs past the grace', async () => {
    vi.useFakeTimers()
    setPlatform('linux')
    const ps = new FakePs() // never emits data/close/error
    spawnMock.mockReturnValueOnce(ps)
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = new FakeChild(1234)

    const pending = terminateProcessTree(child as never)

    // ps grace elapses -> empty descendant list; then the child's graceful + SIGKILL grace elapse.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(ps.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toBeUndefined()
  })

  it('resolves immediately when the child has already exited', async () => {
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch()
    })
    const child = new FakeChild(1234)
    child.exitCode = 0

    const pending = terminateProcessTree(child as never)
    ps.emit('close', 0)

    await expect(pending).resolves.toBeUndefined()
  })
})
