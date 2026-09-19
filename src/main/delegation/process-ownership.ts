import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { AgentProcessSpawner } from '../agent-framework/types'
import {
  capturePosixProcessTreeIdentity,
  createPosixProcessTreeOwnership,
  proveRecordedPosixLeaderGone,
  registerProcessTreeOwnership,
  terminateProcessTree,
  trackOwnedPosixProcessTree
} from '../process-tree'
import { reapWindowsOwnedJob, spawnWindowsOwnedProcess } from '../process-tree-windows'
import {
  DelegateExecutionCleanupError,
  type DelegateExecution,
  type DelegateCapacityReservation
} from './execution-port'
import type { SessionKey } from './session-records'

type ProcessScope = SessionKey & { frameId: string; attemptId: string; frameworkId: string }
type Selection = { projectId?: string; sessionId?: string; frameId?: string; attemptId?: string }
type Receipt = ProcessScope & {
  version: 1
  receiptId: string
  phase: 'starting' | 'owned' | 'cleanup-pending'
  createdAt: number
  ownership?: {
    platform: 'linux' | 'darwin' | 'win32'
    token: string
    bootId?: string
    leader?: { pid: number; birthToken?: string }
  }
}
// UUID shapes: Linux boot_id is always lowercase (kernel output); macOS kern.bootsessionuuid is
// always uppercase (uuid_unparse_upper in IOPMrootDomain). Keep separate patterns so validation
// is exact for each platform — a case-only difference would be corruption, not a real UUID change.
const uuidLower = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const uuidUpper = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/u
const segment = (value: string): string => {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    /[<>:"|?*/\\]|[ .]$/u.test(value) ||
    /\p{Cc}/u.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) {
    throw new DelegateExecutionCleanupError('Invalid delegated process ownership scope.')
  }
  return value
}
const matches = (receipt: Receipt, scope: Selection): boolean =>
  Object.entries(scope).every(
    ([key, value]) => value === undefined || receipt[key as keyof Receipt] === value
  )
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
// OS-level sidecar files that Finder/Explorer create in any directory they browse. Harmless but
// must be skipped rather than rejected, matching the repo-wide convention in data-root-selection.
const osArtifact = (name: string): boolean => name === '.DS_Store' || name === 'desktop.ini'
// Per-boot random UUID: Linux /proc/sys/kernel/random/boot_id (lowercase), macOS kern.bootsessionuuid
// (uppercase, generated via uuid_generate on every boot by IOPMrootDomain). Intentionally cased:
// we compare the stored value against a fresh read as raw strings; normalising case would mask
// same-boot-different-case corruption as a spurious reboot.
const bootSessionId = (): string | undefined => {
  try {
    if (process.platform === 'linux') {
      const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return uuidLower.test(value) ? value : undefined
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        timeout: 2000
      })
      if (result.status !== 0 || !result.stdout) return undefined
      const value = result.stdout.trim()
      // macOS emits uppercase; store as-is and compare case-sensitively.
      return uuidUpper.test(value) ? value : undefined
    }
  } catch {
    // Unreadable boot identity is treated as absent, not as proof of a reboot.
  }
  return undefined
}
// Whether `current` proves the machine rebooted since `recorded`. Both values must be present and
// match the expected shape for their platform; missing or malformed either side → false (fail closed).
const bootSessionProvesDifferentBoot = (
  platform: 'linux' | 'darwin' | 'win32' | undefined,
  recorded: string | undefined,
  current: string | undefined
): boolean => {
  if (!recorded || !current || platform === 'win32') return false
  const validShape = platform === 'linux' ? uuidLower : uuidUpper
  return validShape.test(recorded) && validShape.test(current) && recorded !== current
}
const parse = (value: unknown): Receipt => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid receipt')
  const receipt = value as Receipt
  const fields = new Set([
    'version',
    'receiptId',
    'phase',
    'createdAt',
    'projectId',
    'sessionId',
    'frameId',
    'attemptId',
    'frameworkId',
    'ownership'
  ])
  if (
    Object.keys(receipt).some((key) => !fields.has(key)) ||
    receipt.version !== 1 ||
    !uuidLower.test(receipt.receiptId) ||
    !['starting', 'owned', 'cleanup-pending'].includes(receipt.phase) ||
    !Number.isFinite(receipt.createdAt)
  )
    throw new Error('Invalid receipt')
  for (const key of ['projectId', 'sessionId', 'frameId', 'attemptId', 'frameworkId'] as const) {
    if (typeof receipt[key] !== 'string') throw new Error('Invalid receipt scope')
    segment(receipt[key])
  }
  const ownership = receipt.ownership
  if (ownership !== undefined) {
    if (
      !ownership ||
      typeof ownership !== 'object' ||
      Array.isArray(ownership) ||
      Object.keys(ownership).some(
        (key) => !['platform', 'token', 'bootId', 'leader'].includes(key)
      ) ||
      !['linux', 'darwin', 'win32'].includes(ownership.platform) ||
      !uuidLower.test(ownership.token) ||
      (ownership.bootId !== undefined &&
        // linux emits lowercase; darwin emits uppercase; both are valid per-boot UUIDs.
        !(ownership.platform === 'linux'
          ? uuidLower.test(ownership.bootId)
          : uuidUpper.test(ownership.bootId)))
    )
      throw new Error('Invalid process identity')
    if (ownership.leader !== undefined) {
      const leader = ownership.leader
      if (
        !leader ||
        typeof leader !== 'object' ||
        Array.isArray(leader) ||
        Object.keys(leader).some((key) => !['pid', 'birthToken'].includes(key)) ||
        !Number.isSafeInteger(leader.pid) ||
        leader.pid <= 0 ||
        (leader.birthToken !== undefined && typeof leader.birthToken !== 'string')
      )
        throw new Error('Invalid process leader')
    }
  }
  return receipt
}

// This owner is composed once by production delegation and shared by launch, workspace and exit.
// Receipts are outside the deletable workspace. Task history is never used as process-exit proof.
export class DelegatedProcessOwnership {
  private readonly root: string
  private readonly live = new Map<string, ChildProcessWithoutNullStreams>()
  private readonly reconciling = new Map<string, Promise<void>>()
  private readonly gates = new Set<{ scope: Selection; done: Promise<void> }>()

  constructor(dataRoot: string) {
    let base = resolve(dataRoot)
    try {
      base = realpathSync(base)
    } catch (error) {
      if (!missing(error)) throw error
    }
    this.root = join(base, 'delegation-process-ownership')
  }

  private directory(path: string, create = false): boolean {
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Ownership path is not a directory')
      return true
    } catch (error) {
      if (!missing(error)) throw error
      if (!create) return false
      mkdirSync(path, { mode: 0o700 })
      this.flushDirectory(dirname(path))
      return true
    }
  }

  private sessionDirectory(scope: SessionKey, create = false): string | undefined {
    const project = join(this.root, segment(scope.projectId))
    const session = join(project, segment(scope.sessionId))
    if (
      !this.directory(this.root, create) ||
      !this.directory(project, create) ||
      !this.directory(session, create)
    )
      return undefined
    return session
  }

  private flushDirectory(path: string): void {
    // Windows does not expose directory fsync through Node; files themselves are flushed before
    // publication. POSIX also flushes directory entries so a crash cannot lose a published intent.
    if (process.platform === 'win32') return
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  private write(receipt: Receipt, initial = false): void {
    const directory = this.sessionDirectory(receipt, true)!
    const path = join(directory, `${receipt.receiptId}.json`)
    const target = initial ? path : `${path}.pending`
    const fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_SYNC,
      0o600
    )
    try {
      writeFileSync(fd, `${JSON.stringify(receipt)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (!initial) renameSync(target, path)
    this.flushDirectory(directory)
  }

  private remove(receipt: Receipt): void {
    const directory = this.sessionDirectory(receipt)
    if (directory) {
      for (const suffix of ['.json', '.json.pending']) {
        const path = join(directory, `${receipt.receiptId}${suffix}`)
        try {
          if (lstatSync(path).isSymbolicLink()) throw new Error('Process receipt is a symlink')
          unlinkSync(path)
        } catch (error) {
          if (!missing(error)) throw error
        }
      }
      this.flushDirectory(directory)
    }
    this.live.delete(receipt.receiptId)
  }

  async withWorkspace<Value>(scope: Selection, action: () => Promise<Value>): Promise<Value> {
    const overlap = (other: Selection): boolean =>
      ['projectId', 'sessionId', 'frameId'].every((key) => {
        const name = key as keyof Selection
        return scope[name] === undefined || other[name] === undefined || scope[name] === other[name]
      })
    const predecessors = [...this.gates]
      .filter((gate) => overlap(gate.scope))
      .map((gate) => gate.done)
    let release!: () => void
    const gate = {
      scope,
      done: new Promise<void>((resolve) => {
        release = resolve
      })
    }
    this.gates.add(gate)
    try {
      await Promise.all(predecessors)
      return await action()
    } finally {
      this.gates.delete(gate)
      release()
    }
  }

  receipts(scope: Selection = {}): Receipt[] {
    try {
      for (const value of Object.values(scope)) if (value !== undefined) segment(value)
      if (!this.directory(this.root)) return []
      const receipts: Receipt[] = []
      for (const projectId of scope.projectId ? [scope.projectId] : readdirSync(this.root)) {
        if (osArtifact(projectId)) continue
        const project = join(this.root, segment(projectId))
        if (!this.directory(project)) continue
        for (const sessionId of scope.sessionId ? [scope.sessionId] : readdirSync(project)) {
          if (osArtifact(sessionId)) continue
          const directory = this.sessionDirectory({ projectId, sessionId })
          if (!directory) continue
          for (const file of readdirSync(directory)) {
            if (osArtifact(file)) continue
            // A .pending file is a torn write left by a crash between write and rename; skip it
            // rather than throwing so one interrupted write does not block the whole scope.
            if (file.endsWith('.json.pending')) continue
            if (!file.endsWith('.json') || !uuidLower.test(file.slice(0, -5)))
              throw new Error('Incomplete process receipt')
            const path = join(directory, file)
            const stat = lstatSync(path)
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384)
              throw new Error('Invalid process receipt file')
            const receipt = parse(JSON.parse(readFileSync(path, 'utf8')))
            if (
              receipt.projectId !== projectId ||
              receipt.sessionId !== sessionId ||
              `${receipt.receiptId}.json` !== file
            )
              throw new Error('Process receipt scope mismatch')
            if (matches(receipt, scope)) receipts.push(receipt)
          }
        }
      }
      return receipts
    } catch (cause) {
      throw new DelegateExecutionCleanupError(
        'Delegated process ownership could not be read; workspace cleanup remains blocked.',
        { cause }
      )
    }
  }

  spawn(
    scope: ProcessScope,
    command: string,
    args: readonly string[],
    options: Parameters<AgentProcessSpawner>[2]
  ): ChildProcessWithoutNullStreams {
    if ([...this.gates].some((gate) => matches({ ...scope } as Receipt, gate.scope))) {
      throw new DelegateExecutionCleanupError(
        'Delegated workspace lifecycle operation is in progress.'
      )
    }
    this.assertClear({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      frameId: scope.frameId,
      attemptId: scope.attemptId
    })
    const receipt: Receipt = {
      ...scope,
      version: 1,
      receiptId: randomUUID(),
      phase: 'starting',
      createdAt: Date.now()
    }
    if (
      process.platform !== 'win32' &&
      process.platform !== 'linux' &&
      process.platform !== 'darwin'
    )
      throw new Error('Unsupported delegated process ownership platform')
    const ownership = createPosixProcessTreeOwnership(options.env)
    const currentBootSession = bootSessionId()
    receipt.ownership = {
      platform: process.platform,
      token: ownership.token ?? randomUUID(),
      ...(currentBootSession ? { bootId: currentBootSession } : {})
    }
    this.write(receipt, true)
    // Retain intent on native launch errors: creation may have reached the kernel before failing.
    const child =
      process.platform === 'win32'
        ? spawnWindowsOwnedProcess(
            `Local\\OpenScience.Delegation.${receipt.ownership.token}`,
            command,
            args,
            options
          )
        : spawn(command, args, { ...options, env: ownership.env, detached: true })
    this.live.set(receipt.receiptId, child)
    registerProcessTreeOwnership(child, {
      ...(process.platform === 'win32'
        ? {
            terminate: async () => ({
              reaped: await reapWindowsOwnedJob(
                `Local\\OpenScience.Delegation.${receipt.ownership!.token}`
              )
            })
          }
        : {}),
      settled: ({ reaped }) => {
        if (reaped) this.remove(receipt)
        else {
          receipt.phase = 'cleanup-pending'
          this.write(receipt)
        }
      }
    })
    try {
      if (process.platform !== 'win32') {
        trackOwnedPosixProcessTree(child, ownership.token)
        const identity = capturePosixProcessTreeIdentity(child)
        if (identity)
          receipt.ownership.leader = { pid: identity.pid, birthToken: identity.birthToken }
      }
      receipt.phase = 'owned'
      this.write(receipt)
    } catch (error) {
      void terminateProcessTree(child)
      throw error
    }
    return child
  }

  recordFailure(scope: ProcessScope): void {
    const existing = this.receipts(scope)
    if (existing.length > 0) {
      for (const receipt of existing) {
        receipt.phase = 'cleanup-pending'
        this.write(receipt)
      }
      return
    }
    // An execution adapter may fail before returning a physical handle. Preserve that explicit
    // cleanup failure without manufacturing a PID or backfilling historical terminal Attempts.
    // Record the boot session so a proven reboot can clear this receipt automatically.
    const currentBootSession = bootSessionId()
    this.write(
      {
        ...scope,
        version: 1,
        receiptId: randomUUID(),
        phase: 'cleanup-pending',
        createdAt: Date.now(),
        ownership: {
          platform: process.platform as 'linux' | 'darwin' | 'win32',
          token: randomUUID(),
          ...(currentBootSession ? { bootId: currentBootSession } : {})
        }
      },
      true
    )
  }

  async recover(scope: Selection = {}, stopLive = false): Promise<void> {
    const failures: unknown[] = []
    const currentBootSession = bootSessionId()
    await Promise.all(
      this.receipts(scope).map(async (receipt) => {
        const child = this.live.get(receipt.receiptId)
        if (child && receipt.phase === 'owned' && !stopLive) return
        let pending = this.reconciling.get(receipt.receiptId)
        if (!pending) {
          pending = (async () => {
            if (child) {
              if ((await terminateProcessTree(child)).reaped) return
            } else if (receipt.ownership?.platform === process.platform) {
              const ownership = receipt.ownership
              // Proven reboot: no process from the recorded boot can still be alive.
              // Linux: boot_id changes; macOS: kern.bootsessionuuid changes.
              if (
                bootSessionProvesDifferentBoot(
                  ownership.platform,
                  ownership.bootId,
                  currentBootSession
                )
              ) {
                this.remove(receipt)
                return
              }
              // Windows: the named Job is the authoritative lifecycle owner.
              if (
                ownership.platform === 'win32' &&
                (await reapWindowsOwnedJob(`Local\\OpenScience.Delegation.${ownership.token}`))
              ) {
                this.remove(receipt)
                return
              }
              // POSIX: if we recorded a leader identity, try to prove the recorded tree gone
              // by checking whether the pid still exists with the same birth token.
              if (ownership.platform !== 'win32' && ownership.leader?.birthToken !== undefined) {
                const outcome = await proveRecordedPosixLeaderGone(ownership.leader)
                if (outcome === 'gone') {
                  this.remove(receipt)
                  return
                }
              }
            }
            // POSIX observation was interrupted at application exit. A missing/reused leader or no
            // visible marker cannot prove every detached descendant gone; retain ambiguous resources.
            throw new DelegateExecutionCleanupError(
              'Delegated process cleanup is unconfirmed; its workspace remains protected.'
            )
          })()
          this.reconciling.set(receipt.receiptId, pending)
        }
        try {
          await pending
        } catch (error) {
          failures.push(error)
        } finally {
          if (this.reconciling.get(receipt.receiptId) === pending)
            this.reconciling.delete(receipt.receiptId)
        }
      })
    )
    if (failures.length > 0)
      throw new AggregateError(failures, 'Delegated process recovery is incomplete.')
  }

  protectExecution(
    execution: DelegateExecution,
    session: SessionKey,
    frameworkId: string
  ): DelegateExecution {
    let restoredAttempts: Set<string> | undefined
    let retained: Promise<DelegateCapacityReservation> | undefined
    const slots = new Map<string, string>()
    const restoreCapacity = async (): Promise<void> => {
      const receipts = this.receipts(session)
      const pending = new Set(receipts.map(({ attemptId }) => attemptId))
      restoredAttempts ??= new Set(
        receipts
          .filter((receipt) => !this.live.has(receipt.receiptId))
          .map(({ attemptId }) => attemptId)
      )
      if (!retained) {
        const attempts = [...restoredAttempts].filter((id) => pending.has(id))
        if (attempts.length === 0) return
        retained = execution.reserve(attempts.length)
        try {
          const reservation = await retained
          attempts.forEach((id, index) => slots.set(id, reservation.slotIds[index]))
        } catch (error) {
          retained = undefined
          throw error
        }
      }
      const reservation = await retained
      for (const [attemptId, slotId] of slots) {
        if (!pending.has(attemptId)) {
          await reservation.release(slotId)
          slots.delete(attemptId)
        }
      }
    }
    return {
      reserve: async (count) => {
        await restoreCapacity()
        return execution.reserve(count)
      },
      run: (input, slotId) => {
        const running = execution.run(input, slotId)
        const completion = running.completion.catch((error: unknown) => {
          if (error instanceof DelegateExecutionCleanupError) {
            try {
              this.recordFailure({
                ...input.session,
                frameId: input.frameId,
                attemptId: input.attemptId,
                frameworkId
              })
            } catch (cause) {
              throw new DelegateExecutionCleanupError(
                'Delegated process cleanup and ownership persistence failed.',
                { cause }
              )
            }
          }
          throw error
        })
        void completion.catch(() => undefined)
        const accepted = running.accepted.catch(async (error: unknown) => {
          try {
            await completion
          } catch (terminalError) {
            if (terminalError instanceof DelegateExecutionCleanupError) throw terminalError
          }
          throw error
        })
        void accepted.catch(() => undefined)
        return { ...running, accepted, completion }
      },
      recoverCleanup: async () => {
        await this.recover(session)
        // Active, healthy sibling Attempts retain their receipts and continue to own their slots.
        if (
          this.receipts(session).some(
            (receipt) => receipt.phase !== 'owned' || !this.live.has(receipt.receiptId)
          )
        ) {
          throw new DelegateExecutionCleanupError('Delegated process cleanup remains unconfirmed.')
        }
        await execution.recoverCleanup?.()
        await restoreCapacity()
      }
    }
  }

  assertClear(scope: Selection = {}): void {
    if (this.receipts(scope).length > 0)
      throw new DelegateExecutionCleanupError(
        'Delegated process cleanup is unconfirmed; its workspace remains protected.'
      )
  }
}
