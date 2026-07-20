// Shared types and pure utility functions for the remote SSH file-browser feature (compute-file-preview).
// These are the stable contracts consumed by the main-process ComputeService, IPC handlers, and renderer.
// No I/O: all functions are pure and directly unit-testable.

import type { ComputeBookmarkStore } from './settings'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// A single entry returned by sftp readdir (files and directories).
export type RemoteDirEntry = {
  name: string
  isDirectory: boolean
  // File size in bytes; directories report 0.
  size: number
  // Modification time in milliseconds (sftp native seconds × 1000).
  mtimeMs: number
}

// Result of a listDir call: the entries plus navigation context.
export type DirListing = {
  // Sorted: directories first, then files, each group alphabetical.
  entries: RemoteDirEntry[]
  // True when the directory had more than 5 000 entries and was truncated.
  truncated: boolean
  // Absolute paths of well-known roots, inlined for the Go-to dropdown.
  roots: { scratch?: string; home: string }
  // Server-side realpath of the requested path (resolves .. and symlinks).
  resolvedPath: string
}

// Where a downloaded file should land.
export type DownloadDest =
  | { kind: 'artifact'; projectId: string } // Add to project → project artifact
  | { kind: 'os-downloads' } // Download button → OS Downloads folder
  | { kind: 'session-cache' } // Python host.compute.download() → session cache

// Result returned by ComputeService.download().
export type LocalFile = {
  // Absolute local path of the downloaded file.
  path: string
  // Display name (basename of the remote path).
  name: string
  // File size in bytes.
  size: number
  // Inferred MIME type from extension, or 'application/octet-stream' when unknown.
  mimeType: string
  // For artifact dest: the saved ArtifactFile id; undefined otherwise.
  artifactId?: string
}

// Structured error returned by ComputeService on any remote-fs failure.
export type RemoteFsError = {
  detail: string
  remoteKind: RemoteKind
}

// Taxonomy of remote error kinds, aligned with the reference product (§7.4 of design.md).
export type RemoteKind =
  | 'not_found' // ENOENT — path does not exist
  | 'not_a_directory' // ENOTDIR — path is not a directory (listDir called on a file)
  | 'not_a_file' // EISDIR — path is not a file (download called on a directory)
  | 'permission' // EACCES / EPERM — access denied
  | 'too_large' // File exceeds the size limit (50 MB import / 2 GiB download)
  | 'outside_roots' // Path is not absolute or contains control characters
  | 'connection' // SSH transport failure (exit 255 / timeout / kex / publickey); retry needed
  | 'other' // Unrecognized error

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// Resolves an address-bar input to an absolute path:
//   - If input starts with '/' it is already absolute → return as-is.
//   - If input is empty → return cwd.
//   - Otherwise → lexically join onto cwd (client-side only; server handles '..' via realpath).
export const resolveRemotePath = (cwd: string, input: string): string => {
  if (input.startsWith('/')) return input
  if (input === '') return cwd

  // Strip trailing slash from cwd before joining.
  const base = cwd.endsWith('/') && cwd !== '/' ? cwd.slice(0, -1) : cwd
  return `${base}/${input}`
}

// Validates a remote path before sending it to the server.
// Returns 'outside_roots' if the path is not absolute or contains control characters (0x00–0x1f).
// Returns undefined when the path is acceptable.
export const validateRemotePath = (path: string): 'outside_roots' | undefined => {
  if (!path.startsWith('/')) return 'outside_roots'
  // Reject any ASCII control character (U+0000–U+001F).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return 'outside_roots'
  return undefined
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

type RawError = {
  code?: string
  message?: string
  // stderr text from exec runner (no POSIX code available on this path)
  stderr?: string
}

type ClassifiedError = {
  remoteKind: RemoteKind
  // True for connection errors: the user must fix connectivity before retrying.
  retry_after_user_action: boolean
}

// Maps an sftp/ssh raw error to the RemoteKind taxonomy.
// The classifier inspects both the error code and the message/stderr for known ssh patterns.
// POSIX codes take precedence; when unavailable (exec runner path), stderr text is used as fallback.
export const classifyRemoteError = (raw: RawError): ClassifiedError => {
  const code = raw.code ?? ''
  const msg = (raw.message ?? '').toLowerCase()
  // stderr text from exec runner (no POSIX code on this path)
  const stderr = (raw.stderr ?? '').toLowerCase()

  // POSIX filesystem codes — checked first, highest priority.
  if (code === 'ENOENT') return { remoteKind: 'not_found', retry_after_user_action: false }
  if (code === 'EACCES' || code === 'EPERM')
    return { remoteKind: 'permission', retry_after_user_action: false }
  if (code === 'ENOTDIR') return { remoteKind: 'not_a_directory', retry_after_user_action: false }
  if (code === 'EISDIR') return { remoteKind: 'not_a_file', retry_after_user_action: false }

  // SSH transport failures — these all require user action (fix connectivity / keys).
  // Checked against both message and stderr since exec runner surfaces errors in stderr.
  const combinedText = `${msg} ${stderr}`
  const isConnectionError =
    (combinedText.includes('255') && combinedText.includes('exit')) ||
    combinedText.includes('timed out') ||
    combinedText.includes('timeout') ||
    combinedText.includes('kex') ||
    combinedText.includes('permission denied (publickey') ||
    combinedText.includes('connection refused') ||
    combinedText.includes('no route to host')

  if (isConnectionError) return { remoteKind: 'connection', retry_after_user_action: true }

  // Stderr text fallbacks for exec runner path (no POSIX code available).
  // Order matters: check more specific patterns before "permission denied" to avoid misclassifying
  // "permission denied (publickey)" which was already handled above as connection.
  const stderrLower = stderr || msg
  if (stderrLower.includes('no such file or directory'))
    return { remoteKind: 'not_found', retry_after_user_action: false }
  if (stderrLower.includes('not a directory'))
    return { remoteKind: 'not_a_directory', retry_after_user_action: false }
  if (stderrLower.includes('is a directory'))
    return { remoteKind: 'not_a_file', retry_after_user_action: false }
  // "permission denied" without "(publickey)" is a filesystem permission error.
  if (stderrLower.includes('permission denied'))
    return { remoteKind: 'permission', retry_after_user_action: false }

  return { remoteKind: 'other', retry_after_user_action: false }
}

// ---------------------------------------------------------------------------
// Timestamp conversion
// ---------------------------------------------------------------------------

// Converts sftp readdir's native mtime (whole seconds) to milliseconds.
export const mtimeSecondsToMs = (sec: number): number => sec * 1000

// ---------------------------------------------------------------------------
// Directory listing parser
// ---------------------------------------------------------------------------

// Parses the NUL-delimited output of:
//   find . -maxdepth 1 -mindepth 1 -printf '%Y\t%s\t%T@\t%f\0'
//
// Each record is: <type>\t<size>\t<mtime_float>\t<name>\0
//   %Y = file type following symlinks (f=regular, d=directory, l=broken symlink, etc.)
//   %s = size in bytes
//   %T@ = mtime as floating-point seconds since epoch
//   %f = filename (last path component; may contain spaces but not NUL)
//
// Returns an array of RemoteDirEntry. Malformed records are silently skipped.
export const parseFindListing = (stdout: string): RemoteDirEntry[] => {
  if (!stdout) return []

  const entries: RemoteDirEntry[] = []

  // Records are NUL-terminated; split and drop the trailing empty string.
  const records = stdout.split('\0').filter(Boolean)

  for (const record of records) {
    // Split on the first three tabs only; the name (4th field) may itself contain tabs.
    const firstTab = record.indexOf('\t')
    if (firstTab === -1) continue

    const secondTab = record.indexOf('\t', firstTab + 1)
    if (secondTab === -1) continue

    const thirdTab = record.indexOf('\t', secondTab + 1)
    if (thirdTab === -1) continue

    const type = record.slice(0, firstTab)
    const sizeStr = record.slice(firstTab + 1, secondTab)
    const mtimeStr = record.slice(secondTab + 1, thirdTab)
    const name = record.slice(thirdTab + 1)

    if (!name) continue

    const size = Number(sizeStr)
    const mtimeSec = Number(mtimeStr)

    if (!Number.isFinite(size) || !Number.isFinite(mtimeSec)) continue

    entries.push({
      name,
      isDirectory: type === 'd',
      size,
      // Float seconds * 1000 → ms; Math.round avoids floating-point drift.
      mtimeMs: Math.round(mtimeSec * 1000)
    })
  }

  return entries
}

// ---------------------------------------------------------------------------
// Bookmark helpers (settings JSON, keyed by provider_id)
// ---------------------------------------------------------------------------

// Reads the pinned bookmark folders for a provider from settings.
// Returns an empty array when no bookmarks are stored for the given provider.
export const readBookmarks = (settings: ComputeBookmarkStore, providerId: string): string[] => {
  const store = settings.computeBookmarks
  if (!store) return []
  const folders = store[providerId]
  if (!Array.isArray(folders)) return []
  return folders.filter((f): f is string => typeof f === 'string')
}

// Returns a new settings object with the bookmark folders for a provider replaced.
// Does not mutate the input. Generic over T so callers passing the full StoredSettings get the
// same type back (only the computeBookmarks slice is touched).
export const writeBookmarks = <T extends ComputeBookmarkStore>(
  settings: T,
  providerId: string,
  folders: string[]
): T => {
  const existing: Record<string, string[]> = settings.computeBookmarks ?? {}
  return {
    ...settings,
    computeBookmarks: {
      ...existing,
      [providerId]: folders
    }
  }
}
