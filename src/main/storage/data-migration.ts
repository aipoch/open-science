import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export type MigrationPhase = 'scan' | 'copy' | 'verify' | 'delete'
export type MigrationProgress = {
  phase: MigrationPhase
  copiedBytes: number
  totalBytes: number
  currentPath?: string
}
export type MigrationResult = { ok: true } | { ok: false; error: string; cancelled?: boolean }

type MigrateOpts = {
  from: string
  to: string
  dirs: string[]
  signal: AbortSignal
  onProgress: (p: MigrationProgress) => void
  // Accepted for interface compatibility (test hook to "force" the byte-copy branch);
  // this implementation always byte-copies, so it is a no-op. See report for rationale:
  // rename is skipped entirely to keep multi-dir rollback simple and safe.
  forceCopy?: boolean
}

// Thrown internally to unwind to the single catch site; never escapes copyAndVerify.
class AbortedError extends Error {}

// Thrown by listFiles when it meets an entry that is neither a regular file nor a directory
// (symlink, fifo, socket, device). Copying can't represent these safely and a later deleteSources
// would destroy them, so the migration refuses rather than lose data.
class NonRegularEntryError extends Error {
  constructor(public readonly relPath: string) {
    super(`unsupported entry (symlink or special file): ${relPath}`)
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// Recursively lists files (relative paths) under `root`, or [] if `root` doesn't exist.
const listFiles = async (root: string): Promise<string[]> => {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(join(root, dir), { withFileTypes: true })
    for (const entry of entries) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) await walk(rel)
      else if (entry.isFile()) out.push(rel)
      else throw new NonRegularEntryError(rel)
    }
  }
  // A top-level source dir that is itself a symlink/special node must be rejected up front: exists()
  // (stat) and readdir would silently follow it, then deleteSources would remove the link and orphan
  // its target. Inner symlinks/special files are caught inside walk().
  let info
  try {
    info = await lstat(root)
  } catch {
    return out // missing source dir -> nothing to copy
  }
  if (!info.isDirectory()) throw new NonRegularEntryError(basename(root))
  await walk('.')
  return out
}

// Copies a single file, streaming, creating parent dirs as needed.
const copyFile = async (src: string, dest: string): Promise<void> => {
  await mkdir(dirname(dest), { recursive: true })
  await pipeline(createReadStream(src), createWriteStream(dest))
}

// Scans, copies, and verifies `from/<dir>` into `to/<dir>` for every dir in `dirs`. `from` is
// NEVER mutated by this function — the caller decides when (and whether) to delete sources, so
// the commit point (persisting the new data root) can happen between verify and delete. On any
// failure or abort, the partial `to` tree is cleaned up and `from` is left fully intact.
export const copyAndVerify = async (opts: MigrateOpts): Promise<MigrationResult> => {
  const { from, to, dirs, signal, onProgress } = opts
  const copiedInto: string[] = [] // `to/<dir>` paths written to, for rollback cleanup on failure

  const checkAbort = (): void => {
    if (signal.aborted) throw new AbortedError('migration cancelled')
  }

  let totalBytes = 0
  let copiedBytes = 0

  try {
    checkAbort()
    const filesByDir = new Map<string, string[]>()
    for (const dir of dirs) {
      const srcDir = join(from, dir)
      const files = await listFiles(srcDir)
      filesByDir.set(dir, files)
      for (const rel of files) {
        totalBytes += (await stat(join(srcDir, rel))).size
      }
    }
    onProgress({ phase: 'scan', copiedBytes, totalBytes })
    checkAbort()

    // Copy every existing from/<dir> into `to`, even if empty — an existing source
    // dir must be mirrored at `to`, not silently dropped.
    for (const dir of dirs) {
      const srcDir = join(from, dir)
      if (!(await exists(srcDir))) continue
      const files = filesByDir.get(dir) ?? []
      const destDir = join(to, dir)
      copiedInto.push(destDir)
      if (files.length === 0) {
        await mkdir(destDir, { recursive: true })
      }
      for (const rel of files) {
        checkAbort()
        await copyFile(join(srcDir, rel), join(destDir, rel))
        copiedBytes += (await stat(join(destDir, rel))).size
        onProgress({ phase: 'copy', copiedBytes, totalBytes, currentPath: join(dir, rel) })
        checkAbort()
      }
    }

    // Verify every copied file exists at `to` with matching size.
    for (const dir of dirs) {
      const files = filesByDir.get(dir) ?? []
      for (const rel of files) {
        checkAbort()
        const srcSize = (await stat(join(from, dir, rel))).size
        const destStat = await stat(join(to, dir, rel)).catch(() => undefined)
        if (!destStat || destStat.size !== srcSize) {
          throw new Error(`verification failed for ${join(dir, rel)}`)
        }
        onProgress({ phase: 'verify', copiedBytes, totalBytes, currentPath: join(dir, rel) })
      }
    }
  } catch (err) {
    // Rollback: remove whatever was written under `to`; `from` was never touched.
    for (const destDir of copiedInto) {
      if (await exists(destDir)) {
        await rm(destDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    // Also drop the now-empty `to` shell (e.g. `<parent>/OpenScience`) so a cancelled move leaves no
    // trace. rmdir only removes it if empty, so any unrelated pre-existing content is left intact.
    await rmdir(to).catch(() => undefined)
    const cancelled = err instanceof AbortedError || signal.aborted
    const error =
      err instanceof NonRegularEntryError
        ? `Can't move your data: "${err.relPath}" is a symbolic link or special file. Remove or replace it with a regular copy, then try again.`
        : err instanceof Error
          ? err.message
          : String(err)
    return {
      ok: false,
      error,
      ...(cancelled ? { cancelled: true } : {})
    }
  }

  return { ok: true }
}

// Best-effort recursive delete of each existing `from/<dir>`. Called only after the caller has
// already committed the switch-over (e.g. persisted the new data root), so `to` is now the
// canonical copy — a per-dir delete failure here is a harmless leftover at the now-inactive old
// root, not a data-loss risk. Never rejects.
export const deleteSources = async (
  from: string,
  dirs: string[],
  onProgress?: (p: MigrationProgress) => void
): Promise<{ deleted: string[]; failed: { dir: string; error: string }[] }> => {
  const deleted: string[] = []
  const failed: { dir: string; error: string }[] = []

  for (const dir of dirs) {
    const srcDir = join(from, dir)
    if (!(await exists(srcDir))) continue
    try {
      await rm(srcDir, { recursive: true, force: true })
      deleted.push(dir)
      onProgress?.({ phase: 'delete', copiedBytes: 0, totalBytes: 0, currentPath: dir })
    } catch (err) {
      failed.push({ dir, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { deleted, failed }
}
