import { readdir, rm, stat, writeFile } from 'node:fs/promises'
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

// All top-level dirs under a data root. Used elsewhere (usage breakdown, legacy detection) to
// enumerate what a data root actually holds; no longer consulted by classifyDataRoot itself (see
// below - adopt is now keyed off the `OpenScience` marker subdir, not these).
export const DATA_ROOT_DIRS = ['artifacts', 'notebooks', 'runtime', 'uploads'] as const

// Dirs physically moved during a migration. runtime/ is intentionally EXCLUDED: it holds
// agent-installed conda/venv environments with hardcoded absolute paths (non-relocatable), so it
// is left in place and rebuilt on demand at the new root instead of being copied. See design §17.
export const MIGRATED_DIRS = ['artifacts', 'notebooks', 'uploads'] as const

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

  // Reject only control characters (near-impossible from the OS picker, but the New location field
  // also accepts typed input). Spaces are intentionally allowed on every platform: Windows profile
  // paths routinely contain them (C:\Users\John Doe), and blocking spaces there — or on macOS,
  // where spaced folders are common — is more user-hostile than the rare conda/venv quoting issue
  // it would guard against. Non-ASCII letters (accented, CJK) are allowed too.
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
  // only (MIGRATED_DIRS = artifacts/notebooks/uploads) — `runtime/` is a rebuildable environment,
  // NOT user data, so it is ignored entirely: it counts neither as "our data" (→ adopt) nor as
  // foreign content (→ invalid). Without this, a leftover runtime/ (e.g. after a prior move that
  // excludes runtime) would make a data-less folder look adoptable and silently switch to an empty
  // workspace.
  //   - contains any of artifacts/notebooks/uploads -> adopt (looks like our data; recovery/reuse).
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

type MigrationCopyDeps = {
  currentDataRoot: string
  runtime: { disconnect: () => Promise<unknown> }
  notebook: { shutdownAll: () => Promise<void> }
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
  runOpts: { signal: AbortSignal; onProgress: (p: MigrationProgress) => void }
): Promise<MigrationResult> => {
  const validation = await validateNewDataRoot(parent, deps.currentDataRoot)

  if (!validation.ok) return { ok: false, error: validation.error }

  const target = dataRootForPicked(parent)

  // Interrupt anything that could write mid-copy. Each step is independently wrapped: an interrupt
  // failure must not abort the copy (it's still safe to attempt), so it is logged and swallowed.
  try {
    await deps.runtime.disconnect()
  } catch (err) {
    console.error('[migration-service] runtime.disconnect failed', err)
  }
  try {
    await deps.notebook.shutdownAll()
  } catch (err) {
    console.error('[migration-service] notebook.shutdownAll failed', err)
  }

  const doCopyAndVerify = deps.copyAndVerify ?? copyAndVerify
  return doCopyAndVerify({
    from: deps.currentDataRoot,
    to: target,
    dirs: [...MIGRATED_DIRS],
    signal: runOpts.signal,
    onProgress: runOpts.onProgress
  })
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

  try {
    await deps.setDataRoot(target)
  } catch (err) {
    console.error('[migration-service] failed to persist new dataRoot', err)
    return {
      ok: false,
      error: `Your data was copied to ${target}, but the app could not finish switching over. Please try again; your current data is untouched.`,
      switchoverFailed: true
    }
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
