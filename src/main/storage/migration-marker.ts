import { existsSync, type Dirent } from 'node:fs'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

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
  inventory?: { dirs: string[]; fileCount: number; totalBytes: number }
}

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
      typeof parsed.token !== 'string' ||
      typeof parsed.source !== 'string' ||
      typeof parsed.target !== 'string'
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

// Recursively counts files and bytes under each of `dirs` beneath `root`, returning the subset of dirs
// that actually exist. Missing dirs and stat failures are skipped rather than thrown, so a partial
// tree still yields a usable tally. Kept here (node-only) so migration-service can record what it
// staged without importing the copy engine in data-migration.ts.
export const scanInventory = async (
  root: string,
  dirs: string[]
): Promise<{ dirs: string[]; fileCount: number; totalBytes: number }> => {
  const presentDirs: string[] = []
  let fileCount = 0
  let totalBytes = 0

  for (const dir of dirs) {
    let present = false
    const walk = async (current: string): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      present = true
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          fileCount += 1
          try {
            totalBytes += (await stat(full)).size
          } catch {
            // A file that vanished mid-scan contributes nothing rather than aborting the tally.
          }
        }
      }
    }
    await walk(join(root, dir))
    if (present) presentDirs.push(dir)
  }

  return { dirs: presentDirs, fileCount, totalBytes }
}
