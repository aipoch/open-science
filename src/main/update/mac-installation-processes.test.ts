import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DarwinProcessIdentity } from '@aipoch/process-tree-native'
import {
  closeMacInstallationProcesses,
  prepareMacRecoveryProcesses
} from './mac-installation-processes'

const state = vi.hoisted(() => ({
  rows: new Map<number, DarwinProcessIdentity & { path: string }>(),
  list: vi.fn(),
  executable: vi.fn(),
  signal: vi.fn(),
  inspect: vi.fn()
}))
vi.mock('./installation-occupancy', () => ({ inspectInstallationProcessesAsync: state.inspect }))
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path }))
vi.mock('node:module', () => ({
  createRequire: () => () => ({
    listDarwinProcesses: state.list,
    getDarwinProcessExecutable: state.executable,
    signalDarwinProcess: state.signal
  })
}))
const root = '/fixtures/Science.app'
function row(pid: number, path = root + '/Contents/MacOS/Science', parent = 1): void {
  state.rows.set(pid, {
    pid,
    ppid: parent,
    uniqueId: String(pid * 10),
    parentUniqueId: String(parent * 10),
    pgid: pid,
    sid: pid,
    path
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  state.rows.clear()
  state.inspect.mockResolvedValue([])
  state.list.mockImplementation(() => ({ complete: true, processes: [...state.rows.values()] }))
  state.executable.mockImplementation((pid, generation) => {
    const current = state.rows.get(pid)
    return current && current.uniqueId === generation ? current.path : null
  })
  state.signal.mockImplementation((pid, generation, signal) => {
    if (state.rows.get(pid)?.uniqueId !== generation) return false
    if (signal === 9) state.rows.delete(pid)
    return true
  })
})
afterEach(() => vi.useRealTimers())

it('closes same-installation peers and managed external descendants but preserves another installation', async () => {
  row(100)
  row(101, '/usr/bin/python3', 100)
  row(102, '/fixtures/Science-other.app/Contents/MacOS/Science', 100)
  row(103, '/usr/bin/python3', 102)
  row(200)
  row(300, '/fixtures/Science.app-old/Contents/MacOS/Science')
  const pending = closeMacInstallationProcesses(root, {
    excludedProcessIds: [200],
    timeoutMs: 1000
  })
  const checked = expect(pending).resolves.toEqual({ graceful: [], forced: [100, 101] })
  await vi.runAllTimersAsync()
  await checked
  expect([...state.rows.keys()]).toEqual([102, 103, 200, 300])
  expect(state.signal.mock.calls.map(([pid]) => pid)).not.toContain(102)
})

it('gives protocol peers their normal close opportunity before signalling old peers', async () => {
  row(100)
  const pending = closeMacInstallationProcesses(root, { excludedProcessIds: [], timeoutMs: 2000 })
  await vi.advanceTimersByTimeAsync(1400)
  expect(state.signal).not.toHaveBeenCalled()
  state.rows.delete(100)
  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toEqual({ graceful: [100], forced: [] })
})

it('does not deliver a signal to a PID reused after installation ownership was inspected', async () => {
  row(100)
  state.signal.mockImplementation((pid) => {
    row(pid, '/fixtures/Other.app/Contents/MacOS/Science')
    state.rows.get(pid)!.uniqueId = '99999'
    return false // Native birth/pidversion guard rejected the stale generation.
  })
  const pending = closeMacInstallationProcesses(root, { excludedProcessIds: [], timeoutMs: 0 })
  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toEqual({ graceful: [100], forced: [] })
  expect(state.signal).toHaveBeenCalledExactlyOnceWith(
    100,
    '1000',
    9,
    root + '/Contents/MacOS/Science'
  )
  expect(state.rows.get(100)?.uniqueId).toBe('99999')
})

it('revokes retained ownership when exec enters another installation without changing birth identity', async () => {
  row(100)
  const pending = closeMacInstallationProcesses(root, { excludedProcessIds: [], timeoutMs: 1000 })
  state.rows.get(100)!.path = '/fixtures/Other.app/Contents/MacOS/Science'
  row(101, '/usr/bin/python3', 100)
  await vi.advanceTimersByTimeAsync(100)
  await expect(pending).resolves.toEqual({ graceful: [], forced: [] })
  expect(state.signal).not.toHaveBeenCalled()
  expect(state.rows.has(100)).toBe(true)
  expect(state.rows.has(101)).toBe(true)
})

it('retains verified descendants after their parent exits and they are reparented', async () => {
  row(100)
  row(101, '/usr/bin/python3', 100)
  const pending = closeMacInstallationProcesses(root, { excludedProcessIds: [], timeoutMs: 1000 })
  state.rows.delete(100)
  state.rows.get(101)!.ppid = 1
  state.rows.get(101)!.parentUniqueId = '1'
  const checked = expect(pending).resolves.toEqual({ graceful: [100], forced: [101] })
  await vi.runAllTimersAsync()
  await checked
})

it('reports unknown process-table coverage without using it as idle or signal authority', async () => {
  row(100)
  state.list.mockReturnValue({ complete: false, processes: [...state.rows.values()] })
  await expect(
    closeMacInstallationProcesses(root, { excludedProcessIds: [], timeoutMs: 0 })
  ).rejects.toMatchObject({ reason: 'installation-busy', stage: 'process-table-incomplete' })
  expect(state.signal).not.toHaveBeenCalled()
})

it('preserves a real signal permission failure instead of declaring occupancy released', async () => {
  row(100)
  state.signal.mockImplementation(() => {
    throw new Error('signal-delivery;errno=1')
  })
  await expect(
    closeMacInstallationProcesses(root, { excludedProcessIds: [], timeoutMs: 0 })
  ).rejects.toMatchObject({ reason: 'installation-busy', stage: 'verified-close' })
  expect(state.rows.has(100)).toBe(true)
})

it('ends at the original close deadline when an identified process survives force', async () => {
  row(100)
  state.signal.mockReturnValue(true)
  const start = Date.now()
  const pending = closeMacInstallationProcesses(root, {
    excludedProcessIds: [],
    timeoutMs: 1000,
    deadlineAt: start + 700
  })
  const checked = expect(pending).rejects.toMatchObject({ stage: 'close-deadline' })
  await vi.runAllTimersAsync()
  await checked
  expect(Date.now() - start).toBe(700)
  expect(state.rows.has(100)).toBe(true)
})

it('does not start shutdown when already cancelled', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled-before-close'))
  await expect(
    closeMacInstallationProcesses(root, {
      excludedProcessIds: [],
      timeoutMs: 0,
      signal: controller.signal
    })
  ).rejects.toThrow('cancelled-before-close')
  expect(state.list).not.toHaveBeenCalled()
})

it('recovery proves final occupancy and exempts only the initiating desktop objects', async () => {
  state.inspect.mockResolvedValue([process.pid, 99])
  await expect(
    prepareMacRecoveryProcesses(root, {
      excludedProcessIds: [99],
      deadlineAt: Date.now() + 20000
    })
  ).resolves.toEqual({ graceful: [], forced: [] })
  expect(state.inspect).toHaveBeenCalledWith(root, expect.any(AbortSignal))
})

it('recovery preserves the full peer close opportunity and then verifies installation occupancy', async () => {
  row(100)
  const start = Date.now()
  const pending = prepareMacRecoveryProcesses(root, {
    excludedProcessIds: [],
    deadlineAt: start + 20000
  })
  await vi.advanceTimersByTimeAsync(16500)
  expect(state.signal).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(3100)
  await expect(pending).resolves.toEqual({ graceful: [], forced: [100] })
  expect(Date.now() - start).toBeLessThan(20000)
  expect(state.inspect).toHaveBeenCalledOnce()
})

it.each(['occupant', 'unknown'] as const)(
  'recovery does not feed an installation with %s occupancy',
  async (kind) => {
    if (kind === 'occupant') state.inspect.mockResolvedValue([100])
    else state.inspect.mockRejectedValue(new Error('unknown-query'))
    await expect(
      prepareMacRecoveryProcesses(root, {
        excludedProcessIds: [],
        deadlineAt: Date.now() + 20000
      })
    ).rejects.toThrow(kind === 'occupant' ? 'recovery-remaining-occupants' : 'unknown-query')
    expect(state.signal).not.toHaveBeenCalled()
  }
)
