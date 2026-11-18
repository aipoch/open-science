import { describe, expect, it, vi } from 'vitest'
import type { DarwinProcessIdentity } from '@aipoch/process-tree-native'
import { createDarwinKernelRecovery } from './kernel-process-recovery.darwin'

const member = (pid = 101): DarwinProcessIdentity => ({
  pid,
  ppid: 1,
  pgid: 100,
  sid: 100,
  uniqueId: String(pid + 1000),
  parentUniqueId: '1'
})
const receipt = { pid: 100, ownerToken: 'receipt-token' }
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve Vitest mock inference in the fixture.
function fixture() {
  const processes = new Map<number, DarwinProcessIdentity>([[101, member()]])
  const env = vi.fn((): string | false | null => receipt.ownerToken)
  const get = vi.fn((pid: number) => processes.get(pid) ?? null)
  const table = vi.fn(() => ({ complete: true, processes: [...processes.values()] }))
  const groupAlive = vi.fn(() => [...processes.values()].some((p) => p.pgid === 100))
  const signal = vi.fn((pid: number, _signal: NodeJS.Signals) => {
    void _signal
    processes.delete(pid)
  })
  const save = vi.fn()
  const recovery = createDarwinKernelRecovery({
    getDarwinProcess: get,
    getDarwinEnvironmentValue: env,
    listDarwinProcesses: table,
    groupAlive,
    pidAlive: (pid) => processes.has(pid),
    signal,
    wait: async () => {}
  })
  return { processes, env, get, table, groupAlive, signal, save, recovery }
}

describe('Darwin kernel recovery', () => {
  it('checkpoints native identities and signals only positively owned individual PIDs', async () => {
    const f = fixture()
    expect(f.recovery.probe(receipt)).toBe('owned')
    expect(await f.recovery.terminate(receipt, f.save)).toEqual({ reaped: true })
    expect(f.save).toHaveBeenCalledWith([{ pid: 101, uniqueId: '1101' }])
    expect(f.signal).toHaveBeenCalledWith(101, 'SIGTERM')
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.signal.mock.invocationCallOrder[0])
  })
  it.each([false, null, 'foreign', 'receipt-token-suffix'] as const)(
    'fences nonmatching environment evidence %s',
    async (token) => {
      const f = fixture()
      f.env.mockReturnValue(token)
      expect(f.recovery.probe(receipt)).toBe('unknown')
      expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(false)
      expect(f.signal).not.toHaveBeenCalled()
    }
  )
  it('fences an incomplete snapshot', async () => {
    const f = fixture()
    f.table.mockReturnValue({ complete: false, processes: [member()] })
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(false)
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('does not infer a dead group from an empty same-UID table', async () => {
    const f = fixture()
    f.processes.clear()
    f.groupAlive.mockReturnValue(true)
    expect(f.recovery.probe(receipt)).toBe('unknown')
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(false)
  })
  it('rechecks birth identity immediately before a signal', async () => {
    const f = fixture()
    f.save.mockImplementation(() => f.processes.set(101, { ...member(), uniqueId: 'reused' }))
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(false)
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('revalidates ownership when the leader exits after probe', async () => {
    const f = fixture()
    f.processes.set(100, member(100))
    expect(f.recovery.probe(receipt)).toBe('owned')
    f.processes.delete(100)
    f.env.mockReturnValue('foreign')
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(false)
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('tracks a member leaving the original group after TERM through KILL', async () => {
    const f = fixture()
    f.signal.mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM') f.processes.set(pid, { ...member(pid), pgid: pid, sid: pid })
      else f.processes.delete(pid)
    })
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(true)
    expect(f.signal).toHaveBeenCalledWith(101, 'SIGKILL')
  })
  it('retains a fence across retries for an escaped member with unreadable ownership', async () => {
    const f = fixture()
    f.signal.mockImplementation((pid) => {
      f.processes.set(pid, { ...member(pid), pgid: pid, sid: pid })
      f.env.mockReturnValue(null)
    })
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(false)
    expect(
      f.recovery.probe({ ...receipt, darwinRecoveryProcesses: f.save.mock.calls.at(-1)![0] })
    ).toBe('unknown')
  })
  it('discovers and checkpoints children appearing during termination', async () => {
    const f = fixture()
    f.signal.mockImplementation((pid) => {
      f.processes.delete(pid)
      if (pid === 101) f.processes.set(102, member(102))
    })
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(true)
    expect(f.signal).toHaveBeenCalledWith(102, 'SIGTERM')
    expect(f.save.mock.calls.at(-1)![0]).toContainEqual({ pid: 102, uniqueId: '1102' })
  })
  it('retains a detached child of the recorded leader on the first recovery scan', () => {
    const f = fixture()
    f.processes.clear()
    f.processes.set(102, { ...member(102), pgid: 102, sid: 102, parentUniqueId: '1100' })
    f.env.mockReturnValue(false)
    const prior = { ...receipt, posixBirthToken: 'darwin-proc-uniqueid:1100' }
    expect(f.recovery.probe(prior, f.save)).toBe('unknown')
    expect(f.save).toHaveBeenCalledWith([{ pid: 102, uniqueId: '1102' }])
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('checkpoints new descendants while a previously retained process is unreadable', () => {
    const f = fixture()
    const prior = { ...receipt, darwinRecoveryProcesses: [{ pid: 101, uniqueId: '1101' }] }
    f.get.mockImplementation(() => null)
    f.processes.set(102, { ...member(102), pgid: 102, sid: 102, parentUniqueId: '1101' })
    f.env.mockReturnValue(null)
    expect(f.recovery.probe(prior, f.save)).toBe('unknown')
    expect(f.save).toHaveBeenCalledWith([
      { pid: 101, uniqueId: '1101' },
      { pid: 102, uniqueId: '1102' }
    ])
  })
  it('never signals if the durable checkpoint fails', async () => {
    const f = fixture()
    f.save.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(false)
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('allows a parent to reap a child before the next individual signal', async () => {
    const f = fixture()
    f.processes.set(102, member(102))
    f.signal.mockImplementation(() => f.processes.clear())
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(true)
    expect(f.signal).toHaveBeenCalledTimes(1)
  })
  it('rescans when a snapshot member exits during ownership verification', async () => {
    const f = fixture()
    f.env.mockImplementation(() => {
      f.processes.delete(101)
      return false
    })
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(true)
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('discovers children born in a new session while TERM removes the original group', async () => {
    const f = fixture()
    f.signal.mockImplementation((pid) => {
      f.processes.delete(pid)
      if (pid === 101) f.processes.set(102, { ...member(102), pgid: 102, sid: 102 })
    })
    expect((await f.recovery.terminate(receipt, f.save)).reaped).toBe(true)
    expect(f.processes.size).toBe(0)
    expect(f.signal).toHaveBeenCalledWith(102, 'SIGTERM')
  })
  it.each(['probe', 'terminate'] as const)(
    'persists uncertain descendants during %s before ancestry can disappear',
    async (operation) => {
      const f = fixture()
      f.processes.clear()
      f.processes.set(103, { ...member(103), pgid: 103, sid: 103, parentUniqueId: '1102' })
      f.processes.set(102, { ...member(102), pgid: 102, sid: 102, parentUniqueId: '1101' })
      f.env.mockReturnValue(null)
      const prior = { ...receipt, darwinRecoveryProcesses: [{ pid: 101, uniqueId: '1101' }] }
      if (operation === 'probe') expect(f.recovery.probe(prior, f.save)).toBe('unknown')
      else expect((await f.recovery.terminate(prior, f.save)).reaped).toBe(false)
      const retained = f.save.mock.calls.at(-1)![0]
      expect(retained).toContainEqual({ pid: 103, uniqueId: '1103' })
      for (const [pid, value] of f.processes)
        f.processes.set(pid, { ...value, parentUniqueId: '1' })
      expect(f.recovery.probe({ ...receipt, darwinRecoveryProcesses: retained })).toBe('unknown')
      expect(f.signal).not.toHaveBeenCalled()
    }
  )
})
