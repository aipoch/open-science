import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { createMacSmokeProcessCleanup } from './mac-smoke-process-cleanup.mjs'
const app = '/isolated/Runtime.app'
const row = (
  pid: number,
  uniqueId: string,
  ppid = 1,
  parentUniqueId = 'launchd'
): Record<string, unknown> => ({ pid, uniqueId, ppid, parentUniqueId })
it('reaps an independently launched runtime and retained reparented descendants, protecting another installation and recycled PIDs', async () => {
  const root = row(10, 'runtime'),
    child = row(11, 'backend', 10, 'runtime'),
    other = row(20, 'other')
  const rows = new Map([
    [10, root],
    [11, child],
    [20, other]
  ])
  const paths = new Map([
    ['runtime', app + '/Contents/MacOS/main'],
    ['backend', '/usr/bin/python3'],
    ['other', '/another/Runtime.app/Contents/MacOS/main'],
    ['recycled', '/usr/bin/sleep']
  ])
  const signals: unknown[] = []
  const native = {
    listDarwinProcesses: () => ({ complete: true, processes: [...rows.values()] }),
    getDarwinProcess: (pid: number) => rows.get(pid),
    getDarwinProcessExecutable: (_pid: number, id: string) => paths.get(id),
    signalDarwinProcess: vi.fn((pid: number, id: string, signal: number, executable: string) => {
      signals.push({ pid, id, signal, executable })
      rows.delete(pid)
      return true
    })
  }
  const cleanup = createMacSmokeProcessCleanup(native, app)
  cleanup.capture()
  rows.set(10, row(10, 'recycled'))
  rows.set(11, row(11, 'backend')) // parent exited/reparented after the birth relationship was captured.
  await cleanup.reap()
  expect(signals).toEqual([{ pid: 11, id: 'backend', signal: 9, executable: '/usr/bin/python3' }])
  expect(rows.get(10)?.uniqueId).toBe('recycled')
  expect(rows.has(20)).toBe(true)
})
it('fails cleanup for an incomplete ownership snapshot instead of claiming a clean teardown', async () => {
  const cleanup = createMacSmokeProcessCleanup(
    { listDarwinProcesses: () => ({ complete: false, processes: [] }) },
    app
  )
  await expect(cleanup.reap()).rejects.toThrow(/incomplete/)
})
it.skipIf(process.platform !== 'darwin' || process.env.MAC_UPDATE_NATIVE_FIXTURES !== '1')(
  'cleans a real detached runtime tree outside a wrapper group without signalling another app',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mac-smoke-owned-runtime-')))
    const bundle = join(root, 'Runtime.app')
    const executable = join(bundle, 'Contents/MacOS/main')
    await mkdir(join(executable, '..'), { recursive: true })
    execFileSync('/usr/bin/xcrun', ['clang', '-x', 'c', '-o', executable, '-'], {
      input:
        '#include <unistd.h>\n#include <sys/wait.h>\nint main(void){pid_t child=fork();if(child==0){execl("/bin/sleep","sleep","30",(char*)0);_exit(2);}waitpid(child,0,0);return 0;}\n'
    })
    const runtime = spawn(executable, [], {
      detached: true,
      stdio: 'ignore'
    })
    const protectedChild = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' })
    const native = createRequire(import.meta.url)('@aipoch/process-tree-native')
    const cleanup = createMacSmokeProcessCleanup(native, bundle)
    try {
      await vi.waitFor(() => expect(cleanup.capture().length).toBeGreaterThanOrEqual(2), {
        timeout: 5000
      })
      await cleanup.reap()
      await vi.waitFor(() => expect(native.getDarwinProcess(runtime.pid)).toBeNull())
      expect(native.getDarwinProcess(protectedChild.pid)).not.toBeNull()
    } finally {
      await cleanup.reap()
      protectedChild.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(['same-birth-exec', 'foreign-child'])(
  'never signals another application or its descendants: %s',
  async (mode) => {
    const rows = new Map([
      [10, row(10, 'runtime')],
      [11, row(11, 'child', 10, 'runtime')],
      [12, row(12, 'grandchild', 11, 'child')]
    ])
    const paths = new Map([
      ['runtime', app + '/Contents/MacOS/main'],
      ['child', '/usr/bin/python3'],
      ['grandchild', '/bin/sh']
    ])
    const signal = vi.fn()
    const native = {
      listDarwinProcesses: () => ({ complete: true, processes: [...rows.values()] }),
      getDarwinProcess: (pid: number) => rows.get(pid),
      getDarwinProcessExecutable: (_pid: number, id: string) => paths.get(id),
      signalDarwinProcess: signal
    }
    const cleanup = createMacSmokeProcessCleanup(native, app)
    cleanup.capture()
    if (mode === 'same-birth-exec') paths.set('runtime', '/Other.app/Contents/MacOS/main')
    else paths.set('child', '/Other.app/Contents/Resources/backend/node')
    // A captured descendant can reparent after crossing the boundary; historical ancestry must
    // not retain permission to terminate it after the parent became a foreign application.
    rows.set(12, row(12, 'grandchild'))
    await expect(cleanup.reap({ timeoutMs: 30 })).rejects.toThrow(/another application boundary/)
    expect(signal).not.toHaveBeenCalled()
    expect(rows.size).toBe(3)
  }
)
it('retains a live generation with an undefined executable and never invokes a speculative signal', async () => {
  let path: string | undefined = app + '/Contents/MacOS/main'
  const process = row(10, 'runtime')
  const signal = vi.fn()
  const native = {
    listDarwinProcesses: () => ({ complete: true, processes: [process] }),
    getDarwinProcess: () => process,
    getDarwinProcessExecutable: () => path,
    signalDarwinProcess: signal
  }
  const cleanup = createMacSmokeProcessCleanup(native, app)
  cleanup.capture()
  path = undefined
  await expect(cleanup.reap({ timeoutMs: 30 })).rejects.toThrow(/survived cleanup/)
  expect(signal).not.toHaveBeenCalled()
})
it('does not call a live same-birth exec race clean before recapturing its current executable', async () => {
  const process = row(10, 'runtime')
  let alive = true
  let reads = 0
  const signals: string[] = []
  const original = app + '/Contents/MacOS/main'
  const next = '/usr/bin/python3'
  const native = {
    listDarwinProcesses: () => ({ complete: true, processes: alive ? [process] : [] }),
    getDarwinProcess: () => (alive ? process : undefined),
    getDarwinProcessExecutable: () => (++reads <= 2 ? original : next),
    signalDarwinProcess: (_pid: number, _id: string, _signal: number, executable: string) => {
      signals.push(executable)
      alive = false
      return true
    }
  }
  const cleanup = createMacSmokeProcessCleanup(native, app)
  cleanup.capture()
  await cleanup.reap()
  expect(signals).toEqual([next])
  expect(alive).toBe(false)
})

it('preserves the root when the final deadline observation crosses into another application', async () => {
  const process = row(10, 'runtime')
  let reads = 0
  const original = app + '/Contents/MacOS/main'
  const signal = vi.fn()
  const native = {
    listDarwinProcesses: () => ({ complete: true, processes: [process] }),
    getDarwinProcess: () => process,
    getDarwinProcessExecutable: () => (++reads < 5 ? original : '/Other.app/Contents/MacOS/main'),
    signalDarwinProcess: signal
  }
  const cleanup = createMacSmokeProcessCleanup(native, app)
  cleanup.capture()
  await expect(cleanup.reap({ timeoutMs: 0 })).rejects.toThrow(/survived cleanup/)
  expect(reads).toBeGreaterThanOrEqual(5)
  expect(signal).toHaveBeenCalledTimes(1)
  expect(signal).toHaveBeenCalledWith(10, 'runtime', 9, original)
})
