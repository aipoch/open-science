import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted spawn double: process-tree spawns `taskkill` (win32) or `ps` (posix); each test wires the
// return value to a controllable EventEmitter so it can drive exit/close/error and ps output.
const { readFileMock, readFileSyncMock, readdirMock, readdirSyncMock, statSyncMock, spawnMock } =
  vi.hoisted(() => ({
    readFileMock: vi.fn(),
    readFileSyncMock: vi.fn(),
    readdirMock: vi.fn(),
    readdirSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    spawnMock: vi.fn()
  }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs', () => ({
  readFileSync: readFileSyncMock,
  readdirSync: readdirSyncMock,
  statSync: statSyncMock
}))
vi.mock('node:fs/promises', () => ({ readFile: readFileMock, readdir: readdirMock }))

const {
  createPosixProcessTreeOwnership,
  onProcessTreeReaped,
  proveRecordedPosixLeaderGone,
  terminateOwnedPosixProcessGroupById,
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
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('terminateProcessTree (win32)', () => {
  it('kills the whole tree via taskkill and resolves when taskkill exits cleanly', async () => {
    setPlatform('win32')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.stubEnv('PATH', 'C:\\fixture')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(4321)

    const pending = terminateProcessTree(child as never)

    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true })
    )

    killer.emit('exit', 0, null)
    await expect(pending).resolves.toEqual({ reaped: true })
    // A clean taskkill reaps the tree; no direct fallback kill is needed.
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('resolves taskkill beside ComSpec when the Windows root variables are unavailable', async () => {
    setPlatform('win32')
    vi.stubEnv('SystemRoot', '')
    vi.stubEnv('WINDIR', '')
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe')
    const killer = new EventEmitter()
    spawnMock.mockReturnValueOnce(killer)
    const child = new FakeChild(4321)

    const pending = terminateProcessTree(child as never)

    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/pid', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true })
    )

    killer.emit('exit', 0, null)
    await expect(pending).resolves.toEqual({ reaped: true })
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

  it.each(['win32', 'linux', 'darwin'])(
    'with an undefined pid reports the tree reaped on %s',
    async (platform) => {
      setPlatform(platform)
      const child = new FakeChild(undefined)
      const release = vi.fn()
      onProcessTreeReaped(child as never, release)
      child.emit('close', -2)

      // No pid means nothing spawned/already gone — nothing left to reap.
      await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
      expect(spawnMock).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledOnce()
    }
  )
})

describe('terminateProcessTree (posix)', () => {
  beforeEach(() => {
    // Fake PIDs and process groups are absent unless the test models a live one.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch()
    })
  })

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
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === -1000 && signal === 0) throw esrch()
        if (signal === 0 && !helperAlive) throw esrch()
        if (signal === 'SIGTERM') helperAlive = false
        return true
      })
      try {
        trackOwnedPosixProcessTree(child as never, marker)
        child.exitCode = 0
        releaseFirstSample?.(['2000', '3000'])
        await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
        if (reused) expect(kill).not.toHaveBeenCalledWith(2000, 'SIGTERM')
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
    readFileSyncMock.mockImplementation(() => {
      if (!alive) throw esrch()
      return linuxStat(1000, process.pid, 1000, 1000, 100)
    })
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))

    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
    expect(killSpy).toHaveBeenCalledWith(-1000, 'SIGTERM')
    // The group signal already removed the leader before its individual signal recheck.
    expect(killSpy).not.toHaveBeenCalledWith(1000, 'SIGTERM')
  })

  it('does not claim an unobserved orphan from matching numeric group and session IDs', async () => {
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

    await expect(terminateProcessTree(child as never)).resolves.toMatchObject({ reaped: false })
    expect(killSpy).not.toHaveBeenCalledWith(-1000, 'SIGTERM')
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
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === '/proc/1001/stat' && helperAlive) return linuxStat(1001, 1, 1001, 1001, 101)
      throw esrch()
    })
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))
    child.exitCode = 0

    const pending = terminateProcessTree(child as never)

    await expect(pending).resolves.toEqual({ reaped: true })
    expect(killSpy).not.toHaveBeenCalledWith(1001, 'SIGTERM')
    expect(killSpy).toHaveBeenCalledWith(-1001, 'SIGTERM')
  })

  it('reports tracked teardown incomplete when a proc entry cannot be read with EACCES', async () => {
    setPlatform('linux')
    readdirMock.mockResolvedValueOnce(['1000', '1001']).mockResolvedValueOnce(['2000'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 100))
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      .mockResolvedValueOnce(linuxStat(2000, 1, 2000, 2000, 200))
    const killSpy = vi.mocked(process.kill)
    const child = new FakeChild(1000)
    trackLinux(child, 100)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))
    child.exitCode = 0

    await expect(terminateProcessTree(child as never)).resolves.toMatchObject({
      reaped: false,
      diagnostics: { failureCategory: 'process-table-history-incomplete' }
    })
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

    await expect(terminateProcessTree(child as never)).resolves.toMatchObject({ reaped: false })
    expect(killSpy).not.toHaveBeenCalledWith(1000, 'SIGTERM')
    expect(killSpy).not.toHaveBeenCalledWith(-1000, 'SIGTERM')
  })

  it('never adopts a leader pid that first appears after a complete sample found it missing', async () => {
    setPlatform('linux')
    readdirMock.mockResolvedValueOnce(['1001']).mockResolvedValueOnce(['1000'])
    readFileMock
      .mockResolvedValueOnce(linuxStat(1001, 1, 1001, 1001, 101))
      .mockResolvedValueOnce(linuxStat(1000, 1, 1000, 1000, 200))
    const killSpy = vi.mocked(process.kill)
    const child = new FakeChild(1000)

    readFileSyncMock.mockImplementationOnce(() => {
      throw new Error('leader already exited')
    })
    trackOwnedPosixProcessTree(child as never)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(1))

    const pending = terminateProcessTree(child as never)
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'))
    child.emit('exit', 0, null)

    await expect(pending).resolves.toMatchObject({
      reaped: false,
      diagnostics: { failureCategory: 'leader-identity-unavailable' }
    })
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
      if (pid === -2000 || pid === -1000) throw esrch()
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
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === '/proc/2001/stat' && helperAlive) return linuxStat(2001, 1, 2001, 2001, 201)
      throw esrch()
    })
    releaseFirstSample?.(['1000'])

    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(3))
    secondChild.exitCode = 0
    await expect(terminateProcessTree(secondChild as never)).resolves.toEqual({ reaped: true })
    expect(killSpy).not.toHaveBeenCalledWith(2001, 'SIGTERM')
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
    const killSpy = vi.mocked(process.kill)
    const child = new FakeChild(1000)

    trackLinux(child, 100)
    await vi.waitFor(() => expect(readFileMock).toHaveBeenCalledTimes(2))
    child.exitCode = 0

    await expect(terminateProcessTree(child as never)).resolves.toEqual({ reaped: true })
    expect(killSpy).not.toHaveBeenCalledWith(1001, expect.anything())
  })

  it('fails closed without signaling a group when the Darwin leader identity is unavailable', async () => {
    setPlatform('darwin')
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

    await expect(pending).resolves.toMatchObject({
      reaped: false,
      diagnostics: { failureCategory: 'leader-identity-unavailable' }
    })
    expect(killSpy).not.toHaveBeenCalledWith(-1000, 'SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('retains the cold recovery fence when the recorded leader has exited', async () => {
    setPlatform('linux')
    readFileSyncMock.mockImplementation(() => {
      throw esrch()
    })
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    await expect(
      terminateOwnedPosixProcessGroupById(1000, undefined, undefined, 'linux-proc-starttime:100')
    ).resolves.toEqual({ reaped: false })
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('rechecks the original birth receipt before escalating an owned process group', async () => {
    vi.useFakeTimers()
    setPlatform('linux')
    const original = linuxStat(1000, process.pid, 1000, 1000, 100)
    let current = original
    readFileSyncMock.mockImplementation(() => current)
    readdirMock.mockResolvedValue(['1000'])
    readFileMock.mockImplementation(async () => current)
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    const pending = terminateOwnedPosixProcessGroupById(
      1000,
      undefined,
      undefined,
      'linux-proc-starttime:100'
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(killSpy).toHaveBeenCalledWith(-1000, 'SIGTERM')
    current = linuxStat(1000, process.pid, 1000, 1000, 200)
    await vi.advanceTimersByTimeAsync(3000)

    await expect(pending).resolves.toEqual({ reaped: false })
    expect(killSpy).not.toHaveBeenCalledWith(-1000, 'SIGKILL')
    expect(killSpy).not.toHaveBeenCalledWith(1000, 'SIGKILL')
  })

  it('does not adopt a new birth after the first tracking registration failed', async () => {
    setPlatform('linux')
    readFileSyncMock.mockImplementationOnce(() => {
      throw esrch()
    })
    const child = new FakeChild(1000)
    trackOwnedPosixProcessTree(child as never)
    const replacement = linuxStat(1000, process.pid, 1000, 1000, 200)
    readFileSyncMock.mockReturnValue(replacement)
    readdirMock.mockResolvedValue(['1000'])
    readFileMock.mockResolvedValue(replacement)
    trackOwnedPosixProcessTree(child as never)
    child.exitCode = 0
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)

    await expect(terminateProcessTree(child as never)).resolves.toMatchObject({ reaped: false })
    expect(kill).not.toHaveBeenCalledWith(-1000, 'SIGTERM')
  })

  it.each([undefined, 'linux-proc-starttime:100'])(
    'does not signal a cold group without its matching historical birth: %s',
    async (birthToken) => {
      setPlatform('linux')
      readFileSyncMock.mockReturnValue(linuxStat(1000, 1, 1000, 1000, 200))
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
      await expect(
        terminateOwnedPosixProcessGroupById(1000, undefined, undefined, birthToken)
      ).resolves.toEqual({ reaped: false })
      expect(kill).not.toHaveBeenCalled()
    }
  )

  it('does not substitute legacy proof for a present but invalid birth token', async () => {
    setPlatform('linux')
    readFileSyncMock.mockImplementation((path: string) =>
      path.endsWith('/environ') ? 'OWNER=token\0' : linuxStat(1000, 1, 1000, 1000, 200)
    )
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    await expect(
      terminateOwnedPosixProcessGroupById(1000, undefined, undefined, '', {
        name: 'OWNER',
        value: 'token'
      })
    ).resolves.toEqual({ reaped: false })
    expect(readFileSyncMock).not.toHaveBeenCalledWith('/proc/1000/environ', 'utf8')
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['matching', 'different-value', 'prefix-match', 'unreadable', 'reused-during-proof'])(
    'requires exact historical environment proof before migrating a cold group: %s',
    async (mode) => {
      setPlatform('linux')
      let birth = 100
      let gone = false
      const stat = (): string => linuxStat(1000, 1, 1000, 1000, birth)
      readFileSyncMock.mockImplementation((path: string) => {
        if (path.endsWith('/environ')) {
          if (mode === 'unreadable') throw new Error('EACCES')
          if (mode === 'reused-during-proof') birth = 200
          return mode === 'different-value'
            ? 'OWNER=token-extra\0'
            : mode === 'prefix-match'
              ? 'OTHER_OWNER=token\0'
              : 'OWNER=token\0'
        }
        if (gone) throw esrch()
        return stat()
      })
      readdirMock.mockResolvedValue(['1000'])
      readFileMock.mockImplementation(async () => stat())
      const delivered: Array<[number, string | number | undefined]> = []
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 0) {
          if (gone) throw esrch()
          return true
        }
        delivered.push([pid, signal])
        gone = true
        return true
      })
      await expect(
        terminateOwnedPosixProcessGroupById(1000, undefined, undefined, undefined, {
          name: 'OWNER',
          value: 'token'
        })
      ).resolves.toEqual({ reaped: mode === 'matching' })
      if (mode === 'matching') expect(delivered).toContainEqual([-1000, 'SIGTERM'])
      else expect(delivered).toEqual([])
      kill.mockRestore()
    }
  )

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

describe('process tree reap notification', () => {
  it('retains admission after close and failed teardown, and releases once after confirmed teardown', async () => {
    setPlatform('win32')
    const child = new FakeChild(4321)
    child.exitCode = 0
    const release = vi.fn()
    onProcessTreeReaped(child as never, release)
    child.emit('close', 0)
    expect(release).not.toHaveBeenCalled()
    const failedKiller = new EventEmitter()
    spawnMock.mockReturnValueOnce(failedKiller)
    const failed = terminateProcessTree(child as never)
    failedKiller.emit('exit', 1, null)
    await expect(failed).resolves.toEqual({ reaped: false })
    expect(release).not.toHaveBeenCalled()
    for (let attempt = 0; attempt < 2; attempt++) {
      const killer = new EventEmitter()
      spawnMock.mockReturnValueOnce(killer)
      const pending = terminateProcessTree(child as never)
      killer.emit('exit', 0, null)
      await expect(pending).resolves.toEqual({ reaped: true })
    }
    expect(release).toHaveBeenCalledOnce()
  })
})

describe('Linux cold recovery marker scan', () => {
  const leader = { pid: 1000, birthToken: 'linux-proc-starttime:100' }
  const spawnedAt = 500_000

  const prepare = (
    command: string,
    starttime: number,
    environment: string | Error,
    status?: string
  ): void => {
    setPlatform('linux')
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrch()
    })
    const stat = linuxStat(2000, 1, 2000, 2000, starttime).replace('(test process)', `(${command})`)
    readdirMock.mockResolvedValue(['2000'])
    readFileMock.mockResolvedValue(stat)
    readdirSyncMock.mockReturnValue(['2000'])
    statSyncMock.mockReturnValue({ uid: process.getuid?.() })
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === '/proc/uptime') return '1000 0'
      if (path === '/proc/2000/stat') return stat
      if (path === '/proc/2000/status' && status !== undefined) return status
      if (path === '/proc/2000/environ') {
        if (environment instanceof Error) throw environment
        return environment
      }
      throw new Error(`Unexpected procfs read: ${path}`)
    })
  }

  it.each(['system service', '(sd-pam)', 'worker) name'])(
    'excludes an unreadable pre-existing process whose comm is %s',
    async (command) => {
      prepare(command, 10_000, Object.assign(new Error('denied'), { code: 'EACCES' }))
      await expect(proveRecordedPosixLeaderGone(leader, 'owner', spawnedAt)).resolves.toBe('gone')
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(-1000, 0)
    }
  )

  it.each([
    ['1', 'gone'],
    ['0', 'blocked']
  ])('uses Kthread=%s to classify a newer unreadable task', async (flag, outcome) => {
    prepare(
      'kworker/u16:7',
      60_000,
      Object.assign(new Error('denied'), { code: 'EACCES' }),
      `Name:\tkworker/u16:7\nKthread:\t${flag}\n`
    )
    await expect(proveRecordedPosixLeaderGone(leader, 'owner', spawnedAt)).resolves.toBe(outcome)
  })

  it.each(['EACCES', 'EPERM', 'EIO'])(
    'retains a newer unreadable candidate with parentheses in comm (%s)',
    async (code) => {
      prepare('(sd-pam)', 60_000, Object.assign(new Error(code), { code }))
      await expect(proveRecordedPosixLeaderGone(leader, 'owner', spawnedAt)).resolves.toBe(
        'blocked'
      )
    }
  )

  it.each(['PATH=/bin\0', 'OPEN_SCIENCE_PROCESS_TREE_ID=another-owner\0'])(
    'accepts a complete scan despite a newer unrelated process with %s',
    async (environment) => {
      prepare('observer', 60_000, environment)
      await expect(proveRecordedPosixLeaderGone(leader, 'owner', spawnedAt)).resolves.toBe('gone')
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(-1000, 0)
    }
  )

  it('accepts a complete marker scan without a receipt spawn time', async () => {
    prepare('observer', 60_000, 'PATH=/bin\0')
    await expect(proveRecordedPosixLeaderGone(leader, 'owner')).resolves.toBe('gone')
  })

  it('retains an unreadable candidate when the receipt has no spawn time', async () => {
    prepare('(sd-pam)', 10_000, Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(proveRecordedPosixLeaderGone(leader, 'owner')).resolves.toBe('blocked')
  })

  it('retains a receipt for a marked descendant with parentheses in comm', async () => {
    prepare('(worker)', 60_000, 'OPEN_SCIENCE_PROCESS_TREE_ID=owner\0')
    await expect(proveRecordedPosixLeaderGone(leader, 'owner', spawnedAt)).resolves.toBe('blocked')
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-1000, 0)
  })

  it('retains a receipt when the process table is incomplete', async () => {
    prepare('(sd-pam)', 10_000, 'PATH=/bin\0')
    readFileMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(proveRecordedPosixLeaderGone(leader, 'owner', spawnedAt)).resolves.toBe('blocked')
    expect(process.kill).not.toHaveBeenCalled()
  })
})
