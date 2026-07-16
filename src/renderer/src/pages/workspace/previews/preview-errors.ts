// User-facing copy when a previewed file is gone from disk (deleted, or on a disconnected drive).
export const FILE_MISSING_MESSAGE =
  'This file is no longer available — it may have been moved or deleted.'

// User-facing copy when the file's path resolves outside the current storage root (e.g. it belongs
// to a data folder you've since migrated away from). The file may still exist elsewhere, but it is
// not reachable under the active data root — so this is NOT phrased as "deleted".
export const FILE_OUTSIDE_STORAGE_MESSAGE =
  "This file isn't in your current storage location — it may belong to a data folder you moved away from."

// Short tag for an unavailable file, shown on file cards/thumbnails so the state is perceivable at
// a glance. Both "missing" and "outside storage" share the same tag; only the opened view differs.
export const FILE_MISSING_TAG = 'Missing'

// True when a read failed because the underlying file is missing on disk. Electron IPC drops custom
// error props (e.g. `code`), so across the boundary the fs message ("ENOENT: no such file…") is the
// reliable signal; the `code` check still covers same-process callers and tests.
export const isMissingFileError = (error: unknown): boolean => {
  if (!error) return false
  if ((error as { code?: unknown }).code === 'ENOENT') return true
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|no such file|no longer (exists|available)/i.test(message)
}

// True when a read was rejected because the path resolves outside the managed storage root — the
// main process throws "… is outside … storage." for both uploads and artifacts. This is a sandbox
// boundary rejection (stale / cross-root path), distinct from a missing file.
export const isOutsideStorageError = (error: unknown): boolean => {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  return /outside\s+\S+\s+storage/i.test(message)
}

// True when a file can't be shown because it's unavailable under the current storage root — either
// missing (deleted/moved) or outside it. Used to badge tiles and to quiet expected read failures.
export const isUnavailableFileError = (error: unknown): boolean =>
  isMissingFileError(error) || isOutsideStorageError(error)
