import { link, lstat, mkdir, rm } from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionPackageInventoryEntry } from '../../shared/session-package'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
import { assertWithinResourceBudget } from '../resource-budget'
import { packageCapacityChecker } from './capacity'

// Only immutable execution blobs may share an inode. Working files and metadata are rewritten.
const blobIdentity = (entry: SessionPackageInventoryEntry): string | undefined => {
  const match =
    /^(?:execution-file-evidence\/([^/]+)\/(?:[^/]+\/(?:frames\/[^/]+\/)?activity-[^/]+\/)?|(?:notebook-file-evidence|file-evidence)\/([^/]+)\/(?:[^/]+\/(?:frames\/[^/]+\/)?run-[^/]+\/)?)blobs\/sha256-([a-f0-9]{64})$/.exec(
      entry.storageKey ?? ''
    )
  return entry.kind === 'file' && match && match[3] === entry.checksum
    ? `${match[1] ?? match[2]}:${entry.sizeBytes}:${entry.checksum}`
    : undefined
}

const sameFile = (actual: Stats, expected: Stats): boolean =>
  actual.isFile() &&
  actual.dev === expected.dev &&
  actual.ino === expected.ino &&
  actual.size === expected.size &&
  actual.mtimeMs === expected.mtimeMs

// One instance per private materialization root; sharing never reaches into its source archive.
export const createPackageMaterializer = async (
  sourceDirectory: string,
  destinationRoot: string,
  entries: readonly SessionPackageInventoryEntry[],
  signal?: AbortSignal,
  isolatedStorageKeys: readonly string[] = []
): Promise<
  (
    entry: SessionPackageInventoryEntry,
    targetKey?: string,
    onProgress?: (bytes: number) => void
  ) => Promise<void>
> => {
  // Native records may bind metadata to noncanonical blob-shaped paths; import rewrites them.
  const isolated = new Set(isolatedStorageKeys)
  const identityOf = (entry: SessionPackageInventoryEntry): string | undefined =>
    isolated.has(entry.storageKey ?? '') ? undefined : blobIdentity(entry)
  const groups = new Set<string>()
  let allocatedBudget = 0
  for (const entry of entries) {
    const identity = identityOf(entry)
    if (!identity || !groups.has(identity)) allocatedBudget += entry.sizeBytes
    if (identity) groups.add(identity)
  }
  signal?.throwIfAborted()
  await mkdir(destinationRoot, { recursive: true })
  const checkCapacity = await packageCapacityChecker(destinationRoot)
  checkCapacity(allocatedBudget)
  const verifyContent = createPackageContentVerifier()
  const copies = new Map<string, { path: string; stats: Stats }>()
  return async (entry, targetKey = entry.storageKey!, onProgress) => {
    signal?.throwIfAborted()
    const target = resolveStorageKey(destinationRoot, targetKey)
    const source = join(sourceDirectory, entry.path)
    const identity = identityOf(entry)
    const existing = identity ? copies.get(identity) : undefined
    await mkdir(dirname(target), { recursive: true })
    let created = false
    try {
      if (existing) {
        // Legacy packages may have separate source objects advertising the same digest.
        const digest = await verifyContent(source, entry.sizeBytes, signal)
        if (digest.checksum !== entry.checksum || digest.sizeBytes !== entry.sizeBytes)
          throw new Error('Session package content checksum mismatch.')
        if (!sameFile(await lstat(existing.path), existing.stats))
          throw new Error('Session package materialized content changed.')
        signal?.throwIfAborted()
        try {
          await link(existing.path, target)
          created = true
        } catch (error) {
          if (
            !['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(
              (error as NodeJS.ErrnoException).code ?? ''
            )
          )
            throw error
          // The initial budget assumes links. Reserve every fallback copy before writing it.
          allocatedBudget += entry.sizeBytes
          checkCapacity(allocatedBudget)
        }
        if (created) {
          if (!sameFile(await lstat(target), existing.stats))
            throw new Error('Session package materialized content changed.')
          signal?.throwIfAborted()
          onProgress?.(entry.sizeBytes)
          signal?.throwIfAborted()
          return
        }
      }
      const digest = await copyFileWithinBudget(source, target, entry.sizeBytes, signal, onProgress)
      created = true
      if (digest.checksum !== entry.checksum || digest.sizeBytes !== entry.sizeBytes)
        throw new Error('Session package content checksum mismatch.')
      signal?.throwIfAborted()
      if (identity) copies.set(identity, { path: target, stats: await lstat(target) })
    } catch (error) {
      if (created) await rm(target, { force: true })
      throw error
    }
  }
}

const observation = (stat: BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`

// On non-Windows platforms, reuse reads only within one validation pass, including hardlink
// aliases. A changed observation requires a fresh digest; later passes always read again.
export const createPackageContentVerifier = (): typeof digestFileWithinBudget => {
  const verified = new Map<string, Awaited<ReturnType<typeof digestFileWithinBudget>>>()
  return async (path, maxBytes, signal) => {
    signal?.throwIfAborted()
    const before = await lstat(path, { bigint: true })
    signal?.throwIfAborted()
    if (!before.isFile()) throw new Error('Session package content is not a regular file.')
    assertWithinResourceBudget('file', Number(before.size), maxBytes)
    const key = observation(before)
    // Windows can report the same identity, size and timestamps after a same-size write.
    // Without a usable inode identity, other filesystems cannot establish shared bytes either.
    const reusable = process.platform !== 'win32' && before.ino > 0n
    const cached = reusable ? verified.get(key) : undefined
    if (cached) return cached
    const digest = await digestFileWithinBudget(path, maxBytes, signal)
    const after = await lstat(path, { bigint: true })
    signal?.throwIfAborted()
    if (!after.isFile() || observation(after) !== key || BigInt(digest.sizeBytes) !== after.size)
      throw new Error('Session package content changed during validation.')
    if (reusable) verified.set(key, digest)
    return digest
  }
}
