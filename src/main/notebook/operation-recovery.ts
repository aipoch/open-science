import { readFileSync } from 'node:fs'

import type { RuntimeOperationJournal, RuntimeOperationRecord } from './operation-journal'

// Injected side-effects for reconciling ONE interrupted runtime operation, so the startup-recovery
// orchestration is unit-tested without real processes, filesystem, or provisioner. See
// notebook-runtime-crash-recovery.
// Two-state liveness of an operation's recorded child (micromamba/pip/R):
//   - 'dead'    : positively confirmed gone / not ours (ESRCH/EPERM, or a reused pid) → safe to reconcile.
//   - 'unknown' : could NOT prove the child died (a live pid whose reuse we can't prove — a matching or
//                 unreadable start token, or no token at all on macOS/Windows/legacy) → a survivor MIGHT
//                 still be writing, so we must NOT clean staging / a prefix nor signal it; block and leave
//                 the journal entry for a later startup instead of destroying data under a live writer.
// Collapsing 'unknown' into 'dead' (the old boolean) is exactly the bug: it cleaned live processes' dirs.
//
// There is deliberately NO 'alive' state. We never auto-signal a child: a persisted pid (+ start token)
// can't give a strict "this live pid is still ours, safe to SIGKILL" guarantee (tick-coarse token; a
// probe→kill race could hit a reused pid). So a confirmed-live child is 'unknown' — recovery BLOCKS its
// target and leaves the entry, and the env self-heals on a later boot once the pid is gone. 'dead' means
// provably gone or provably reused (safe to reconcile); 'unknown' means "might be live" (block).
export type OperationChildLiveness = 'dead' | 'unknown'

export type OperationRecoveryDeps = {
  // Best-effort liveness of the operation's recorded child, as the two-state above. Callers pass a
  // platform check (see defaultOperationChildLiveness). Never 'alive' — see the type note.
  operationChildLiveness: (record: RuntimeOperationRecord) => Promise<OperationChildLiveness>
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
  // Fills in a record's childPid/childStartedAt from the SYNCHRONOUS PID sidecar when the journal's
  // async childPid update was lost to a crash. Returns the record enriched (or unchanged). This is what
  // makes a missing childPid provably mean "never spawned" (safe to reconcile) rather than a guess.
  hydrateInterruptedChild?: (record: RuntimeOperationRecord) => RuntimeOperationRecord
}

export type RecoveryAction =
  | 'clean-staging'
  | 'verify-or-rebuild'
  | 'repair-required'
  | 'noop'
  // Liveness was 'unknown' — a survivor might still be writing, so the entry is left for a later startup.
  | 'skipped-child-unknown'

// Reconciles every interrupted operation the journal recorded, run ONCE at startup. For each record:
// if a child from the dead parent might have survived ('unknown'), BLOCK its target and leave the entry
// (never reconcile — nor signal — under a possibly-live writer); otherwise ('dead': provably gone or
// reused) run the kind-appropriate reconcile, then CLEAR the journal entry so it is never reprocessed. A
// failure on one operation is logged and its entry left for a later attempt, so one bad op cannot
// block the rest. Returns the records that were reconciled + cleared.
export const reconcileInterruptedOperations = async (
  journal: RuntimeOperationJournal,
  deps: OperationRecoveryDeps
): Promise<RuntimeOperationRecord[]> => {
  const pending = await journal.pending()
  const reconciled: RuntimeOperationRecord[] = []

  for (const raw of pending) {
    try {
      // Fill in the childPid from the synchronous sidecar if the journal's async update was lost to a
      // crash, so the checks below act on the child that actually spawned.
      const record = deps.hydrateInterruptedChild?.(raw) ?? raw
      // Decide liveness from the spawn-lifecycle sidecar (hydrated above), never a wall-clock guess:
      //   - childPid present            -> probe it ('dead' | 'unknown').
      //   - spawnAttempted, no childPid -> reached the spawn stage but the PID was never recorded (a
      //                                    crash in the spawn→record window); a child MAY be live, so
      //                                    treat as 'unknown' and BLOCK — never reconcile under a writer.
      //   - neither                     -> the op never reached the spawn stage (no sidecar); there is no
      //                                    child, so it is safe to reconcile ('dead').
      const liveness =
        record.childPid !== undefined
          ? await deps.operationChildLiveness(record)
          : record.spawnAttempted
            ? 'unknown'
            : 'dead'
      if (liveness === 'unknown') {
        // We could not PROVE the recorded child died (its pid is still live and its identity can't be
        // strictly confirmed, or the probe was unavailable). A survivor might still be writing staging or
        // the prefix. We do NOT signal it (no strict "safe to kill" guarantee) and do NOT reconcile
        // (which would delete data under a live writer): instead BLOCK the target runtime/prefix so a
        // fresh op can't race the possible survivor once the recovery barrier opens, and leave the
        // journal entry so a LATER startup — when the pid is provably gone — reconciles it. The env
        // self-heals on a subsequent boot; we never destroy data on a guess.
        await deps.blockUnknownChildTarget(record)
        deps.onReconciled?.(record, 'skipped-child-unknown')
        continue
      }
      await runReconcileAction(record, deps)
      await journal.complete(record.operationId)
      reconciled.push(record)
    } catch (error) {
      console.error(
        `[notebook] operation recovery failed for ${raw.operationId}; leaving journal entry`,
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

// The kernel's process start time for `pid` in clock ticks since boot, read from `/proc/<pid>/stat`
// field 22. This is a REUSE FALSIFIER, not a hard identity: it is coarse (tick-granular — a pid reused
// within the same tick could in principle read the same value), so we never treat a MATCH as proof we
// may signal a pid. Its one sound use is the other direction — a token that DIFFERS from the record
// proves the pid was reused and our child is gone. Recovery/Reset use it only to release a block ('dead'
// on a proven-reused pid), never to authorize a kill; a match keeps the verdict 'unknown' (block). See
// defaultOperationChildLiveness. Returns undefined off Linux (no /proc) or when the pid is gone / stat is
// unreadable. stat's field 2 (comm) can contain spaces/parens, so we parse after the LAST ')' to reach
// the fixed numeric tail; field 22 (starttime) is index 19 of that tail (fields 3..end).
export const readProcessStartToken = (pid: number): string | undefined => {
  if (process.platform !== 'linux') return undefined
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return undefined
  }
  const lastParen = stat.lastIndexOf(')')
  if (lastParen === -1) return undefined
  const tail = stat
    .slice(lastParen + 1)
    .trim()
    .split(/\s+/)
  const starttime = tail[19] // field 22 overall; tail[0] is field 3 (state)
  return starttime !== undefined && /^\d+$/.test(starttime) ? starttime : undefined
}

// Seam for the token read so tests can inject a deterministic identity without a real /proc.
export type ProcessStartTokenReader = (pid: number) => string | undefined

// Two-state liveness ('dead' | 'unknown', never 'alive' — see OperationChildLiveness). We return 'dead'
// ONLY when the child is PROVABLY gone or PROVABLY reused (safe to reconcile), and 'unknown' whenever a
// live pid MIGHT still be our child (recovery/Reset then BLOCK — never signal, never reconcile). Every
// "dead" verdict rests on a SOUND signal — an OS existence probe or a monotonic kernel token — never on a
// wall-clock comparison (NTP/manual time steps could otherwise shift a reconstructed start time and make a
// LIVE child look reused → wrongly reconciled). Concretely:
//   - No pid recorded → 'dead' (the op never had a child to worry about).
//   - process.kill(pid,0) throws ESRCH (gone) or EPERM (exists but not ours to signal — our child would be
//     signalable) → our writer is gone either way → 'dead'. Any other errno is not proof → 'unknown'.
//   - Live pid + recorded token: read the live pid's token. Present-and-DIFFERENT → 'dead' (PROVEN reuse;
//     the boot-relative start tick is monotonic, so a changed value can only mean a different process now
//     holds the pid). Equal, or unreadable → 'unknown' (a match is coarse and is NOT license to signal).
//   - Live pid, NO token (legacy record / no /proc — macOS/Windows): we have no sound reuse signal, so
//     'unknown'. A genuinely-live orphan therefore stays blocked until a later boot makes the pid ESRCH.
export const defaultOperationChildLiveness = async (
  record: RuntimeOperationRecord,
  readToken: ProcessStartTokenReader = readProcessStartToken
): Promise<OperationChildLiveness> => {
  if (record.childPid === undefined) return 'dead'
  try {
    process.kill(record.childPid, 0)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ESRCH' || code === 'EPERM') return 'dead'
    return 'unknown'
  }
  // Live pid. The ONLY sound way to call it 'dead' now is a monotonic-token MISMATCH (proven reuse). A
  // match, an unreadable token, or no token at all → 'unknown' (block); we never reconcile a live pid on a
  // guess, and it self-heals once a later boot makes the pid ESRCH.
  if (record.childStartToken !== undefined) {
    const liveToken = readToken(record.childPid)
    if (liveToken !== undefined && liveToken !== record.childStartToken) return 'dead'
  }
  return 'unknown'
}
