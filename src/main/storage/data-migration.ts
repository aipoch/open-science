import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readlink, rm, rmdir, stat, symlink } from 'node:fs/promises'
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

// Thrown by listEntries when it meets an entry that is neither a regular file, a directory, nor a
// symbolic link (a fifo, socket, or device). Symlinks ARE supported now — they are copied faithfully
// as symlinks (see copyAndVerify), which the notebook runtime cache (runtime/pkgs, a conda symlink/
// hardlink farm — e.g. ca-certificates' cert.pem) depends on. Only true special files remain refused,
// since copying can't represent them and a later deleteSources would destroy them.
class NonRegularEntryError extends Error {
  constructor(public readonly relPath: string) {
    super(`unsupported entry (special file): ${relPath}`)
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

type ScanResult = {
  files: string[]
  directories: string[]
  symlinks: string[]
  present: boolean
}

// Recursively lists regular files, nested directories, and symbolic links under `root` (empty lists
// if `root` doesn't exist). Directories are tracked separately so empty nested folders survive the
// move; symlinks are recreated as links (never followed) so a conda cache's internal links survive.
const listEntries = async (root: string): Promise<ScanResult> => {
  const files: string[] = []
  const directories: string[] = []
  const symlinks: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(join(root, dir), { withFileTypes: true })
    for (const entry of entries) {
      const rel = join(dir, entry.name)
      // isDirectory/isFile/isSymbolicLink read the dirent WITHOUT following the link, so a symlink to
      // a directory is recorded as a symlink (recreated verbatim) rather than recursed into — no
      // escape out of the tree and no symlink-cycle risk.
      if (entry.isSymbolicLink()) symlinks.push(rel)
      else if (entry.isDirectory()) {
        directories.push(rel)
        await walk(rel)
      } else if (entry.isFile()) files.push(rel)
      else throw new NonRegularEntryError(rel)
    }
  }
  // A top-level source dir that is itself a symlink/special node must be rejected up front: exists()
  // (stat) and readdir would silently follow it, then deleteSources would remove the link and orphan
  // its target. Inner symlinks are handled (copied as links) inside walk(); other special files there
  // are still refused.
  let info
  try {
    info = await lstat(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { files, directories, symlinks, present: false }
    }
    throw err
  }
  if (!info.isDirectory()) throw new NonRegularEntryError(basename(root))
  await walk('.')
  return { files, directories, symlinks, present: true }
}

// Copies a single file, streaming, creating parent dirs as needed.
const copyFile = async (src: string, dest: string): Promise<void> => {
  await mkdir(dirname(dest), { recursive: true })
  await pipeline(createReadStream(src), createWriteStream(dest))
  // A stream copy creates dest at the default 0o644; re-apply the source mode so an executable
  // runtime/pkgs binary (Rscript, a .dylib) micromamba hard-links into a rebuilt env keeps +x.
  await chmod(dest, (await stat(src)).mode)
}

// Recreates a symbolic link at `dest` pointing at the SAME (verbatim) target as `src` — the link is
// copied, never followed, so a relative conda-cache link (e.g. ca-certificates' cert.pem) keeps
// working at the new root. Overwrites any pre-existing dest link from a retried copy.
const copySymlink = async (src: string, dest: string): Promise<void> => {
  const target = await readlink(src)
  await mkdir(dirname(dest), { recursive: true })
  await rm(dest, { force: true }).catch(() => undefined)
  await symlink(target, dest)
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
    const entriesByDir = new Map<string, ScanResult>()
    for (const dir of dirs) {
      const srcDir = join(from, dir)
      const entries = await listEntries(srcDir)
      entriesByDir.set(dir, entries)
      for (const rel of entries.files) {
        totalBytes += (await stat(join(srcDir, rel))).size
      }
    }
    onProgress({ phase: 'scan', copiedBytes, totalBytes })
    checkAbort()

    // Copy every existing from/<dir> into `to`, even if empty — an existing source
    // dir must be mirrored at `to`, not silently dropped.
    for (const dir of dirs) {
      const srcDir = join(from, dir)
      const entries =
        entriesByDir.get(dir) ??
        ({ files: [], directories: [], symlinks: [], present: false } as ScanResult)
      if (!entries.present) continue
      const destDir = join(to, dir)
      copiedInto.push(destDir)
      await mkdir(destDir, { recursive: true })
      for (const rel of entries.directories) await mkdir(join(destDir, rel), { recursive: true })
      for (const rel of entries.files) {
        checkAbort()
        await copyFile(join(srcDir, rel), join(destDir, rel))
        copiedBytes += (await stat(join(destDir, rel))).size
        onProgress({ phase: 'copy', copiedBytes, totalBytes, currentPath: join(dir, rel) })
        checkAbort()
      }
      // Symlinks after files so their parent dirs already exist; recreated as links (see copySymlink).
      for (const rel of entries.symlinks) {
        checkAbort()
        await copySymlink(join(srcDir, rel), join(destDir, rel))
        onProgress({ phase: 'copy', copiedBytes, totalBytes, currentPath: join(dir, rel) })
        checkAbort()
      }
    }

    // Verify every copied file exists at `to` with matching size.
    for (const dir of dirs) {
      const entries =
        entriesByDir.get(dir) ??
        ({ files: [], directories: [], symlinks: [], present: false } as ScanResult)
      for (const rel of entries.directories) {
        checkAbort()
        const destStat = await stat(join(to, dir, rel)).catch(() => undefined)
        if (!destStat?.isDirectory()) throw new Error(`verification failed for ${join(dir, rel)}`)
      }
      for (const rel of entries.files) {
        checkAbort()
        const srcSize = (await stat(join(from, dir, rel))).size
        const destStat = await stat(join(to, dir, rel)).catch(() => undefined)
        if (!destStat || destStat.size !== srcSize) {
          throw new Error(`verification failed for ${join(dir, rel)}`)
        }
        onProgress({ phase: 'verify', copiedBytes, totalBytes, currentPath: join(dir, rel) })
      }
      // A symlink is verified by its presence AS a link (lstat, not stat, so a dangling target — e.g.
      // a relative conda link resolved before its sibling files land — is not a false failure).
      for (const rel of entries.symlinks) {
        checkAbort()
        const destStat = await lstat(join(to, dir, rel)).catch(() => undefined)
        if (!destStat?.isSymbolicLink())
          throw new Error(`verification failed for ${join(dir, rel)}`)
        onProgress({ phase: 'verify', copiedBytes, totalBytes, currentPath: join(dir, rel) })
      }
    }
    checkAbort()
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
        ? `Can't move your data: "${err.relPath}" is a special file (device, socket, or pipe) that can't be copied. Remove it, then try again.`
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
