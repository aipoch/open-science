import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { type Dirent } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import { dataRootForPicked, isPathInsideOrEqual, samePath } from '../storage-root'
import {
  copyAndVerify,
  deleteSources,
  type MigrationProgress,
  type MigrationResult
} from './data-migration'
import {
  MIGRATION_MARKER_FILENAME,
  newToken,
  readMigrationMarker,
  removeMigrationMarker,
  scanInventory,
  writeMigrationMarker,
  type MigrationMarker
} from './migration-marker'
import { waitForDataRootWriters } from './migration-state'
import { RELOCATABLE_DATA_DIRS } from './data-directories'

export { DATA_ROOT_DIRS } from './data-directories'

// Session workspaces contain user files and cloned repositories, so they move with artifacts,
// notebooks, and uploads. runtime/ is intentionally excluded because its environments can contain
// hardcoded absolute paths, so it is rebuilt on demand at the new root. See design §17.
export const MIGRATED_DIRS = RELOCATABLE_DATA_DIRS

export type ValidateResult = { ok: true } | { ok: false; error: string }

// Classification of a candidate data root relative to the current one. 'move' = empty and
// writable, safe for the copy-in migration engine. 'adopt' = already holds our data (a prior
// migration, or the user's own pre-existing folder) - the pointer should switch to it as-is,
// never be moved into. 'invalid' carries a user-facing reason.
export type DataRootKind = 'move' | 'adopt' | 'invalid'
export type ClassifyResult = { kind: DataRootKind; error?: string }

// Windows' historical MAX_PATH. Long-path opt-outs exist but aren't something we can rely on across
// every tool a user's Python/R environment might shell out to, so the app guards against it directly.
const WINDOWS_MAX_PATH = 260
// Headroom reserved for the app's deepest nested paths (artifacts/notebooks/runtime) under the root.
const WINDOWS_NESTED_RESERVE = 110

// Optional injectable deps for classifyDataRoot, so its write probe can be exercised in tests without
// depending on platform-specific filesystem permission semantics (chmod is a POSIX-only no-op on
// Windows).
type ClassifyDataRootDeps = { canWrite?: (dir: string) => Promise<boolean> }

// Real write probe (create + delete a temp file) instead of only fs.access(W_OK): access() checks
// POSIX bits but NOT macOS TCC (Documents/Desktop/Downloads/external & network volumes) or read-only
// mounts, so a folder can look writable yet reject the actual write.
const defaultCanWrite = async (dir: string): Promise<boolean> => {
  try {
    const probePath = join(dir, `.open-science-write-test-${randomUUID()}`)
    await writeFile(probePath, '')
    await rm(probePath, { force: true })
    return true
  } catch {
    return false
  }
}

// Classifies a candidate data root against the current one. `parent` is a directory the user
// picked; the app derives the data root from it (`dataRootForPicked`) rather than
// letting the user point directly at the data root itself. Never throws: any unexpected fs error
// (missing dir, permission denied) is mapped to an 'invalid' result with a user-facing message.
export const classifyDataRoot = async (
  parent: string,
  currentDataRoot: string,
  deps: ClassifyDataRootDeps = {}
): Promise<ClassifyResult> => {
  const resolvedParent = resolve(parent)
  const current = resolve(currentDataRoot)
  const target = dataRootForPicked(parent)

  // Reject control characters on every platform (near-impossible from the OS picker, but the New
  // location field also accepts typed input). Spaces are handled per-platform below: allowed on
  // Windows (profile paths routinely contain them, e.g. C:\Users\John Doe, and it has no shebangs),
  // but rejected on macOS/Linux where a spaced path breaks conda/venv console scripts. Non-ASCII
  // letters (accented, CJK) are allowed everywhere.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(target)) {
    return {
      kind: 'invalid',
      error: 'Choose a folder whose path has no control characters.'
    }
  }

  if (samePath(target, current)) {
    return { kind: 'invalid', error: 'The new location is the same as the current one.' }
  }
  if (isPathInsideOrEqual(current, target)) {
    return { kind: 'invalid', error: 'Choose a location outside the current data folder.' }
  }

  // On macOS/Linux, a spaced path can break conda/venv: Unix shebang lines (#!/path/bin/python)
  // can't contain a space, so pip/conda console scripts become unrunnable. Unlike the rest of this
  // module's warnings-that-don't-block, this is a hard rejection there. Windows has no shebangs and
  // routinely has spaced profile paths (C:\Users\John Doe), so spaces are allowed there.
  if (process.platform !== 'win32' && /\s/.test(target)) {
    return {
      kind: 'invalid',
      error:
        "Choose a folder whose path has no spaces — Python or R environments can't run reliably from a spaced path on macOS or Linux."
    }
  }

  // Windows' MAX_PATH (260 chars) applies to the full path of every file the app creates, not just
  // the root itself — a root that already eats most of the budget leaves no room for anything nested
  // under artifacts/notebooks/runtime. Reject early, before any fs access, so the failure is a clear
  // upfront message instead of a cryptic ENAMETOOLONG mid-migration or mid-notebook-run.
  if (process.platform === 'win32' && target.length + WINDOWS_NESTED_RESERVE > WINDOWS_MAX_PATH) {
    return {
      kind: 'invalid',
      error:
        "This location's path is too long for Windows. Choose a folder closer to the drive root so your files stay within Windows' 260-character path limit."
    }
  }

  try {
    const info = await stat(resolvedParent)

    if (!info.isDirectory()) {
      return { kind: 'invalid', error: 'The selected folder does not exist.' }
    }
  } catch {
    return { kind: 'invalid', error: 'The selected folder does not exist.' }
  }

  // Probing here surfaces TCC-denied, read-only, and out-of-space cases up front with a clear
  // message, before any migration starts (rather than failing mid-copy with a cryptic error).
  const canWrite = deps.canWrite ?? defaultCanWrite
  if (!(await canWrite(resolvedParent))) {
    return {
      kind: 'invalid',
      error:
        "Open Science can't write to this folder. Make sure you have permission to it — on macOS, grant access when prompted, or pick a folder inside your home directory."
    }
  }

  // Look one level into the existing target to classify it (design §21.5). Classify by USER data
  // only (MIGRATED_DIRS = artifacts/notebooks/uploads/workspaces) — `runtime/` is rebuildable,
  // NOT user data, so it is ignored entirely: it counts neither as "our data" (→ adopt) nor as
  // foreign content (→ invalid). Without this, a leftover runtime/ (e.g. after a prior move that
  // excludes runtime) would make a data-less folder look adoptable and silently switch to an empty
  // workspace.
  //   - contains any migrated user-data dir -> adopt (looks like our data; recovery/reuse).
  //     "Any", not "all": a real data folder can lack some (no uploads yet, etc.).
  //   - empty, OR holds only runtime/ -> move: safe to populate.
  //   - has other non-data content (foreign files/dirs) -> invalid: a folder that merely shares the
  //     name; adopting would show an empty workspace and populating would pollute the user's dir.
  try {
    const targetStat = await stat(target)
    if (!targetStat.isDirectory()) {
      return { kind: 'invalid', error: 'The selected folder is not usable.' }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'move' }
    return { kind: 'invalid', error: 'The selected folder is not usable.' }
  }

  let entries: Dirent[]
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch {
    return { kind: 'invalid', error: 'The selected folder is not usable.' }
  }

  // A marker means this folder is an in-progress/uncommitted staging copy from a migration that never
  // finished (e.g. a crash). Never adopt it — that would bypass the commit gate and switch to a possibly
  // incomplete snapshot — and never populate over it; the user must finish or discard that move first.
  if (entries.some((entry) => entry.name === MIGRATION_MARKER_FILENAME)) {
    return {
      kind: 'invalid',
      error:
        'This folder holds an unfinished data move. Finish or discard that move before using it here.'
    }
  }

  const looksLikeOurData = entries.some(
    (entry) => entry.isDirectory() && (MIGRATED_DIRS as readonly string[]).includes(entry.name)
  )
  if (looksLikeOurData) return { kind: 'adopt' }

  // runtime/ doesn't count as content: a folder holding only runtime (or nothing) is treated as empty.
  const meaningfulEntries = entries.filter((entry) => entry.name !== 'runtime')
  if (meaningfulEntries.length === 0) return { kind: 'move' }

  return {
    kind: 'invalid',
    error: 'A different folder named OpenScience already exists here. Choose another location.'
  }
}

// The MOVE gate for the copy-in migration engine: ok only for a target classified 'move'. A
// target that already contains our data is no longer silently treated as invalid - it is the
// adopt case (see classifyDataRoot/storage:inspect-data-root) - but the engine itself must still
// never copy into a non-empty target, so it keeps its own rejection message here.
export const validateNewDataRoot = async (
  parent: string,
  currentDataRoot: string
): Promise<ValidateResult> => {
  const result = await classifyDataRoot(parent, currentDataRoot)

  if (result.kind === 'move') return { ok: true }
  if (result.kind === 'adopt') {
    return {
      ok: false,
      error: 'The selected folder already contains Open Science data. Pick an empty folder.'
    }
  }

  return { ok: false, error: result.error ?? 'The selected folder is not usable.' }
}

// A post-move `setDataRoot` failure is distinguishable from an ordinary migration failure: the
// data already lives at the target, so the caller needs a different recovery message and must not
// treat this like a retryable pre-move failure.
export type MigrationOutcome =
  MigrationResult | { ok: false; error: string; switchoverFailed: true }

type MigrationInventory = NonNullable<MigrationMarker['inventory']>

const sameInventory = (left: MigrationInventory, right: MigrationInventory): boolean =>
  left.fileCount === right.fileCount &&
  left.totalBytes === right.totalBytes &&
  left.digest === right.digest &&
  left.dirs.length === right.dirs.length &&
  left.dirs.every((dir, index) => dir === right.dirs[index])

type MigrationCopyDeps = {
  currentDataRoot: string
  runtime: { disconnect: () => Promise<unknown> }
  // Return ignored (awaited only), so kept as Promise<unknown> — mirrors runtime.disconnect above and
  // stays compatible with both the real service (now returns { reaped }) and void test fakes.
  notebook: { shutdownAll: () => Promise<unknown> }
  // Injectable for tests; defaults to the real ./data-migration engine function.
  copyAndVerify?: (opts: {
    from: string
    to: string
    dirs: string[]
    signal: AbortSignal
    onProgress: (p: MigrationProgress) => void
    forceCopy?: boolean
  }) => Promise<MigrationResult>
}

type MigrationCommitDeps = {
  currentDataRoot: string
  setDataRoot: (path: string) => Promise<void>
  // Marker token the IPC layer captured when THIS session's copy completed. Commit refuses unless the
  // on-disk marker still carries the same token, so a stale/foreign copy can never be committed.
  expectedToken: string
  // Injectable for tests; defaults to the real ./data-migration engine function.
  deleteSources?: (
    from: string,
    dirs: string[],
    onProgress?: (p: MigrationProgress) => void
  ) => Promise<{ deleted: string[]; failed: { dir: string; error: string }[] }>
}

// PHASE 1 (copy): validate the move parent -> interrupt running writers -> copy+verify the migrated
// dirs into `<parent>/OpenScience`. NOTHING is committed here — no setDataRoot, no delete. The old
// root and settings.dataRoot are left fully intact, so this phase is entirely reversible: on
// success the new root holds a verified copy the caller can either commit (commitDataRootSwitch) or
// throw away (the caller rm's the target). On failure/cancel the partial target is rolled back by
// copyAndVerify. Never throws (validation + interrupt are wrapped; copyAndVerify never rejects).
export const runDataRootMigration = async (
  deps: MigrationCopyDeps,
  parent: string,
  runOpts: {
    signal: AbortSignal
    onProgress: (p: MigrationProgress) => void
    onVerified?: (staged: { token: string; target: string }) => void
  }
): Promise<MigrationResult> => {
  const validation = await validateNewDataRoot(parent, deps.currentDataRoot)

  if (!validation.ok) return { ok: false, error: validation.error }

  const target = dataRootForPicked(parent)

  // Stamp a 'copying' marker into the staging dir BEFORE any bytes are copied. Its presence makes a
  // half-copied target unmistakably "not committed": computeDefaultDataRoot skips a marker-bearing
  // homeDefault, and the commit gate refuses anything that isn't marked 'verified'.
  const marker: MigrationMarker = {
    version: 1,
    token: newToken(),
    source: deps.currentDataRoot,
    target,
    createdAt: Date.now(),
    status: 'copying'
  }
  try {
    await mkdir(target, { recursive: true })
    await writeMigrationMarker(target, marker)
  } catch (err) {
    console.error('[migration-service] failed to initialize staging dir', err)
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'Could not prepare the new data location. Please try again.' }
  }

  // Freeze in-flight writers before copying. If either interrupt fails we must NOT copy an unfrozen
  // tree — a surviving write would land outside the snapshot and be lost on the commit's delete — so
  // clean up the staging dir and abort rather than swallow the failure and press on.
  try {
    await deps.runtime.disconnect()
    await deps.notebook.shutdownAll()
    await waitForDataRootWriters()
  } catch (err) {
    console.error('[migration-service] failed to pause writers; aborting migration', err)
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return {
      ok: false,
      error: 'Could not pause running work to copy your data safely. Please try again in a moment.'
    }
  }

  const doCopyAndVerify = deps.copyAndVerify ?? copyAndVerify
  let result: MigrationResult
  try {
    result = await doCopyAndVerify({
      from: deps.currentDataRoot,
      to: target,
      dirs: [...MIGRATED_DIRS],
      signal: runOpts.signal,
      onProgress: runOpts.onProgress
    })
  } catch (err) {
    console.error('[migration-service] copy engine failed unexpectedly', err)
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'Could not copy your data. Please try again.' }
  }

  if (!result.ok) {
    // Remove the whole staging dir we created (marker + anything copyAndVerify's rollback missed) so a
    // half-baked, marker-less folder can never later be mistaken for a committed data root. Safe: a
    // 'move' target only ever holds our copy plus at most a rebuildable runtime/, never user data.
    await rm(target, { recursive: true, force: true }).catch((err) =>
      console.error('[migration-service] failed to clean up staging dir after failed copy', err)
    )
    return result
  }

  if (runOpts.signal.aborted) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'migration cancelled', cancelled: true }
  }

  // Record what was staged and promote the marker to 'verified' — the only state the commit gate accepts.
  let inventory
  try {
    inventory = await scanInventory(target, [...MIGRATED_DIRS])
  } catch (err) {
    console.error('[migration-service] failed to inventory staged copy', err)
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'Could not verify the copied data. Please run the move again.' }
  }
  if (runOpts.signal.aborted) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'migration cancelled', cancelled: true }
  }
  try {
    await writeMigrationMarker(target, { ...marker, status: 'verified', inventory })
    runOpts.onVerified?.({ token: marker.token, target })
  } catch (err) {
    console.error('[migration-service] failed to finalize staged copy', err)
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, error: 'Could not finalize the copied data. Please run the move again.' }
  }
  return result
}

// PHASE 2 (commit): flip settings.dataRoot to the (already-copied, verified) new root, THEN delete
// the old root's migrated dirs. Order is load-bearing: setDataRoot is an atomic write, and once it
// succeeds the new root is canonical — so an interruption during the (possibly slow) delete only
// leaves harmless leftovers at the now-orphan old root, never data loss. Doing it the other way
// (delete then setDataRoot) could strand data if it crashed in between. The caller invokes this from
// the user's "Restart now" click and relaunches on { ok: true }. A setDataRoot failure is surfaced
// as switchoverFailed (copy still intact at the new root; old root untouched, app still usable).
export const commitDataRootSwitch = async (
  deps: MigrationCommitDeps,
  parent: string
): Promise<MigrationOutcome> => {
  const target = dataRootForPicked(parent)

  // Commit gate: only ever promote a fully-staged copy whose marker matches THIS exact source→target
  // pair. This blocks committing a half-copied dir (crash mid-copy), a stale marker from an earlier
  // aborted move, or a copy staged against a different current root — any of which could delete the
  // wrong data on the delete step below.
  const marker = await readMigrationMarker(target)
  if (!marker || marker.status !== 'verified') {
    return { ok: false, error: 'No completed migration copy was found to commit.' }
  }
  if (!samePath(marker.source, deps.currentDataRoot)) {
    return { ok: false, error: 'The staged copy does not match your current data location.' }
  }
  if (!samePath(marker.target, target)) {
    return { ok: false, error: 'The staged copy is for a different destination.' }
  }
  if (!deps.expectedToken || marker.token !== deps.expectedToken) {
    return { ok: false, error: 'The staged copy is from a different migration attempt.' }
  }
  if (!marker.inventory) {
    return { ok: false, error: 'The staged copy has no verified inventory.' }
  }

  let inventories: [MigrationInventory, MigrationInventory]
  try {
    inventories = await Promise.all([
      scanInventory(deps.currentDataRoot, [...MIGRATED_DIRS]),
      scanInventory(target, [...MIGRATED_DIRS])
    ])
  } catch (err) {
    console.error('[migration-service] failed to recheck staged copy inventory', err)
    return { ok: false, error: 'Could not recheck the copied data. Run the move again.' }
  }
  const [sourceInventory, targetInventory] = inventories
  if (
    !sameInventory(marker.inventory, sourceInventory) ||
    !sameInventory(marker.inventory, targetInventory)
  ) {
    return { ok: false, error: 'The staged copy changed after verification. Run the move again.' }
  }

  try {
    await deps.setDataRoot(target)
  } catch (err) {
    // Leave the marker in place: the copy stays a discardable staging dir the user can retry or throw
    // away, exactly as before the failed switch.
    console.error('[migration-service] failed to persist new dataRoot', err)
    return {
      ok: false,
      error: `Your data was copied to ${target}, but the app could not finish switching over. Please try again; your current data is untouched.`,
      switchoverFailed: true
    }
  }

  // The pointer is now committed, so the target is the live root and should carry NO marker. Removal is
  // best-effort: the switch already succeeded, so a failure here must NOT fail the commit — that would
  // leave settings pointing at the new root while this process still used the old one (split brain). A
  // leftover marker is benign: discardStagedCopy refuses the live root, and computeDefaultDataRoot only
  // consults it for a legacy fallback the committed settings.dataRoot overrides anyway.
  try {
    await removeMigrationMarker(target)
  } catch (err) {
    console.error('[migration-service] failed to remove marker after commit (benign leftover)', err)
  }

  const doDeleteSources = deps.deleteSources ?? deleteSources
  const deleteResult = await doDeleteSources(deps.currentDataRoot, [...MIGRATED_DIRS])
  if (deleteResult.failed.length > 0) {
    console.error('[migration-service] some old data-root dirs could not be deleted', {
      failed: deleteResult.failed
    })
  }

  return { ok: true }
}

// Throws away an uncommitted staged copy at `<parent>/OpenScience` (the user chose "Keep current
// location" on the done stage). Refuses unless the target is genuinely a staging copy for the current
// root — never the live data location, and only when a marker confirms this source→target pair — so a
// misrouted parent can never rm the folder the app is actively using.
export const discardStagedCopy = async (
  deps: { currentDataRoot: string; expectedToken: string },
  parent: string
): Promise<{ ok: boolean; error?: string }> => {
  const target = dataRootForPicked(parent)

  if (isPathInsideOrEqual(deps.currentDataRoot, target)) {
    return { ok: false, error: 'Refused: target is the current data location.' }
  }

  const marker = await readMigrationMarker(target)
  if (
    !marker ||
    marker.status !== 'verified' ||
    !samePath(marker.target, target) ||
    !samePath(marker.source, deps.currentDataRoot) ||
    !deps.expectedToken ||
    marker.token !== deps.expectedToken
  ) {
    // status must be 'verified' (never delete a dir mid-copy) and the token must match this session's
    // staged copy — a stale renderer call for another/earlier path is refused rather than obeyed.
    return { ok: false, error: 'Refused: not a completed, matching staged copy.' }
  }

  await rm(target, { recursive: true, force: true })
  return { ok: true }
}
