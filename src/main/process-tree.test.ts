import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hoisted spawn double: process-tree spawns `taskkill` (win32) or `ps` (posix); each test wires the
// return value to a controllable EventEmitter so it can drive exit/close/error and ps output.
const { readFileMock, readFileSyncMock, readdirMock, spawnMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  readdirMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock, readdir: readdirMock }))

const {
  createPosixProcessTreeOwnership,
  registerOwnedPosixProcessGroup,
  trackOwnedPosixProcessTree,
  terminateProcessTree
} = await import('./process-tree')

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

const linuxStat = (
  pid: number,
  ppid: number,
  pgid: number,
  sid: number,
  starttime: number
): string =>
  `${pid} (test process) S ${ppid} ${pgid} ${sid} ${[...Array(15).fill('0'), starttime, 0, 0].join(' ')}`

const trackLinux = (child: FakeChild, starttime: number): void => {
  readFileSyncMock.mockReturnValueOnce(
    linuxStat(child.pid as number, process.pid, child.pid as number, child.pid as number, starttime)
  )
  trackOwnedPosixProcessTree(child as never)
}

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
    await expect(pending).resolves.toEqual({ reaped: true })
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

    // Fallback direct kill can't reach grandchildren taskkill would have reaped, so reaped is false.
    await expect(pending).resolves.toEqual({ reaped: false })
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

    await expect(pending).resolves.toEqual({ reaped: false })
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
    await expect(pending).resolves.toEqual({ reaped: false })
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

    await expect(pending).resolves.toEqual({ reaped: false })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled()
  })

  it('with an undefined pid does not spawn taskkill and reports the tree reaped', async () => {
    setPlatform('win32')
    const child = new FakeChild(undefined)

    // No pid means nothing spawned/already gone — nothing left to reap.
    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
  })
})

describe('terminateProcessTree (posix)', () => {
  it.each(['linux', 'darwin'] as const)(
    'preserves inherited environment when marking %s process ownership',
    (platform) => {
      const ownership = createPosixProcessTreeOwnership(undefined, platform)
      expect(ownership.token).toEqual(expect.any(String))
      expect(ownership.env).toMatchObject(process.env)
      expect(ownership.env?.OPEN_SCIENCE_PROCESS_TREE_ID).toBe(ownership.token)
      expect(createPosixProcessTreeOwnership(undefined, platform).token).not.toBe(ownership.token)
    }
  )

  it.each([false, true])(
    'checks inherited ownership against Linux PID reuse: %s',
    async (reused) => {
      setPlatform('linux')
      const marker = 'command-ownership'
      const child = new FakeChild(1000)
      let releaseFirstSample: ((entries: string[]) => void) | undefined
      readdirMock
        .mockImplementationOnce(
          () =>
            new Promise<string[]>((resolve) => {
              releaseFirstSample = resolve
            })
        )
        .mockResolvedValue(['2000', '3000'])
      readFileMock.mockImplementation(async (path: string) =>
        path.includes('/2000/')
          ? linuxStat(2000, 1, 2000, 2000, 200)
          : linuxStat(3000, 1, 3000, 3000, 300)
      )
      readFileSyncMock.mockImplementation((path: string) => {
        if (path === '/proc/1000/stat') return linuxStat(1000, process.pid, 1000, 1000, 100)
        if (path === '/proc/2000/environ')
          return Buffer.from('OTHER=x\0OPEN_SCIENCE_PROCESS_TREE_ID=' + marker + '\0')
        if (path === '/proc/2000/stat') return linuxStat(2000, 1, 2000, 2000, reused ? 201 : 200)
        return Buffer.from('OPEN_SCIENCE_PROCESS_TREE_ID=unrelated\0')
      })
      let helperAlive = true
      const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
        if (signal === 0 && !helperAlive) throw esrch()
        if (signal === 'SIGTERM') helperAlive = false
        return true
      })
      try {
        trackOwnedPosixProcessTree(child as never, marker)
        child.exitCode = 0
        releaseFirstSample?.(['2000', '3000'])
        await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
        if (reused) expect(kill).not.toHaveBeenCalled()
        else expect(kill).toHaveBeenCalledWith(2000, 'SIGTERM')
        expect(kill).not.toHaveBeenCalledWith(3000, expect.anything())
        expect(kill).not.toHaveBeenCalledWith(-3000, expect.anything())
      } finally {
        readFileSyncMock.mockReset()
        readFileMock.mockReset()
        readdirMock.mockReset()
      }
    }
  )

  it('pins the spawned Linux leader before a delayed first table sample observes its exit', async () => {
    setPlatform('linux')
    let releaseFirstSample: ((entries: string[]) => void) | undefined
    readdirMock
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            releaseFirstSample = resolve
          })
      )
      .mockResolvedValueOnce(['2000'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(2000, 1, 2000, 2000, 200))
      .mockResolvedValueOnce(linuxStat(2000, 1, 2000, 2000, 200))
    const child = new FakeChild(1000)

    trackLinux(child, 100)
    child.exitCode = 0
    releaseFirstSample?.(['2000'])

    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
  })

  it('signals the exact live Linux leader when an unrelated proc entry disappears with ESRCH', async () => {
    setPlatform('linux')
    readdirMock.mockResolvedValueOnce(['1000', '1001']).mockResolvedValueOnce(['1000'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1000, process.pid, 1000, 1000, 100))
      .mockRejectedValueOnce(esrch())
      .mockResolvedValueOnce(linuxStat(1000, process.pid, 1000, 1000, 100))
    let alive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid === 1000 || pid === -1000).toBe(true)
      if (signal === 0 && !alive) throw esrch()
      if (signal === 'SIGTERM') alive = false
      return true
    })
    const child = new FakeChild(1000)

    trackLinux(child, 100)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))

    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
    expect(killSpy).toHaveBeenCalledWith(-1000, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(1000, 'SIGTERM')
  })

  it('reaps an owned-group child created before the first Linux table sample', async () => {
    setPlatform('linux')
    let releaseFirstSample: ((entries: string[]) => void) | undefined
    readdirMock
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            releaseFirstSample = resolve
          })
      )
      .mockResolvedValueOnce(['1001'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1001, 1, 1000, 1000, 101))
      .mockResolvedValueOnce(linuxStat(1001, 1, 1000, 1000, 101))
    let groupAlive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-1000)
      if (signal === 0 && !groupAlive) throw esrch()
      if (signal === 'SIGTERM') groupAlive = false
      return true
    })
    const child = new FakeChild(1000)

    trackLinux(child, 100)
    child.exitCode = 0
    releaseFirstSample?.(['1001'])

    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
    expect(killSpy).toHaveBeenCalledWith(-1000, 'SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith(1001, expect.anything())
  })

  it('reaps a reparented setsid descendant by its captured start identity', async () => {
    setPlatform('linux')
    readdirMock.mockResolvedValueOnce(['1000', '1001']).mockResolvedValueOnce(['1001'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 100))
      .mockResolvedValueOnce(linuxStat(1001, 1000, 1000, 1000, 101))
      .mockResolvedValueOnce(linuxStat(1001, 1, 1001, 1001, 101))
    let helperAlive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -1000) throw esrch()
      if (pid === -1001) {
        if (signal === 0 && !helperAlive) throw esrch()
        if (signal === 'SIGTERM') helperAlive = false
        return true
      }
      expect(pid).toBe(1001)
      if (signal === 0 && !helperAlive) throw esrch()
      if (signal === 'SIGTERM') helperAlive = false
      return true
    })
    const child = new FakeChild(1000)
    trackLinux(child, 100)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))
    child.exitCode = 0

    const pending = terminateProcessTree(child as never)

    await expect(pending).resolves.toEqual({ reaped: true })
    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(-1001, 'SIGTERM')
  })

  it('reports tracked teardown incomplete when a proc entry cannot be read with EACCES', async () => {
    setPlatform('linux')
    readdirMock.mockResolvedValueOnce(['1000', '1001']).mockResolvedValueOnce(['2000'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 100))
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      .mockResolvedValueOnce(linuxStat(2000, 1, 2000, 2000, 200))
    const killSpy = vi.spyOn(process, 'kill')
    const child = new FakeChild(1000)
    trackLinux(child, 100)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))
    child.exitCode = 0

    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: false })
    expect(killSpy).not.toHaveBeenCalledWith(1001, expect.anything())
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('does not adopt or signal a same-second replacement of the tracked leader pid', async () => {
    setPlatform('linux')
    readdirMock.mockResolvedValueOnce(['1000', '1001']).mockResolvedValueOnce(['1000'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 100))
      .mockResolvedValueOnce(linuxStat(1001, 1000, 1000, 1000, 101))
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 200))
    let replacementAlive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 1000 && signal === 0 && !replacementAlive) throw esrch()
      if (pid === 1000 && signal === 'SIGTERM') replacementAlive = false
      return true
    })
    const child = new FakeChild(1000)

    trackLinux(child, 100)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))
    child.exitCode = 0

    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
    expect(killSpy).not.toHaveBeenCalledWith(1000, 'SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith(-1000, 'SIGTERM')
  })

  it('never adopts a leader pid that first appears after a complete sample found it missing', async () => {
    setPlatform('linux')
    readdirMock.mockResolvedValueOnce(['1001']).mockResolvedValueOnce(['1000'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1001, 1, 1001, 1001, 101))
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 200))
    const killSpy = vi.spyOn(process, 'kill')
    const child = new FakeChild(1000)

    readFileSyncMock.mockImplementationOnce(() => {
      throw new Error('leader already exited')
    })
    trackOwnedPosixProcessTree(child as never)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(1))

    const pending = terminateProcessTree(child as never)
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'))
    child.emit('exit', 0, null)

    await expect(pending).resolves.toEqual({ reaped: false })
    expect(killSpy).not.toHaveBeenCalledWith(1000, 'SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith(-1000, 'SIGTERM')
  })

  it('gives a tracker registered during an older in-flight sample a fresh ownership sample', async () => {
    setPlatform('linux')
    let releaseFirstSample: ((entries: string[]) => void) | undefined
    readdirMock
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            releaseFirstSample = resolve
          })
      )
      .mockResolvedValueOnce(['2000', '2001'])
      .mockResolvedValueOnce(['2001'])
      .mockResolvedValueOnce([])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 100))
      .mockResolvedValueOnce(linuxStat(2000, 1, 2000, 2000, 200))
      .mockResolvedValueOnce(linuxStat(2001, 2000, 2000, 2000, 201))
      .mockResolvedValueOnce(linuxStat(2001, 1, 2001, 2001, 201))
    let helperAlive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -2001) {
        if (signal === 0 && !helperAlive) throw esrch()
        if (signal === 'SIGTERM') helperAlive = false
        return true
      }
      expect(pid).toBe(2001)
      if (signal === 0 && !helperAlive) throw esrch()
      if (signal === 'SIGTERM') helperAlive = false
      return true
    })
    const firstChild = new FakeChild(1000)
    const secondChild = new FakeChild(2000)

    trackLinux(firstChild, 100)
    await vi.waitFor(() => expect(readdirMock).toHaveBeenCalledTimes(1))
    trackLinux(secondChild, 200)
    releaseFirstSample?.(['1000'])

    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(3))
    secondChild.exitCode = 0
    await expect(terminateProcessTree(secondChild as never)).resolves.toEqual({ reaped: true })
    expect(killSpy).toHaveBeenCalledWith(2001, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(-2001, 'SIGTERM')

    firstChild.exitCode = 0
    await terminateProcessTree(firstChild as never)
  })

  it('does not signal a replacement that reused a tracked pid within the same second', async () => {
    setPlatform('linux')
    readdirMock.mockResolvedValueOnce(['1000', '1001']).mockResolvedValueOnce(['1001'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 100))
      .mockResolvedValueOnce(linuxStat(1001, 1000, 1001, 1001, 101))
      .mockResolvedValueOnce(linuxStat(1001, 1, 1001, 1001, 102))
    const killSpy = vi.spyOn(process, 'kill')
    const child = new FakeChild(1000)

    trackLinux(child, 100)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))
    child.exitCode = 0

    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
    expect(killSpy).not.toHaveBeenCalledWith(1001, expect.anything())
  })

  it('uses the detached group but fails closed without a Darwin leader identity', async () => {
    setPlatform('darwin')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    let groupAlive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-1000)
      if (signal === 0 && !groupAlive) throw esrch()
      if (signal === 'SIGTERM') groupAlive = false
      return true
    })
    const child = new FakeChild(1000)
    child.exitCode = 0

    trackOwnedPosixProcessTree(child as never)
    const pending = terminateProcessTree(child as never)
    ps.stdout.emit('data', Buffer.from('1000 1\n'))
    ps.emit('close', 0)

    await expect(pending).resolves.toEqual({ reaped: false })
    expect(killSpy).toHaveBeenCalledWith(-1000, 'SIGTERM')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('retains an owned group identity after its leader exits', async () => {
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    let groupAlive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect(pid).toBe(-1000)
      if (signal === 0 && !groupAlive) throw esrch()
      if (signal === 'SIGTERM') groupAlive = false
      return true
    })
    const child = new FakeChild(1000)
    child.exitCode = 0
    registerOwnedPosixProcessGroup(child as never)

    const pending = terminateProcessTree(child as never)
    ps.emit('close', 0)

    await expect(pending).resolves.toEqual({ reaped: true })
    expect(killSpy).toHaveBeenCalledWith(-1000, 'SIGTERM')
  })

  it('escalates an explicitly owned process group after snapshotting its descendants', async () => {
    vi.useFakeTimers()
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    let groupAlive = true
    let detachedDescendantAlive = true
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -1000) {
        if (signal === 0 && !groupAlive) throw esrch()
        if (signal === 'SIGKILL') groupAlive = false
        return true
      }
      expect(pid).toBe(1001)
      if (signal === 0 && !detachedDescendantAlive) throw esrch()
      if (signal === 'SIGKILL') detachedDescendantAlive = false
      return true
    })
    const child = new FakeChild(1000)
    registerOwnedPosixProcessGroup(child as never)

    const pending = terminateProcessTree(child as never)

    ps.stdout.emit('data', Buffer.from('1000 1\n1001 1000\n'))
    ps.emit('close', 0)
    await Promise.resolve()
    await Promise.resolve()
    expect(killSpy).toHaveBeenCalledWith(-1000, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(pending).resolves.toEqual({ reaped: true })
    expect(killSpy).toHaveBeenCalledWith(-1000, 'SIGKILL')
    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGKILL')
    expect(child.kill).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledWith(
      'ps',
      ['-A', '-o', 'pid=,ppid='],
      expect.objectContaining({ windowsHide: true })
    )
  })

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
    await expect(pending).resolves.toEqual({ reaped: true })

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
    // Survivors stay alive and the child never exits, so the tree was not cleanly reaped.
    await expect(pending).resolves.toEqual({ reaped: false })

    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(1001, 'SIGKILL')
    // The child that ignored SIGTERM is force-killed by pid.
    expect(killSpy).toHaveBeenCalledWith(1000, 'SIGKILL')
  })

  it.each(['linux', 'darwin'])(
    'waits for descendants to disappear after SIGKILL when the parent exits first on %s',
    async (platform) => {
      vi.useFakeTimers()
      setPlatform(platform)
      const ps = new FakePs()
      spawnMock.mockReturnValueOnce(ps)
      let descendantAlive = true
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        expect(pid).toBe(1001)
        if (signal === 0 && !descendantAlive) throw esrch()
        if (signal === 'SIGKILL') setTimeout(() => (descendantAlive = false), 100)
        return true
      })
      const child = new FakeChild(1000)
      const settled = vi.fn()
      const pending = terminateProcessTree(child as never).then(settled)

      ps.stdout.emit('data', Buffer.from('1000 1\n1001 1000\n'))
      ps.emit('close', 0)
      await Promise.resolve()
      await Promise.resolve()
      child.emit('exit', 0, null)
      await vi.advanceTimersByTimeAsync(100)
      await pending

      expect(killSpy).toHaveBeenCalledWith(1001, 'SIGKILL')
      expect(settled).toHaveBeenCalledExactlyOnceWith({ reaped: true })
    }
  )

  it('kills the direct child but reports unconfirmed when ps fails to produce a tree', async () => {
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
    // The direct child exited, but failed discovery cannot prove there were no surviving descendants.
    await expect(pending).resolves.toEqual({ reaped: false })
    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reports unconfirmed when ps exits non-zero without a process snapshot', async () => {
    setPlatform('linux')
    const ps = new FakePs()
    spawnMock.mockReturnValueOnce(ps)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch()
    })
    const child = new FakeChild(1234)

    const pending = terminateProcessTree(child as never)
    ps.emit('close', 1)
    await Promise.resolve()
    await Promise.resolve()
    child.emit('exit', 0, null)

    await expect(pending).resolves.toEqual({ reaped: false })
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
    // The child never exits within its grace, so reaped is false.
    await expect(pending).resolves.toEqual({ reaped: false })
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

    await expect(pending).resolves.toEqual({ reaped: true })
  })
})
