import type { DarwinProcessIdentity, DarwinProcessTable } from '@aipoch/process-tree-native'
import type { ProcessTreeKillResult } from '../process-tree'

export type DarwinRecoveryIdentity = Readonly<{ pid: number; uniqueId: string }>
type Receipt = Readonly<{
  pid: number
  ownerToken: string
  posixBirthToken?: string
  darwinRecoveryProcesses?: readonly DarwinRecoveryIdentity[]
}>
type Dependencies = {
  getDarwinProcess(pid: number): DarwinProcessIdentity | null
  getDarwinEnvironmentValue(pid: number, name: string): string | false | null
  listDarwinProcesses(): DarwinProcessTable | null
  groupAlive(pid: number): boolean
  pidAlive(pid: number): boolean
  signal(pid: number, signal: NodeJS.Signals): void
  wait(ms: number): Promise<void>
}
type Inspection = { state: 'dead' | 'owned' | 'unknown'; members: DarwinProcessIdentity[] }
const tokenName = 'OPEN_SCIENCE_KERNEL_OWNER_TOKEN'
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
const native = (): typeof import('@aipoch/process-tree-native') => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Lazy native loading; other platforms never call this.
  return require('@aipoch/process-tree-native')
}
const sameIdentity = (a: DarwinProcessIdentity, b: DarwinProcessIdentity): boolean =>
  a.pid === b.pid && a.uniqueId === b.uniqueId && a.pgid === b.pgid && a.sid === b.sid

export function createDarwinKernelRecovery(
  deps: Dependencies = {
    getDarwinProcess: (pid) => native().getDarwinProcess(pid),
    getDarwinEnvironmentValue: (pid, name) => native().getDarwinEnvironmentValue(pid, name),
    listDarwinProcesses: () => native().listDarwinProcesses(),
    groupAlive: (pid) => alive(-pid),
    pidAlive: alive,
    signal: (pid, signal) => {
      process.kill(pid, signal)
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
): {
  probe(
    record: Receipt,
    checkpoint?: (identities: DarwinRecoveryIdentity[]) => void
  ): Inspection['state']
  terminate(
    record: Receipt,
    checkpoint: (identities: DarwinRecoveryIdentity[]) => void
  ): Promise<ProcessTreeKillResult>
} {
  const verified = (
    identity: DarwinProcessIdentity,
    token: string
  ): 'owned' | 'gone' | 'unknown' => {
    const before = deps.getDarwinProcess(identity.pid)
    if (!before) return deps.pidAlive(identity.pid) ? 'unknown' : 'gone'
    if (!sameIdentity(before, identity)) return 'unknown'
    const value = deps.getDarwinEnvironmentValue(identity.pid, tokenName)
    const after = deps.getDarwinProcess(identity.pid)
    if (!after) return deps.pidAlive(identity.pid) ? 'unknown' : 'gone'
    return sameIdentity(after, identity) && value === token ? 'owned' : 'unknown'
  }
  const inspect = (
    record: Receipt,
    retained: readonly DarwinRecoveryIdentity[],
    observe: (members: DarwinProcessIdentity[]) => void
  ): Inspection => {
    const unknown: Inspection = { state: 'unknown', members: [] }
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !record.ownerToken) return unknown
    const candidates = new Map<number, DarwinProcessIdentity>()
    let unreadableRetainedProcess = false
    // Retained identities survive app crashes and group/session changes during TERM handling.
    for (const identity of retained) {
      const current = deps.getDarwinProcess(identity.pid)
      if (!current) {
        if (deps.pidAlive(identity.pid)) unreadableRetainedProcess = true
      } else if (current.uniqueId === identity.uniqueId) candidates.set(current.pid, current)
    }
    const table = deps.listDarwinProcesses()
    if (!table) return unknown
    const knownBirths = new Set(retained.map((p) => p.uniqueId))
    const leaderBirth = record.posixBirthToken?.match(/^darwin-proc-uniqueid:([1-9][0-9]*)$/u)?.[1]
    if (leaderBirth) knownBirths.add(leaderBirth)
    for (const member of table.processes) {
      // Discover inherited tokens even when a shutdown handler forks into another session.
      if (
        member.pgid === record.pid ||
        deps.getDarwinEnvironmentValue(member.pid, tokenName) === record.ownerToken
      ) {
        candidates.set(member.pid, member)
        knownBirths.add(member.uniqueId)
      }
    }
    // Native snapshots have no parent-first ordering. Preserve positive ancestry to a fixed point;
    // absence of ancestry (e.g. reparenting + exec) is never proof of non-ownership.
    let added: boolean
    do {
      added = false
      for (const member of table.processes) {
        if (!candidates.has(member.pid) && knownBirths.has(member.parentUniqueId)) {
          candidates.set(member.pid, member)
          knownBirths.add(member.uniqueId)
          added = true
        }
      }
    } while (added)
    // Checkpoint even uncertain associated members BEFORE returning unknown. A later exec may
    // erase their ancestry, but must not erase the debt already observed by this recovery attempt.
    observe([...candidates.values()])
    if (!table.complete || unreadableRetainedProcess) return unknown
    // Only inspectable same-UID processes are listed; group absence needs independent ESRCH.
    if (!table.processes.some((p) => p.pgid === record.pid) && deps.groupAlive(record.pid))
      return unknown
    if (candidates.size === 0) return { state: 'dead', members: [] }
    const members: DarwinProcessIdentity[] = []
    for (const candidate of candidates.values()) {
      const state = verified(candidate, record.ownerToken)
      if (state === 'unknown') return unknown
      if (state === 'owned') members.push(candidate)
    }
    // An empty verified set after snapshot exits still needs another fresh scan for new children.
    return { state: 'owned', members }
  }
  const observer = (
    record: Receipt,
    checkpoint?: (identities: DarwinRecoveryIdentity[]) => void
  ): {
    retained: Map<string, DarwinRecoveryIdentity>
    observe(members: DarwinProcessIdentity[]): void
  } => {
    const retained = new Map(
      (record.darwinRecoveryProcesses ?? []).map((p) => [`${p.pid}:${p.uniqueId}`, p])
    )
    let checkpointedCount = retained.size
    return {
      retained,
      observe(members) {
        for (const p of members)
          retained.set(`${p.pid}:${p.uniqueId}`, { pid: p.pid, uniqueId: p.uniqueId })
        if (retained.size !== checkpointedCount) {
          checkpoint?.([...retained.values()])
          checkpointedCount = retained.size
        }
      }
    }
  }

  return {
    probe(record, checkpoint) {
      try {
        const { retained, observe } = observer(record, checkpoint)
        return inspect(record, [...retained.values()], observe).state
      } catch {
        return 'unknown'
      }
    },
    async terminate(record, checkpoint) {
      const { retained, observe } = observer(record, checkpoint)
      const signalled = new Set<string>()
      try {
        // Bounded retries discover children forked during shutdown. No negative-PGID signals.
        for (let attempt = 0; attempt < 60; attempt++) {
          const observed = inspect(record, [...retained.values()], observe)
          if (observed.state === 'dead') return { reaped: true }
          if (observed.state !== 'owned') return { reaped: false }
          const signal = attempt < 40 ? 'SIGTERM' : 'SIGKILL'
          for (const member of observed.members) {
            const key = `${member.pid}:${member.uniqueId}:${signal}`
            if (signalled.has(key)) continue
            // Probe and snapshot authority is never reused across an await or checkpoint.
            const state = verified(member, record.ownerToken)
            if (state === 'gone') continue
            if (state !== 'owned') return { reaped: false }
            try {
              deps.signal(member.pid, signal)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return { reaped: false }
            }
            signalled.add(key)
          }
          await deps.wait(25)
        }
        return { reaped: inspect(record, [...retained.values()], observe).state === 'dead' }
      } catch {
        return { reaped: false }
      }
    }
  }
}
