import { createReadStream, createWriteStream, type Stats } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { MigrationProgress, MigrationResult } from '../../shared/storage'

type MigrateOpts = {
  from: string
  to: string
  dirs: string[]
  signal: AbortSignal
  onProgress: (p: MigrationProgress) => void
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

class AbsoluteInternalSymlinkError extends Error {
  constructor(public readonly relPath: string) {
    super(`absolute symbolic link into the current data folder: ${relPath}`)
  }
}

const isPathInsideOrEqual = (parent: string, candidate: string): boolean => {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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
  files: { relPath: string; stats: Stats }[]
  directories: { relPath: string; stats: Stats }[]
  symlinks: string[]
  present: boolean
  rootFile: boolean
}

type PortableMetadataEntry = {
  relativePath: string
  mode: number
  atime: Date
  mtime: Date
}

export type PortableMetadataSnapshot = {
  files: PortableMetadataEntry[]
  directories: PortableMetadataEntry[]
}

// Recursively lists regular files, nested directories, and symbolic links under `root` (empty lists
// if `root` doesn't exist). Directories are tracked separately so empty nested folders survive the
// move; symlinks are recreated as links (never followed) so a conda cache's internal links survive.
const listEntries = async (root: string): Promise<ScanResult> => {
  const files: ScanResult['files'] = []
  const directories: ScanResult['directories'] = []
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
        directories.push({ relPath: rel, stats: await stat(join(root, rel)) })
        await walk(rel)
      } else if (entry.isFile()) {
        files.push({ relPath: rel, stats: await stat(join(root, rel)) })
      } else throw new NonRegularEntryError(rel)
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
      return { files, directories, symlinks, present: false, rootFile: false }
    }
    throw err
  }
  if (info.isFile()) {
    files.push({ relPath: '', stats: info })
    return { files, directories, symlinks, present: true, rootFile: true }
  }
  if (!info.isDirectory()) throw new NonRegularEntryError(basename(root))
  directories.push({ relPath: '', stats: info })
  await walk('.')
  return { files, directories, symlinks, present: true, rootFile: false }
}

const metadataSnapshotFromEntries = (
  dirs: string[],
  entriesByDir: ReadonlyMap<string, ScanResult>
): PortableMetadataSnapshot => {
  const snapshot: PortableMetadataSnapshot = { files: [], directories: [] }
  for (const dir of dirs) {
    const entries = entriesByDir.get(dir)
    if (!entries?.present) continue
    for (const file of entries.files) {
      snapshot.files.push({
        relativePath: join(dir, file.relPath),
        mode: file.stats.mode,
        atime: file.stats.atime,
        mtime: file.stats.mtime
      })
    }
    for (const directory of entries.directories) {
      snapshot.directories.push({
        relativePath: join(dir, directory.relPath),
        mode: directory.stats.mode,
        atime: directory.stats.atime,
        mtime: directory.stats.mtime
      })
    }
  }
  return snapshot
}

export const capturePortableMetadata = async (
  root: string,
  dirs: string[]
): Promise<PortableMetadataSnapshot> => {
  const entriesByDir = new Map<string, ScanResult>()
  for (const dir of dirs) entriesByDir.set(dir, await listEntries(join(root, dir)))
  return metadataSnapshotFromEntries(dirs, entriesByDir)
}

const restoreTimestamps = async (
  root: string,
  snapshot: PortableMetadataSnapshot
): Promise<void> => {
  for (const file of snapshot.files) {
    await utimes(join(root, file.relativePath), file.atime, file.mtime)
  }
  for (const directory of [...snapshot.directories].reverse()) {
    await utimes(join(root, directory.relativePath), directory.atime, directory.mtime)
  }
}

export const restorePortableMetadata = async (
  root: string,
  snapshot: PortableMetadataSnapshot
): Promise<void> => {
  for (const file of snapshot.files) {
    const destination = join(root, file.relativePath)
    await chmod(destination, file.mode)
    await utimes(destination, file.atime, file.mtime)
  }
  for (const directory of [...snapshot.directories].reverse()) {
    const destination = join(root, directory.relativePath)
    await chmod(destination, directory.mode)
    await utimes(destination, directory.atime, directory.mtime)
  }
}

// Copies a single file, streaming, creating parent dirs as needed.
const copyFile = async (src: string, dest: string): Promise<void> => {
  await mkdir(dirname(dest), { recursive: true })
  await pipeline(createReadStream(src), createWriteStream(dest))
}

// Only files with more than one link participate in hard-link grouping. Some filesystems report an
// unusable zero inode; treating those as independent avoids accidentally linking unrelated files.
const hardLinkIdentity = (stats: Stats): string | undefined =>
  stats.nlink > 1 && stats.ino !== 0 ? `${stats.dev}:${stats.ino}` : undefined

const destinationAvailableBytes = async (path: string): Promise<number> => {
  const stats = await statfs(path)
  return stats.bavail * stats.bsize
}

const HARD_LINK_UNSUPPORTED_CODES = new Set([
  'EACCES',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV'
])

const destinationSupportsHardLinks = async (path: string): Promise<boolean> => {
  const probe = `.open-science-hard-link-test-${randomUUID()}`
  const source = join(path, `${probe}.source`)
  const target = join(path, `${probe}.target`)
  try {
    await writeFile(source, '', { flag: 'wx' })
    await link(source, target)
    return true
  } catch (error) {
    if (HARD_LINK_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException)?.code ?? '')) return false
    throw error
  } finally {
    await rm(target, { force: true })
    await rm(source, { force: true })
  }
}

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
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

const migrationSourceError = (error: unknown): string =>
  error instanceof NonRegularEntryError
    ? `Can't move your data: "${error.relPath}" is a special file (device, socket, or pipe) that can't be copied. Remove it, then try again.`
    : error instanceof AbsoluteInternalSymlinkError
      ? `Can't move your data: "${error.relPath}" is an absolute symbolic link into the current data folder. Replace it with a relative link or remove it, then try again.`
      : error instanceof Error
        ? error.message
        : String(error)

export const validateMigrationSourceLinks = async (
  from: string,
  dirs: readonly string[]
): Promise<MigrationResult> => {
  try {
    let canonicalSourceRoot: string
    try {
      canonicalSourceRoot = resolve(await realpath(from))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true }
      throw error
    }
    for (const dir of dirs) {
      const srcDir = join(from, dir)
      const entries = await listEntries(srcDir)
      for (const rel of entries.symlinks) {
        const sourceLink = join(srcDir, rel)
        const linkTarget = await readlink(sourceLink)
        if (!isAbsolute(linkTarget)) continue
        const canonicalTarget = await realpath(sourceLink).catch(() => resolve(linkTarget))
        if (isPathInsideOrEqual(canonicalSourceRoot, resolve(canonicalTarget))) {
          throw new AbsoluteInternalSymlinkError(join(dir, rel))
        }
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: migrationSourceError(error) }
  }
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
    const sourceHardLinks = new Set<string>()
    let hasRepeatedHardLink = false
    for (const dir of dirs) {
      const srcDir = join(from, dir)
      const entries = await listEntries(srcDir)
      entriesByDir.set(dir, entries)
      for (const file of entries.files) {
        const identity = hardLinkIdentity(file.stats)
        if (!identity) continue
        if (sourceHardLinks.has(identity)) hasRepeatedHardLink = true
        else sourceHardLinks.add(identity)
      }
    }
    const sourceMetadata = metadataSnapshotFromEntries(dirs, entriesByDir)
    const sourceValidation = await validateMigrationSourceLinks(from, dirs)
    if (!sourceValidation.ok) {
      await restorePortableMetadata(from, sourceMetadata).catch(() => undefined)
      return sourceValidation
    }
    checkAbort()
    const preserveHardLinks = !hasRepeatedHardLink || (await destinationSupportsHardLinks(to))
    const sizedHardLinks = new Set<string>()
    for (const entries of entriesByDir.values()) {
      for (const file of entries.files) {
        const identity = preserveHardLinks ? hardLinkIdentity(file.stats) : undefined
        if (identity && sizedHardLinks.has(identity)) continue
        if (identity) sizedHardLinks.add(identity)
        totalBytes += file.stats.size
      }
    }
    onProgress({ phase: 'scan', copiedBytes, totalBytes })
    checkAbort()
    if ((await destinationAvailableBytes(to)) < totalBytes) {
      throw new Error("Can't move your data: the new location does not have enough free space.")
    }

    // Copy every existing from/<dir> into `to`, even if empty — an existing source
    // dir must be mirrored at `to`, not silently dropped.
    const copiedHardLinks = new Map<string, string>()
    for (const dir of dirs) {
      const srcDir = join(from, dir)
      const entries =
        entriesByDir.get(dir) ??
        ({
          files: [],
          directories: [],
          symlinks: [],
          present: false,
          rootFile: false
        } as ScanResult)
      if (!entries.present) continue
      const destDir = join(to, dir)
      copiedInto.push(destDir)
      if (!entries.rootFile) {
        await mkdir(destDir, { recursive: true })
        for (const directory of entries.directories) {
          await mkdir(join(destDir, directory.relPath), { recursive: true })
        }
      }
      for (const file of entries.files) {
        checkAbort()
        const destination = join(destDir, file.relPath)
        const identity = preserveHardLinks ? hardLinkIdentity(file.stats) : undefined
        const existingDestination = identity ? copiedHardLinks.get(identity) : undefined
        if (existingDestination) {
          await mkdir(dirname(destination), { recursive: true })
          await link(existingDestination, destination)
        } else {
          await copyFile(join(srcDir, file.relPath), destination)
          copiedBytes += file.stats.size
          if (identity) copiedHardLinks.set(identity, destination)
        }
        onProgress({
          phase: 'copy',
          copiedBytes,
          totalBytes,
          currentPath: join(dir, file.relPath)
        })
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

    // Verify bytes, not only length. Same-size corruption is otherwise invisible and could be
    // committed as the new authoritative root even though the inventory shape still looks valid.
    for (const dir of dirs) {
      const entries =
        entriesByDir.get(dir) ??
        ({
          files: [],
          directories: [],
          symlinks: [],
          present: false,
          rootFile: false
        } as ScanResult)
      for (const directory of entries.directories) {
        checkAbort()
        const destStat = await stat(join(to, dir, directory.relPath)).catch(() => undefined)
        if (!destStat?.isDirectory()) {
          throw new Error(`verification failed for ${join(dir, directory.relPath)}`)
        }
      }
      for (const file of entries.files) {
        checkAbort()
        const destStat = await stat(join(to, dir, file.relPath)).catch(() => undefined)
        if (!destStat || destStat.size !== file.stats.size) {
          throw new Error(`verification failed for ${join(dir, file.relPath)}`)
        }
        const [sourceChecksum, destinationChecksum] = await Promise.all([
          hashFile(join(from, dir, file.relPath)),
          hashFile(join(to, dir, file.relPath))
        ])
        if (sourceChecksum !== destinationChecksum) {
          throw new Error(`verification failed for ${join(dir, file.relPath)}: checksum mismatch`)
        }
        onProgress({
          phase: 'verify',
          copiedBytes,
          totalBytes,
          currentPath: join(dir, file.relPath)
        })
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

    // Copying and hash verification read the source and destination. Restore the source timestamps so
    // the commit phase can take a faithful in-memory snapshot, then restore the staged copy. The
    // service reapplies that snapshot after its own downstream verification reads.
    checkAbort()
    await restoreTimestamps(from, sourceMetadata)
    await restorePortableMetadata(to, sourceMetadata)
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
    const error = migrationSourceError(err)
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
