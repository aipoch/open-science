import { createReadStream, existsSync, type Dirent } from 'node:fs'
import { lstat, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'

// Sentinel file dropped INTO a staging data root while a migration copy is in flight. Its presence
// means "this OpenScience folder is a half-baked/uncommitted staging copy, not the live data root",
// which both computeDefaultDataRoot (ignore it when picking the default) and the commit/discard gates
// key off. Kept in a standalone module that imports ONLY node builtins so storage-root's pure getter
// can call hasPendingMigrationMarker without pulling in electron or migration-service (import cycle).
export const MIGRATION_MARKER_FILENAME = '.open-science-migration.json'

export type MigrationMarker = {
  version: 1
  token: string
  source: string
  target: string
  createdAt: number
  status: 'copying' | 'verified'
  migratedDirs?: string[]
  inventory?: { dirs: string[]; fileCount: number; totalBytes: number; digest: string }
}

const isInventory = (value: unknown): value is NonNullable<MigrationMarker['inventory']> => {
  if (!value || typeof value !== 'object') return false
  const inventory = value as Record<string, unknown>
  return (
    Array.isArray(inventory.dirs) &&
    inventory.dirs.every((dir) => typeof dir === 'string') &&
    Number.isSafeInteger(inventory.fileCount) &&
    (inventory.fileCount as number) >= 0 &&
    Number.isSafeInteger(inventory.totalBytes) &&
    (inventory.totalBytes as number) >= 0 &&
    typeof inventory.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(inventory.digest)
  )
}

const isSafeMigrationPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('/') &&
  !/^[A-Za-z]:[\\/]/.test(value) &&
  value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')

// Sync existence check so storage-root's synchronous computeDefaultDataRoot can consult it directly.
export const hasPendingMigrationMarker = (root: string): boolean =>
  existsSync(join(root, MIGRATION_MARKER_FILENAME))

// Reads and validates the marker, returning null on a missing, unreadable, corrupt, or structurally
// incomplete file (missing token/source/target) so callers can treat "no trustworthy marker" uniformly.
export const readMigrationMarker = async (root: string): Promise<MigrationMarker | null> => {
  try {
    const raw = await readFile(join(root, MIGRATION_MARKER_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as Partial<MigrationMarker>
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.token !== 'string' ||
      typeof parsed.source !== 'string' ||
      typeof parsed.target !== 'string' ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isFinite(parsed.createdAt) ||
      (parsed.status !== 'copying' && parsed.status !== 'verified') ||
      (parsed.migratedDirs !== undefined &&
        (!Array.isArray(parsed.migratedDirs) ||
          parsed.migratedDirs.some((dir) => !isSafeMigrationPath(dir)) ||
          new Set(parsed.migratedDirs).size !== parsed.migratedDirs.length)) ||
      (parsed.inventory !== undefined && !isInventory(parsed.inventory))
    ) {
      return null
    }
    return parsed as MigrationMarker
  } catch {
    return null
  }
}

// Writes the marker as pretty-printed JSON (overwrites any prior marker).
export const writeMigrationMarker = async (
  root: string,
  marker: MigrationMarker
): Promise<void> => {
  await writeFile(join(root, MIGRATION_MARKER_FILENAME), JSON.stringify(marker, null, 2))
}

// Removes the marker; idempotent (force:true swallows ENOENT), so committing a marker-free root is fine.
export const removeMigrationMarker = async (root: string): Promise<void> => {
  await rm(join(root, MIGRATION_MARKER_FILENAME), { force: true })
}

// Fresh migration token, used to tie a staged copy to the source/target pair that created it.
export const newToken = (): string => randomUUID()

// Recursively inventories regular files and symbolic links under each of `dirs` beneath `root`,
// returning the subset of dirs that actually exist. Links are hashed as links (path + verbatim
// target) and never followed, matching data-migration's copy contract for Conda package caches. A
// missing top-level dir is valid, but errors or unsupported entries inside a present dir abort the
// scan so commit can never accept a partial tally as proof of equivalence.
export const scanInventory = async (
  root: string,
  dirs: string[]
): Promise<{ dirs: string[]; fileCount: number; totalBytes: number; digest: string }> => {
  const presentDirs: string[] = []
  let fileCount = 0
  let totalBytes = 0
  const inventoryHash = createHash('sha256')

  for (const dir of dirs) {
    const topLevel = join(root, dir)
    let topLevelInfo
    try {
      topLevelInfo = await lstat(topLevel)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (topLevelInfo.isFile()) {
      const fileHash = createHash('sha256')
      for await (const chunk of createReadStream(topLevel)) fileHash.update(chunk as Buffer)
      presentDirs.push(dir)
      fileCount += 1
      totalBytes += topLevelInfo.size
      inventoryHash.update(JSON.stringify(['file', dir, topLevelInfo.size, fileHash.digest('hex')]))
      continue
    }
    if (!topLevelInfo.isDirectory()) {
      throw new Error(`Unsupported inventory entry: ${dir}`)
    }
    presentDirs.push(dir)
    inventoryHash.update(JSON.stringify(['dir', dir]))

    const walk = async (current: string): Promise<void> => {
      const entries: Dirent[] = (await readdir(current, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name)
      )
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          inventoryHash.update(JSON.stringify(['nested-dir', relative(root, full)]))
          await walk(full)
        } else if (entry.isFile()) {
          const info = await stat(full)
          const fileHash = createHash('sha256')
          for await (const chunk of createReadStream(full)) fileHash.update(chunk as Buffer)
          fileCount += 1
          totalBytes += info.size
          inventoryHash.update(
            JSON.stringify(['file', relative(root, full), info.size, fileHash.digest('hex')])
          )
        } else if (entry.isSymbolicLink()) {
          const target = await readlink(full)
          const targetBytes = Buffer.byteLength(target)
          fileCount += 1
          totalBytes += targetBytes
          inventoryHash.update(
            JSON.stringify(['symlink', relative(root, full), targetBytes, target])
          )
        } else {
          throw new Error(`Unsupported inventory entry: ${full}`)
        }
      }
    }
    await walk(topLevel)
  }

  return { dirs: presentDirs, fileCount, totalBytes, digest: inventoryHash.digest('hex') }
}
