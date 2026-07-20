import { spawn, type ChildProcess } from 'node:child_process'

import type { RuntimeOperationJournal, RuntimeOperationRecord } from './operation-journal'

// Injected side-effects for reconciling ONE interrupted runtime operation, so the startup-recovery
// orchestration is unit-tested without real processes, filesystem, or provisioner. See
// notebook-runtime-crash-recovery.
// Tri-state liveness of an operation's recorded child (micromamba/pip/R):
//   - 'alive'   : positively confirmed the recorded pid is STILL our original child → kill it, then reconcile.
//   - 'dead'    : positively confirmed gone / not ours (ESRCH/EPERM, or a reused pid) → safe to reconcile.
//   - 'unknown' : could NOT determine (no `ps`, Windows, unparsable output) → a survivor MIGHT still be
//                 writing, so we must NOT clean staging / a prefix; skip and leave the journal entry for a
//                 later startup instead of destroying data under a possibly-live writer.
// Collapsing 'unknown' into 'dead' (the old boolean) is exactly the bug: it cleaned live processes' dirs.
export type OperationChildLiveness = 'alive' | 'dead' | 'unknown'

export type OperationRecoveryDeps = {
  // Best-effort liveness of the operation's recorded child, as the tri-state above. Callers pass a
  // platform check (see defaultOperationChildLiveness).
  operationChildLiveness: (record: RuntimeOperationRecord) => Promise<OperationChildLiveness>
  // Kills a surviving orphan child before reconciling. Only called when liveness is 'alive'.
  terminateOperationChild: (record: RuntimeOperationRecord) => Promise<void>
  // download: delete the partial ".incoming-*" staging dir (targetPath) so the next fetch starts clean.
  cleanStaging: (record: RuntimeOperationRecord) => Promise<void>
  // materialize/upgrade: verify the env prefix and rebuild it from its immutable lock if incomplete
  // (idempotent convergence). No-op when the prefix is already complete.
  verifyOrRebuildEnv: (record: RuntimeOperationRecord) => Promise<void>
  // external install: mark the runtime repair-required — an interrupted pip into the user's own env
  // may be half-applied; do NOT assume success and do NOT auto-retry (the user decides).
  markRepairRequired: (record: RuntimeOperationRecord) => Promise<void>
  // liveness 'unknown': we couldn't confirm the child died, so we neither kill nor reconcile it — but a
  // survivor might still be writing this operation's prefix. BLOCK that runtime/prefix (persistently, so
  // it survives the barrier releasing) until a later startup can reconcile it, instead of letting a
  // fresh materialize/install/repair proceed onto a possibly-live target. Without this, retaining the
  // journal entry only helps the NEXT boot; THIS session would still race the orphan once recovery
  // "completes" and the barrier opens.
  blockUnknownChildTarget: (record: RuntimeOperationRecord) => Promise<void>
  // Observed reconcile outcome per record (telemetry/tests). action is the branch taken.
  onReconciled?: (record: RuntimeOperationRecord, action: RecoveryAction) => void
}

export type RecoveryAction =
  | 'clean-staging'
  | 'verify-or-rebuild'
  | 'repair-required'
  | 'noop'
  // Liveness was 'unknown' — a survivor might still be writing, so the entry is left for a later startup.
  | 'skipped-child-unknown'

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
      const liveness =
        record.childPid === undefined ? 'dead' : await deps.operationChildLiveness(record)
      if (liveness === 'unknown') {
        // We can't tell whether the recorded child survived (no `ps` / Windows / unparsable). A live
        // orphan might still be writing staging or the prefix, so do NOT reconcile (which would delete
        // it out from under the writer). BLOCK the target runtime/prefix so a fresh op can't race the
        // possible survivor once the recovery barrier opens, and leave the journal entry so a later
        // startup — when the pid is gone or verifiable — reconciles it. Never destroy data on a guess.
        await deps.blockUnknownChildTarget(record)
        deps.onReconciled?.(record, 'skipped-child-unknown')
        continue
      }
      if (liveness === 'alive') {
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

// A live pid whose start time differs from the recorded childStartedAt by more than this is treated as
// a DIFFERENT process now holding a REUSED pid, not our orphan. Kept tight (was 60s): `ps -o etime`
// resolves to whole seconds and there is only a few ms between spawning the child and recording
// childStartedAt, so our own child's start time lands within a couple of seconds. A wide window let a
// pid reused shortly after our child exited masquerade as ours. Wide enough to absorb etime rounding +
// spawn latency, tight enough that a quickly-reused pid falls outside it and is classified 'dead'.
const PID_REUSE_TOLERANCE_MS = 10_000

// Tri-state liveness with a fail-SAFE pid-reuse guard. 'alive' means recovery will SIGKILL the pid, so
// we only report 'alive' when we can POSITIVELY confirm the live pid is the SAME process we spawned.
// When we genuinely cannot tell, we report 'unknown' — recovery then SKIPS the op (leaves the journal
// entry) rather than either killing an unrelated process or cleaning a dir a survivor may still write:
//   - No pid, or the pid is gone / not ours to signal (ESRCH/EPERM) → 'dead' (safe to reconcile).
//   - childStartedAt recorded (the normal case): confirm via `ps` that the pid's start time matches.
//       within tolerance → 'alive'; clearly different → 'dead' (pid reused, not ours);
//       can't verify (no `ps`, Windows, ps failed / unparsable) → 'unknown'.
//   - childStartedAt absent (legacy record, no start-time) with a LIVE pid: we can't rule out reuse, so
//     'unknown' rather than assuming it is our child (old code returned alive and would kill it).
export const defaultOperationChildLiveness = async (
  record: RuntimeOperationRecord
): Promise<OperationChildLiveness> => {
  if (record.childPid === undefined) return 'dead'
  try {
    process.kill(record.childPid, 0)
  } catch {
    // ESRCH = gone; EPERM = owned by another user, so not our child. Either way, nothing of ours to
    // kill and no writer of ours to protect → safe to reconcile.
    return 'dead'
  }
  // Live pid but no recorded start time (legacy): can't guard against reuse — don't guess it's ours.
  if (record.childStartedAt === undefined) return 'unknown'
  // Live pid, recorded start time, but no way to verify it (Windows has no ps here) — can't confirm.
  if (process.platform === 'win32') return 'unknown'
  const startedMs = await posixProcessStartMs(record.childPid)
  if (startedMs === undefined) return 'unknown' // couldn't read/parse the start time — can't confirm
  return Math.abs(startedMs - record.childStartedAt) <= PID_REUSE_TOLERANCE_MS ? 'alive' : 'dead'
}
