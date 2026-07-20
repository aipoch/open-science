import { spawn, type ChildProcess } from 'node:child_process'

import type { RuntimeOperationJournal, RuntimeOperationRecord } from './operation-journal'

// Injected side-effects for reconciling ONE interrupted runtime operation, so the startup-recovery
// orchestration is unit-tested without real processes, filesystem, or provisioner. See
// notebook-runtime-crash-recovery.
export type OperationRecoveryDeps = {
  // Whether the operation's recorded child (micromamba/pip/R) is STILL alive — so recovery never
  // cleans staging or a prefix out from under a survived orphan writer. Best-effort; callers pass a
  // platform check (see defaultIsOperationChildAlive).
  isOperationChildAlive: (record: RuntimeOperationRecord) => Promise<boolean>
  // Kills a surviving orphan child before reconciling. Only called when isOperationChildAlive is true.
  terminateOperationChild: (record: RuntimeOperationRecord) => Promise<void>
  // download: delete the partial ".incoming-*" staging dir (targetPath) so the next fetch starts clean.
  cleanStaging: (record: RuntimeOperationRecord) => Promise<void>
  // materialize/upgrade: verify the env prefix and rebuild it from its immutable lock if incomplete
  // (idempotent convergence). No-op when the prefix is already complete.
  verifyOrRebuildEnv: (record: RuntimeOperationRecord) => Promise<void>
  // external install: mark the runtime repair-required — an interrupted pip into the user's own env
  // may be half-applied; do NOT assume success and do NOT auto-retry (the user decides).
  markRepairRequired: (record: RuntimeOperationRecord) => Promise<void>
  // Observed reconcile outcome per record (telemetry/tests). action is the branch taken.
  onReconciled?: (record: RuntimeOperationRecord, action: RecoveryAction) => void
}

export type RecoveryAction =
  'clean-staging' | 'verify-or-rebuild' | 'repair-required' | 'noop' | 'skipped-child-alive'

// Reconciles every interrupted operation the journal recorded, run ONCE at startup. For each record:
// if a child from the dead parent survived, kill it first (never reconcile under a live writer), then
// run the kind-appropriate reconcile, then CLEAR the journal entry so it is never reprocessed. A
// failure on one operation is logged and its entry left for a later attempt, so one bad op cannot
// block the rest. Returns the records that were reconciled + cleared.
export const reconcileInterruptedOperations = async (
  journal: RuntimeOperationJournal,
  deps: OperationRecoveryDeps
): Promise<RuntimeOperationRecord[]> => {
  const pending = await journal.pending()
  const reconciled: RuntimeOperationRecord[] = []

  for (const record of pending) {
    try {
      if (record.childPid !== undefined && (await deps.isOperationChildAlive(record))) {
        // A live orphan from the previous process is still writing — kill it, THEN reconcile so we
        // never clean staging / verify a prefix while it is mid-write.
        await deps.terminateOperationChild(record)
      }
      await runReconcileAction(record, deps)
      await journal.complete(record.operationId)
      reconciled.push(record)
    } catch (error) {
      console.error(
        `[notebook] operation recovery failed for ${record.operationId}; leaving journal entry`,
        error
      )
    }
  }

  return reconciled
}

const runReconcileAction = async (
  record: RuntimeOperationRecord,
  deps: OperationRecoveryDeps
): Promise<void> => {
  switch (record.kind) {
    case 'download':
      await deps.cleanStaging(record)
      deps.onReconciled?.(record, 'clean-staging')
      return
    case 'materialize':
    case 'upgrade':
      await deps.verifyOrRebuildEnv(record)
      deps.onReconciled?.(record, 'verify-or-rebuild')
      return
    case 'install':
      await deps.markRepairRequired(record)
      deps.onReconciled?.(record, 'repair-required')
      return
    case 'disable':
      // A disable revoke is idempotent + persisted (the binding is already unavailable); nothing to
      // undo — just clear the journal entry.
      deps.onReconciled?.(record, 'noop')
      return
  }
}

// Reads a POSIX process's elapsed run time (`ps -o etime=`) and converts it to an approximate start
// time in epoch ms. Returns undefined if ps is unavailable/unparsable or the pid is gone. Format is
// `[[dd-]hh:]mm:ss`. Used only to reject a REUSED pid (a different process now holding the recorded
// pid), so approximate is fine.
const posixProcessStartMs = (pid: number): Promise<number | undefined> =>
  new Promise((resolve) => {
    let ps: ChildProcess
    try {
      ps = spawn('ps', ['-o', 'etime=', '-p', String(pid)], { windowsHide: true })
    } catch {
      resolve(undefined)
      return
    }
    let out = ''
    ps.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    ps.on('error', () => resolve(undefined))
    ps.on('close', () => {
      const m = out.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/)
      if (!m) {
        resolve(undefined)
        return
      }
      const [, dd, hh, mm, ss] = m
      const seconds =
        Number(dd ?? 0) * 86400 + Number(hh ?? 0) * 3600 + Number(mm) * 60 + Number(ss)
      resolve(Date.now() - seconds * 1000)
    })
  })

// A live pid that started more than this far from the recorded childStartedAt is treated as a DIFFERENT
// process (pid reuse), not our orphan — so recovery never SIGKILLs an unrelated process.
const PID_REUSE_TOLERANCE_MS = 60_000

// Liveness check with a fail-CLOSED pid-reuse guard. Recovery uses a `true` result to SIGKILL the pid,
// so we only return true when we can POSITIVELY confirm the live pid is the SAME process we spawned:
//   - No pid, or the pid is gone / not ours to signal (ESRCH/EPERM) → false.
//   - childStartedAt recorded (the normal case): confirm via `ps` that the pid's start time matches.
//     If we can't verify — no `ps` (Windows), ps failed, or unparsable output — return FALSE rather
//     than risk SIGKILLing an unrelated process that happens to now hold that pid.
//   - childStartedAt absent (legacy record with no start-time): existence alone (best we can do).
export const defaultIsOperationChildAlive = async (
  record: RuntimeOperationRecord
): Promise<boolean> => {
  if (record.childPid === undefined) return false
  try {
    process.kill(record.childPid, 0)
  } catch {
    // ESRCH = gone; EPERM = owned by another user, so not our child. Either way, do not kill it.
    return false
  }
  // No recorded start time (legacy): can't guard against reuse, fall back to existence.
  if (record.childStartedAt === undefined) return true
  // Recorded start time but no way to verify it (Windows has no ps here) — fail closed.
  if (process.platform === 'win32') return false
  const startedMs = await posixProcessStartMs(record.childPid)
  if (startedMs === undefined) return false // couldn't read/parse the start time — fail closed
  return Math.abs(startedMs - record.childStartedAt) <= PID_REUSE_TOLERANCE_MS
}
