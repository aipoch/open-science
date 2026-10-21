import { link, lstat, mkdir, rm } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionPackageInventoryEntry } from '../../shared/session-package'
import { resolveStorageKey } from '../artifacts/provenance-storage'
import { copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
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
        const digest = await digestFileWithinBudget(source, entry.sizeBytes, signal)
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
