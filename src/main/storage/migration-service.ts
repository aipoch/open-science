import { lstat, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve } from 'node:path'

import type {
  DataRootKind,
  DataRootRecoveryStatus,
  DataRootValidationResult,
  MigrationOutcome,
  MigrationProgress,
  MigrationResult
} from '../../shared/storage'
import {
  dataRootForPicked,
  isPathInsideOrEqual,
  resolveConfigRoot,
  samePath
} from '../storage-root'
import {
  capturePortableMetadata,
  copyAndVerify,
  deleteSources,
  restorePortableMetadata,
  validateMigrationSourceLinks
} from './data-migration'
import {
  MIGRATION_MARKER_FILENAME,
  newToken,
  readMigrationMarker,
  removeMigrationMarker,
  scanInventory,
  writeMigrationMarker,
  type MigrationInventory,
  type MigrationMarker
} from './migration-marker'
import { waitForDataRootWriters } from './migration-state'
import { DEFAULT_MAX_ENV_RELATIVE_PATH, PACK_PATH_BUDGET_FILE } from '../notebook/bundle-manifest'
import { windowsDefaultEnvPrefixReserve } from '../notebook/runtime-paths'
import { MIGRATABLE_DATA_DIRS } from './data-directories'
import { validateProvenanceMigrationState } from './provenance-migration-validation'
import { disconnectProjectDbClient } from '../projects/prisma-client'
import { createLogger, type Logger } from '../logger'
import { startDiagnosticOperation } from '../diagnostics/operation'
import { inspectWindowsStoragePath, type WindowsStoragePathCapabilities } from './remote-data-root'
import { toErrorMessage } from '../error-message'
import type { DataRootCleanupJournal } from './data-root-cleanup'

export { DATA_ROOT_DIRS } from './data-directories'

// Session workspaces and caches move with the other relocatable data. runtime/ is intentionally
// excluded because its environments can contain hardcoded absolute paths, so it is rebuilt on
// demand at the new root. See design §17.
export const MIGRATED_DIRS = MIGRATABLE_DATA_DIRS

// Classification of a candidate data root relative to the current one. 'move' = empty and
// writable, safe for the copy-in migration engine. 'adopt' = already holds our data (a prior
// migration, or the user's own pre-existing folder) - the pointer should switch to it as-is,
// never be moved into. 'recover' is a marker-confirmed copy left by an interrupted migration;
// 'invalid' carries a user-facing reason.
export type ClassifyResult =
  | { kind: 'recover'; recoveryStatus: DataRootRecoveryStatus; error?: string }
  | {
      kind: Exclude<DataRootKind, 'recover'>
      recoveryStatus?: never
      error?: string
    }

// Windows' historical MAX_PATH. Long-path opt-outs exist but aren't something we can rely on across
// every tool a user's Python/R environment might shell out to, so the app guards against it directly.
const WINDOWS_MAX_USABLE_PATH = 259
// Headroom reserved for the app's deepest nested paths (artifacts/notebooks/runtime) under the root.
// Keep the migration guard aligned with the physical default prefix selected by runtime-paths plus
// the longest linked package path. Logical names deliberately do not participate in this budget.
const WINDOWS_ENV_PREFIX_RESERVE = windowsDefaultEnvPrefixReserve()

const runtimeTreeContainsLink = async (path: string): Promise<boolean> => {
  let state
  try {
    state = await lstat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  if (state.isSymbolicLink() || !state.isDirectory()) return state.isSymbolicLink()

  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return true
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return true
    if (entry.isDirectory() && (await runtimeTreeContainsLink(join(path, entry.name)))) return true
  }
  return false
}

// A move target may contain empty runtime scaffolding left by a prior Data Storage location, but it
// must not contain files or links. Once the staging marker is written, migration failures remove the
// whole target; accepting pre-existing runtime data here would therefore turn rollback into data loss.
// Read failures also mean "contains data" so the migration fails closed without deleting the target.
const runtimeTreeContainsData = async (runtimeRoot: string): Promise<boolean> => {
  let entries: Dirent[]
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true })
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) return true
    if (await runtimeTreeContainsData(join(runtimeRoot, entry.name))) return true
  }
  return false
}

export const maxManagedEnvRelativePath = (dataRoot: string): number => {
  let maximum = DEFAULT_MAX_ENV_RELATIVE_PATH
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(child)
      } else if (entry.isFile() && entry.name === PACK_PATH_BUDGET_FILE) {
        try {
          const value = JSON.parse(readFileSync(child, 'utf8')) as { maxEnvRelativePath?: unknown }
          if (
            typeof value.maxEnvRelativePath === 'number' &&
            Number.isSafeInteger(value.maxEnvRelativePath) &&
            value.maxEnvRelativePath > 0
          ) {
            maximum = Math.max(maximum, value.maxEnvRelativePath)
          }
        } catch {
          // Ignore malformed residue and retain the conservative supported-pack fallback.
        }
      }
    }
  }
  walk(join(dataRoot, 'runtime', 'packs'))
  return maximum
}

// Optional injectable deps for classifyDataRoot, so its write probe can be exercised in tests without
// depending on platform-specific filesystem permission semantics (chmod is a POSIX-only no-op on
// Windows).
type ClassifyDataRootDeps = {
  canWrite?: (dir: string) => Promise<boolean>
  inspectPath?: (
    dir: string
  ) => WindowsStoragePathCapabilities | Promise<WindowsStoragePathCapabilities>
}

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

const canonicalTargetForParent = async (
  resolvedParent: string,
  target: string
): Promise<string> => {
  try {
    return resolve(await realpath(target))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const canonicalParent = resolve(await realpath(resolvedParent))
  return resolve(canonicalParent, relative(resolvedParent, target))
}

const validateCanonicalTarget = async (
  currentDataRoot: string,
  resolvedParent: string,
  target: string
): Promise<DataRootValidationResult> => {
  let current: string
  try {
    current = resolve(await realpath(currentDataRoot))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
    // Missing-root recovery has no source tree to escape into. Retain the normalized configured
    // path for lexical overlap checks; setDataRootAndRelaunch classifies again after target mkdir,
    // so a drive that reconnects during the operation is canonicalized before pointer persistence.
    current = resolve(currentDataRoot)
  }
  const canonicalTarget = await canonicalTargetForParent(resolvedParent, target)
  if (samePath(canonicalTarget, current)) {
    return { ok: false, error: 'The new location is the same as the current one.' }
  }
  if (isPathInsideOrEqual(current, canonicalTarget)) {
    return { ok: false, error: 'Choose a location outside the current data folder.' }
  }
  return { ok: true }
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

  const inspectPath = deps.inspectPath ?? inspectWindowsStoragePath
  const validateWindowsStoragePath = async (path: string): Promise<ClassifyResult | undefined> => {
    if (process.platform !== 'win32') return undefined

    const capabilities = await inspectPath(path)
    if (capabilities.isRemote) {
      return {
        kind: 'invalid',
        error:
          'Network folders are not supported as the Open Science data location on Windows. Choose a folder on a local drive.'
      }
    }
    if (!capabilities.supportsHardLinks) {
      return {
        kind: 'invalid',
        error:
          "This drive's file system does not support safe atomic publication on Windows. Choose a folder on a drive that supports hard links, such as NTFS."
      }
    }
    return undefined
  }

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
  if (process.platform === 'win32') {
    const windowsNestedReserve =
      WINDOWS_ENV_PREFIX_RESERVE + maxManagedEnvRelativePath(currentDataRoot)
    if (target.length + windowsNestedReserve > WINDOWS_MAX_USABLE_PATH) {
      return {
        kind: 'invalid',
        error:
          "This location's path is too long for Windows. Choose a folder closer to the drive root so your files stay within Windows' 260-character path limit."
      }
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

  try {
    const canonicalValidation = await validateCanonicalTarget(
      currentDataRoot,
      resolvedParent,
      target
    )
    if (!canonicalValidation.ok) return { kind: 'invalid', error: canonicalValidation.error }
  } catch {
    return { kind: 'invalid', error: 'The selected folder is not usable.' }
  }

  try {
    const invalid = await validateWindowsStoragePath(resolvedParent)
    if (invalid) return invalid
  } catch {
    return { kind: 'invalid', error: 'The selected folder is not usable.' }
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
  // only (MIGRATED_DIRS = artifacts/compute/delegation/notebooks/uploads/workspaces) — `runtime/` is rebuildable,
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

    const invalid = await validateWindowsStoragePath(target)
    if (invalid) return invalid
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

  // A trustworthy marker identifies an interrupted staging copy. Surface it as an explicit recovery
  // state rather than adopt (which would bypass commit validation) or move (which would overwrite it).
  // Corrupt/foreign markers remain invalid and are never made actionable.
  if (entries.some((entry) => entry.name === MIGRATION_MARKER_FILENAME)) {
    const marker = await readMigrationMarker(target)
    if (
      marker &&
      samePath(marker.source, current) &&
      samePath(marker.target, target) &&
      !samePath(target, current)
    ) {
      return {
        kind: 'recover',
        recoveryStatus: marker.status,
        error:
          'This folder holds an unfinished data move. Finish or discard that move before using it here.'
      }
    }
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
): Promise<DataRootValidationResult> => {
  const result = await classifyDataRoot(parent, currentDataRoot)

  if (result.kind === 'move') return { ok: true }
  if (result.kind === 'adopt') {
    return {
      ok: false,
      error: 'The selected folder already contains Open Science data. Pick an empty folder.'
    }
  }
  if (result.kind === 'recover') {
    return {
      ok: false,
      error:
        result.error ??
        'This folder holds an unfinished data move. Finish or discard that move before using it here.'
    }
  }

  return { ok: false, error: result.error ?? 'The selected folder is not usable.' }
}

// runtime/ is not copied wholesale (env prefixes and mutable inventory-cache keys bake absolute
// paths), but its pkgs cache IS relocatable inert data — copied so envs can be rebuilt offline at the
// new root from their exported locks. Immutable Environment manifests are copied separately because
// Notebook and Artifact provenance reference them by checksum. The repair-required registry is also
// relocatable: managed keys use environment names, while external keys continue to name the same
// user-owned runtimes. Preserving it is load-bearing because missing state could reactivate a runtime
// quarantined after an interrupted or identity-changing operation. Nested paths are intentional:
// copyAndVerify mirrors `from/<path>` → `to/<path>` and accepts regular files as roots.
const RUNTIME_PKGS_DIR = join('runtime', 'pkgs')
const RUNTIME_ENVS_LOCK_DIR = join('runtime', 'envs.lock')
export const RUNTIME_REPAIR_REGISTRY_FILE = join('runtime', '.repair-required.json')
export const RUNTIME_ENVIRONMENT_MANIFESTS_DIR = join(
  'runtime',
  'provenance',
  'environment-manifests'
)
const RUNTIME_ENVIRONMENT_INVENTORY_DIR = join('runtime', 'provenance', 'environment-inventory')
// The SQLite authority stays under the fixed config root. Keep the filename exported for migration
// validation/tests, but never put it in the relocatable data-root copy/delete set.
export const PROJECT_DATABASE_FILE = 'open-science.db'
const BASE_MIGRATION_DIRS = [
  ...MIGRATED_DIRS,
  RUNTIME_ENVIRONMENT_MANIFESTS_DIR,
  RUNTIME_REPAIR_REGISTRY_FILE
]

const defaultValidateProvenanceState = (dataRoot: string): Promise<void> =>
  validateProvenanceMigrationState(dataRoot, resolveConfigRoot())

const sameInventory = (left: MigrationInventory, right: MigrationInventory): boolean =>
  left.fileCount === right.fileCount &&
  left.totalBytes === right.totalBytes &&
  left.digest === right.digest &&
  left.dirs.length === right.dirs.length &&
  left.dirs.every((dir, index) => dir === right.dirs[index])

const captureRuntimeLockInventory = async (
  target: string,
  preservedEnvs: string[]
): Promise<MigrationInventory | undefined> => {
  const expectedFiles = [...new Set(preservedEnvs)].map((name) => `${name}.lock`).sort()
  if (expectedFiles.length === 0) return undefined

  const entries = await readdir(join(target, RUNTIME_ENVS_LOCK_DIR), { withFileTypes: true })
  if (
    entries.some((entry) => !entry.isFile()) ||
    entries.length !== expectedFiles.length ||
    entries
      .map((entry) => entry.name)
      .sort()
      .some((name, index) => name !== expectedFiles[index])
  ) {
    return undefined
  }

  const inventory = await scanInventory(target, [RUNTIME_ENVS_LOCK_DIR])
  return inventory.dirs.length === 1 &&
    inventory.dirs[0] === RUNTIME_ENVS_LOCK_DIR &&
    inventory.fileCount === expectedFiles.length
    ? inventory
    : undefined
}

const hasVerifiedRuntimeLockBundle = async (
  target: string,
  receipt: MigrationInventory | undefined
): Promise<boolean> => {
  if (
    !receipt ||
    receipt.fileCount < 1 ||
    receipt.dirs.length !== 1 ||
    receipt.dirs[0] !== RUNTIME_ENVS_LOCK_DIR ||
    !existsSync(join(target, RUNTIME_PKGS_DIR))
  ) {
    return false
  }
  try {
    return sameInventory(receipt, await scanInventory(target, [RUNTIME_ENVS_LOCK_DIR]))
  } catch {
    return false
  }
}

type DataRootWriterPauseDeps = {
  logger?: Logger
  runtime: { disconnect: () => Promise<unknown> }
  notebook: { shutdownAll: () => Promise<{ reaped: boolean } | void> }
  // Releases the shared SQLite authority connection before migration validation opens its dedicated
  // checkpoint client. Injectable so ordering remains testable without module-level state.
  disconnectProjectDb?: () => Promise<void>
}

// Re-establishes the quiescent-data-root invariant used by both a fresh copy and a recovered commit.
// The caller raises the migration write gate before invoking this helper so no new writer can enter
// while existing leases drain.
export const pauseDataRootWriters = async (deps: DataRootWriterPauseDeps): Promise<void> => {
  await deps.runtime.disconnect()
  const notebookShutdown = await deps.notebook.shutdownAll()
  if (notebookShutdown?.reaped === false) {
    throw new Error('Notebook processes could not be stopped before data migration.')
  }
  await (deps.disconnectProjectDb ?? disconnectProjectDbClient)()
  await waitForDataRootWriters()
}

type MigrationCopyDeps = DataRootWriterPauseDeps & {
  currentDataRoot: string
  diagnosticCorrelationId?: string
  // The composition root supplies Notebook-owned cache cleanup. A runtime-only target may contain
  // rebuildable residue, but migration must not commit a stale or ownership-unverified cache.
  cleanupRuntimeCache?: (runtimeRoot: string) => boolean
  // Exports each conda env under the old runtime to an all-or-nothing @EXPLICIT lock bundle at the
  // new root. Returns the env names preserved; [] when nothing could be exported. Injectable and
  // optional so tests and non-notebook contexts can skip it; failures retain the old runtime.
  exportRuntimeLocks?: (fromDataRoot: string, toDataRoot: string) => Promise<string[]>
  // Injectable for tests; defaults to the real ./data-migration engine function.
  copyAndVerify?: (opts: {
    from: string
    to: string
    dirs: string[]
    signal: AbortSignal
    onProgress: (p: MigrationProgress) => void
  }) => Promise<MigrationResult>
  validateProvenanceState?: (root: string) => Promise<void>
}

type MigrationCommitDeps = {
  currentDataRoot: string
  logger?: Logger
  diagnosticCorrelationId?: string
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
  validateProvenanceState?: (root: string) => Promise<void>
  cleanupJournal?: DataRootCleanupJournal
  cleanupRuntimeCache?: (sourceRoot: string) => Promise<boolean> | boolean
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
  const operation = startDiagnosticOperation(deps.logger ?? createLogger('storage:migration'), {
    operation: 'data-root-copy',
    fields: { mode: 'move', correlationId: deps.diagnosticCorrelationId }
  })
  operation.phase('validate-target')
  const validation = await validateNewDataRoot(parent, deps.currentDataRoot)

  if (!validation.ok) {
    operation.fail(new Error(validation.error))
    return { ok: false, error: validation.error }
  }

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
  operation.phase('prepare-staging')
  const targetRuntimeRoot = join(target, 'runtime')
  if (await runtimeTreeContainsLink(targetRuntimeRoot)) {
    const error = new Error('The new data location contains a linked runtime path.')
    operation.fail(error)
    return {
      ok: false,
      error:
        'The new data location contains runtime data that Open Science cannot safely replace. Choose another location or remove that data first.'
    }
  }
  let targetRuntimeCacheClean = true
  try {
    targetRuntimeCacheClean = deps.cleanupRuntimeCache?.(targetRuntimeRoot) ?? true
  } catch {
    targetRuntimeCacheClean = false
  }
  if (!targetRuntimeCacheClean) {
    const error = new Error('The new data location contains an untrusted runtime cache.')
    operation.fail(error)
    return {
      ok: false,
      error:
        'The new data location contains a Notebook cache that Open Science cannot safely replace. Choose another location or remove that cache first.'
    }
  }
  try {
    await mkdir(target, { recursive: true })
    const canonicalValidation = await validateCanonicalTarget(
      deps.currentDataRoot,
      resolve(parent),
      target
    )
    if (!canonicalValidation.ok) {
      operation.fail(new Error(canonicalValidation.error))
      return canonicalValidation
    }
    // A runtime-only destination is a valid move target and may be residue from an earlier location.
    // The injected owner cleanup above removed verified rebuildable caches; now drop the path-keyed
    // mutable Environment inventory. Any remaining runtime data is rejected below before the target
    // becomes staging-owned, so rollback can never delete pre-existing archives or unknown files.
    await rm(join(target, RUNTIME_ENVIRONMENT_INVENTORY_DIR), { recursive: true, force: true })
  } catch (err) {
    operation.fail(err)
    return { ok: false, error: 'Could not prepare the new data location. Please try again.' }
  }

  if (await runtimeTreeContainsData(targetRuntimeRoot)) {
    const error = new Error('The new data location contains existing runtime data.')
    operation.fail(error)
    return {
      ok: false,
      error:
        'The new data location contains runtime data that Open Science cannot safely replace. Choose another location or remove that data first.'
    }
  }

  try {
    await writeMigrationMarker(target, marker)
  } catch (err) {
    // The target is not staging-owned until its marker is complete. Remove only a possibly partial
    // marker; preserving the target avoids deleting data written by another actor during preparation.
    await removeMigrationMarker(target).catch(() => undefined)
    operation.fail(err)
    return { ok: false, error: 'Could not prepare the new data location. Please try again.' }
  }

  // Freeze in-flight writers before copying. If either interrupt fails we must NOT copy an unfrozen
  // tree — a surviving write would land outside the snapshot and be lost on the commit's delete — so
  // clean up the staging dir and abort rather than swallow the failure and press on.
  operation.phase('pause-writers')
  try {
    await pauseDataRootWriters(deps)
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    operation.fail(err)
    return {
      ok: false,
      error: 'Could not pause running work to copy your data safely. Please try again in a moment.'
    }
  }

  const migrateDirs = [...BASE_MIGRATION_DIRS, RUNTIME_PKGS_DIR]
  let sourceMetadata
  try {
    sourceMetadata = await capturePortableMetadata(deps.currentDataRoot, migrateDirs)
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    operation.fail(error)
    return { ok: false, error: 'Could not inspect your data before copying it. Please try again.' }
  }
  const restoreSourceMetadata = async (): Promise<void> => {
    await restorePortableMetadata(deps.currentDataRoot, sourceMetadata)
  }

  const validateProvenanceState = deps.validateProvenanceState ?? defaultValidateProvenanceState
  operation.phase('validate-source')
  try {
    await validateProvenanceState(deps.currentDataRoot)
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await restoreSourceMetadata().catch(() => undefined)
    operation.fail(error)
    return {
      ok: false,
      error: `Could not verify provenance data: ${toErrorMessage(error)}`
    }
  }

  // Preserve the runtime: export every materialized env to one all-or-nothing offline @EXPLICIT
  // bundle at the new root, then copy the relocatable pkgs archive store alongside user data.
  // Already-published durable archives follow Data Storage even when lock export is unavailable.
  operation.phase('preserve-runtime')
  let preservedEnvs: string[] = []
  let runtimePreservationDegraded = false
  if (deps.exportRuntimeLocks) {
    try {
      preservedEnvs = await deps.exportRuntimeLocks(deps.currentDataRoot, target)
    } catch {
      runtimePreservationDegraded = true
      await rm(join(target, RUNTIME_ENVS_LOCK_DIR), { recursive: true, force: true }).catch(
        () => undefined
      )
    }
  }
  const sourceLinks = await validateMigrationSourceLinks(deps.currentDataRoot, migrateDirs)
  if (!sourceLinks.ok) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await restoreSourceMetadata().catch(() => undefined)
    operation.fail(new Error(sourceLinks.error))
    return sourceLinks
  }

  const doCopyAndVerify = deps.copyAndVerify ?? copyAndVerify
  let result: MigrationResult
  operation.phase('copy')
  const progressMilestones = new Set<number>()
  const reportProgress = (progress: MigrationProgress): void => {
    runOpts.onProgress(progress)
    if (!Number.isFinite(progress.copiedBytes) || !Number.isFinite(progress.totalBytes)) return
    const percent =
      progress.totalBytes <= 0
        ? 0
        : Math.max(0, Math.min(100, Math.floor((progress.copiedBytes / progress.totalBytes) * 100)))
    for (const milestone of [0, 25, 50, 75, 100]) {
      if (milestone > percent || progressMilestones.has(milestone)) continue
      progressMilestones.add(milestone)
      operation.phase('copy', {
        progressPhase: progress.phase,
        progressPercent: milestone,
        copiedBytes: Math.max(0, progress.copiedBytes),
        totalBytes: Math.max(0, progress.totalBytes)
      })
    }
  }
  try {
    result = await doCopyAndVerify({
      from: deps.currentDataRoot,
      to: target,
      dirs: migrateDirs,
      signal: runOpts.signal,
      onProgress: reportProgress
    })
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await restoreSourceMetadata().catch(() => undefined)
    operation.fail(err)
    return { ok: false, error: 'Could not copy your data. Please try again.' }
  }

  if (!result.ok) {
    // Remove the whole staging dir we created (marker + anything copyAndVerify's rollback missed) so a
    // half-baked, marker-less folder can never later be mistaken for a committed data root. Safe: a
    // 'move' target only ever holds our copy plus at most a rebuildable runtime/, never user data.
    let stagingCleanupDegraded = false
    await rm(target, { recursive: true, force: true }).catch(() => {
      stagingCleanupDegraded = true
    })
    await restoreSourceMetadata().catch(() => undefined)
    if (result.cancelled) {
      operation.cancel({ cancelRequested: true, stagingCleanupDegraded })
    } else {
      operation.fail(new Error(result.error), { stagingCleanupDegraded })
    }
    return result
  }

  if (runOpts.signal.aborted) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await restoreSourceMetadata().catch(() => undefined)
    operation.cancel({ cancelRequested: true })
    return { ok: false, error: 'migration cancelled', cancelled: true }
  }

  operation.phase('verify-target')
  try {
    await validateProvenanceState(target)
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await restoreSourceMetadata().catch(() => undefined)
    operation.fail(error)
    return {
      ok: false,
      error: `Could not verify provenance data: ${toErrorMessage(error)}`
    }
  }

  let runtimeLockInventory: MigrationInventory | undefined
  if (preservedEnvs.length > 0) {
    try {
      runtimeLockInventory = await captureRuntimeLockInventory(target, preservedEnvs)
    } catch {
      runtimeLockInventory = undefined
    }
    if (!runtimeLockInventory) {
      runtimePreservationDegraded = true
      preservedEnvs = []
      await rm(join(target, RUNTIME_ENVS_LOCK_DIR), { recursive: true, force: true }).catch(
        () => undefined
      )
    }
  }

  // Record what was staged and promote the marker to 'verified' — the only state the commit gate accepts.
  let inventory
  try {
    inventory = await scanInventory(target, migrateDirs)
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await restoreSourceMetadata().catch(() => undefined)
    operation.fail(err)
    return { ok: false, error: 'Could not verify the copied data. Please run the move again.' }
  }
  if (runOpts.signal.aborted) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await restoreSourceMetadata().catch(() => undefined)
    operation.cancel({ cancelRequested: true })
    return { ok: false, error: 'migration cancelled', cancelled: true }
  }
  try {
    await restoreSourceMetadata()
    await restorePortableMetadata(target, sourceMetadata)
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    await restoreSourceMetadata().catch(() => undefined)
    operation.fail(err)
    return {
      ok: false,
      error: 'Could not restore copied data metadata. Please run the move again.'
    }
  }
  try {
    await writeMigrationMarker(target, {
      ...marker,
      status: 'verified',
      migratedDirs: migrateDirs,
      inventory,
      ...(runtimeLockInventory ? { runtimeLockInventory } : {})
    })
    runOpts.onVerified?.({ token: marker.token, target })
  } catch (err) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    operation.fail(err)
    return { ok: false, error: 'Could not finalize the copied data. Please run the move again.' }
  }
  operation.complete({
    preservedEnvironmentCount: preservedEnvs.length,
    runtimePreservationDegraded,
    fileCount: inventory.fileCount,
    totalBytes: inventory.totalBytes
  })
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
  const operation = startDiagnosticOperation(deps.logger ?? createLogger('storage:migration'), {
    operation: 'data-root-commit',
    fields: { mode: 'move', correlationId: deps.diagnosticCorrelationId }
  })
  const failResult = <T extends { ok: false; error: string }>(result: T): T => {
    operation.fail(new Error(result.error))
    return result
  }
  const target = dataRootForPicked(parent)

  // Commit gate: only ever promote a fully-staged copy whose marker matches THIS exact source→target
  // pair. This blocks committing a half-copied dir (crash mid-copy), a stale marker from an earlier
  // aborted move, or a copy staged against a different current root — any of which could delete the
  // wrong data on the delete step below.
  operation.phase('recheck-inventory')
  const marker = await readMigrationMarker(target)
  if (!marker || marker.status !== 'verified') {
    return failResult({ ok: false, error: 'No completed migration copy was found to commit.' })
  }
  if (!samePath(marker.source, deps.currentDataRoot)) {
    return failResult({
      ok: false,
      error: 'The staged copy does not match your current data location.'
    })
  }
  if (!samePath(marker.target, target)) {
    return failResult({ ok: false, error: 'The staged copy is for a different destination.' })
  }
  if (!deps.expectedToken || marker.token !== deps.expectedToken) {
    return failResult({
      ok: false,
      error: 'The staged copy is from a different migration attempt.'
    })
  }
  if (!marker.inventory) {
    return failResult({ ok: false, error: 'The staged copy has no verified inventory.' })
  }

  const migratedDirs = marker.migratedDirs ?? [...MIGRATED_DIRS]
  const currentDataPaths = MIGRATED_DIRS.filter((path) =>
    existsSync(join(deps.currentDataRoot, path))
  )
  if (currentDataPaths.some((path) => !migratedDirs.includes(path))) {
    return failResult({
      ok: false,
      error: 'The staged copy does not include all current data. Run the move again.'
    })
  }
  const requiredPaths = [
    RUNTIME_ENVIRONMENT_MANIFESTS_DIR,
    RUNTIME_REPAIR_REGISTRY_FILE,
    RUNTIME_PKGS_DIR
  ].filter((path) => existsSync(join(deps.currentDataRoot, path)))
  if (requiredPaths.some((path) => !migratedDirs.includes(path))) {
    return failResult({
      ok: false,
      error: 'The staged copy does not include all required provenance data. Run the move again.'
    })
  }
  let sourceMetadata
  try {
    sourceMetadata = await capturePortableMetadata(deps.currentDataRoot, migratedDirs)
  } catch (err) {
    operation.fail(err)
    return { ok: false, error: 'Could not recheck the copied data. Run the move again.' }
  }
  const sourceLinks = await validateMigrationSourceLinks(deps.currentDataRoot, migratedDirs)
  if (!sourceLinks.ok) {
    await restorePortableMetadata(deps.currentDataRoot, sourceMetadata).catch(() => undefined)
    return failResult(sourceLinks)
  }
  let inventories: [MigrationInventory, MigrationInventory]
  try {
    inventories = await Promise.all([
      scanInventory(deps.currentDataRoot, migratedDirs),
      scanInventory(target, migratedDirs)
    ])
  } catch (err) {
    operation.fail(err)
    return { ok: false, error: 'Could not recheck the copied data. Run the move again.' }
  }
  const [sourceInventory, targetInventory] = inventories
  if (
    !sameInventory(marker.inventory, sourceInventory) ||
    !sameInventory(marker.inventory, targetInventory)
  ) {
    return failResult({
      ok: false,
      error: 'The staged copy changed after verification. Run the move again.'
    })
  }

  const validateProvenanceState = deps.validateProvenanceState ?? defaultValidateProvenanceState
  operation.phase('validate-provenance')
  try {
    // Both roots are checked against the same fixed config-root SQLite authority. Run them in
    // sequence so two FULL WAL checkpoints cannot contend with each other and manufacture a busy
    // failure while the application is otherwise quiescent.
    await validateProvenanceState(deps.currentDataRoot)
    await validateProvenanceState(target)
  } catch (error) {
    operation.fail(error)
    return {
      ok: false,
      error: `Could not verify provenance data: ${toErrorMessage(error)}`
    }
  }

  // Persist the exact, already-validated cleanup capability before the pointer commit. A crash after
  // setDataRoot can then retry only this source→target operation; arbitrary paths from settings or a
  // renderer request are never treated as cleanup authority.
  const runtimePreserved = await hasVerifiedRuntimeLockBundle(target, marker.runtimeLockInventory)
  const dirsToDelete = runtimePreserved ? [...MIGRATED_DIRS, 'runtime'] : migratedDirs
  let stagedDirsToDelete = dirsToDelete
  if (deps.cleanupJournal) {
    try {
      stagedDirsToDelete = await deps.cleanupJournal.stage({
        token: marker.token,
        source: deps.currentDataRoot,
        target,
        dirs: dirsToDelete,
        createdAt: Date.now()
      })
    } catch (error) {
      operation.fail(error)
      return {
        ok: false,
        error: 'Could not prepare cleanup of the current data location. Please try again.'
      }
    }
  }

  try {
    // Staging snapshots the exact source entries that cleanup may later remove. Reapply portable
    // metadata afterward because that content scan necessarily reads the source tree.
    await restorePortableMetadata(deps.currentDataRoot, sourceMetadata)
    await restorePortableMetadata(target, sourceMetadata)
  } catch (error) {
    await deps.cleanupJournal?.clear(marker.token).catch(() => undefined)
    operation.fail(error)
    return { ok: false, error: 'Could not restore copied data metadata. Run the move again.' }
  }

  operation.phase('persist-pointer')
  try {
    await deps.setDataRoot(target)
  } catch (err) {
    await deps.cleanupJournal?.clear(marker.token).catch(() => undefined)
    // Leave the marker in place: the copy stays a discardable staging dir the user can retry or throw
    // away, exactly as before the failed switch.
    operation.fail(err, { switchoverFailed: true })
    return {
      ok: false,
      error: `Your data was copied to ${target}, but the app could not finish switching over. Please try again; your current data is untouched.`,
      switchoverFailed: true
    }
  }

  // The pointer is now committed. Keep both cleanup records until every old-root deletion succeeds;
  // they are the durable startup-retry authority and must not disappear on a partial cleanup.
  operation.phase('cleanup-source')
  let cleanupDegraded = false
  let cleanupDeferred = false
  const doDeleteSources = deps.deleteSources ?? deleteSources
  let cleanupFailureCount = 0
  if (deps.cleanupJournal) {
    try {
      cleanupDeferred = await deps.cleanupJournal.markCommitted(marker.token)
    } catch {
      // The pointer already committed. Leave the prepared intent in place so startup can prove the
      // live target and promote it before retrying; do not delete without the durable receipt.
      cleanupDegraded = true
      cleanupFailureCount = 1
    }
  }
  if (!cleanupDegraded && !cleanupDeferred) {
    try {
      const deleteResult = await doDeleteSources(deps.currentDataRoot, stagedDirsToDelete)
      cleanupFailureCount = deleteResult.failed.length
      if (cleanupFailureCount > 0) cleanupDegraded = true
    } catch {
      cleanupDegraded = true
      cleanupFailureCount = 1
    }
  }

  if (!cleanupDegraded && !cleanupDeferred && deps.cleanupRuntimeCache) {
    try {
      if (!(await deps.cleanupRuntimeCache(deps.currentDataRoot))) {
        cleanupDegraded = true
        cleanupFailureCount = 1
      }
    } catch {
      cleanupDegraded = true
      cleanupFailureCount = 1
    }
  }

  if (!cleanupDegraded && !cleanupDeferred) {
    try {
      await removeMigrationMarker(target)
      await deps.cleanupJournal?.clear(marker.token)
    } catch {
      // The old data is gone. A leftover marker or cleanup intent is safe and may be retried, so the
      // already-committed pointer still wins and the app relaunches normally.
      cleanupDegraded = true
    }
  }

  operation.complete({
    cleanupDegraded: cleanupDegraded || cleanupDeferred,
    cleanupFailureCount
  })
  return { ok: true, cleanupPending: cleanupDegraded || cleanupDeferred }
}

// Throws away an uncommitted staged copy at `<parent>/OpenScience` (the user chose "Keep current
// location" on the done stage). Refuses unless the target is genuinely a staging copy for the current
// root — never the live data location, and only when a marker confirms this source→target pair — so a
// misrouted parent can never rm the folder the app is actively using. A fresh process may also discard
// a 'copying' marker: no writer from that dead process remains, and an incomplete copy is never
// committable, so deletion is the only safe recovery.
export const discardStagedCopy = async (
  deps: { currentDataRoot: string; expectedToken: string; allowIncomplete?: boolean },
  parent: string
): Promise<{ ok: boolean; error?: string }> => {
  const target = dataRootForPicked(parent)

  let canonicalValidation: DataRootValidationResult
  try {
    canonicalValidation = await validateCanonicalTarget(
      deps.currentDataRoot,
      resolve(parent),
      target
    )
  } catch {
    return { ok: false, error: 'Refused: target path could not be verified.' }
  }
  if (!canonicalValidation.ok) {
    return { ok: false, error: 'Refused: target is the current data location.' }
  }

  const marker = await readMigrationMarker(target)
  if (
    !marker ||
    (marker.status !== 'verified' &&
      !(deps.allowIncomplete === true && marker.status === 'copying')) ||
    !samePath(marker.target, target) ||
    !samePath(marker.source, deps.currentDataRoot) ||
    !deps.expectedToken ||
    marker.token !== deps.expectedToken
  ) {
    // The owner blocks discard while its own copy is active. Source, target, and token still have to
    // match so a stale renderer call for another/earlier path is refused rather than obeyed.
    return { ok: false, error: 'Refused: not a completed, matching staged copy.' }
  }

  await rm(target, { recursive: true, force: true })
  return { ok: true }
}
