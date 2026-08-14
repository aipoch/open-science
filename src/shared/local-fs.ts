// Shared types and pure helpers for the local ("This computer") file-browser feature.
// Mirrors the remote-fs contracts (src/shared/remote-fs.ts) but for the machine Kiro runs on.
// No I/O here: everything is pure and directly unit-testable. Main-process I/O lives in
// src/main/local-fs/, the renderer talks to it via window.api.localFs.

// A single entry returned by a local directory listing (files and directories).
export type LocalDirEntry = {
  name: string
  isDirectory: boolean
  // File size in bytes; directories report 0.
  size: number
  // Modification time in milliseconds.
  mtimeMs: number
}

// Result of a listDir call: the entries plus navigation context.
export type LocalDirListing = {
  // Sorted: directories first, then files, each group alphabetical (case-insensitive).
  entries: LocalDirEntry[]
  // True when the directory had more entries than the cap and was truncated.
  truncated: boolean
  // Server-side realpath of the requested path (resolves .. and symlinks).
  resolvedPath: string
}

// Well-known roots + a user-facing machine name, inlined for the browser's "Go to" dropdown and
// the Artifacts entry label.
export type LocalRoots = {
  home: string
  // Friendly machine name (e.g. "Roxi's MacBook Pro"), derived from os.hostname().
  machineName: string
}

// One mounted drive/volume, for the drive switchers in both local browsers. `path` is the
// browsable root (`C:\` on Windows, `/` or `/Volumes/<name>` on POSIX); `label` is what the
// dropdown shows (the drive letter on Windows, the volume name elsewhere).
export type LocalDrive = {
  path: string
  label: string
}

// The single settings key under computeBookmarks reserved for local (non-SSH) bookmarks. Reusing
// the compute bookmark store avoids a settings-schema migration; SSH providers are keyed by
// provider_id, which never collides with this literal.
export const LOCAL_BOOKMARKS_KEY = 'local'

// A folder the user explicitly granted the app access to ("Grant folder access"). Stored in the
// SQLite project DB (GrantedLocalRoot table; see src/main/local-fs/granted-roots-repository.ts);
// the renderer manages the list and the linked-folder file-reference resolver confines reads to
// these roots.
export type GrantedLocalRoot = {
  id: string
  // Server-side realpath at grant time, so symlinked parents are captured canonically.
  path: string
  // Display label: basename of the granted path.
  name: string
  // Persistence/display only this iteration — no write enforcement reads this yet.
  access: GrantedLocalRootAccess
}

export type GrantedLocalRootAccess = 'ro' | 'rw'

// IPC request shapes for the granted-root channels (local-fs:*); shared so preload, main, and the
// renderer agree on the payloads.
export type GrantLocalRootRequest = { path: string; access: GrantedLocalRootAccess }
export type SetGrantedLocalRootAccessRequest = { id: string; access: GrantedLocalRootAccess }
export type RemoveGrantedLocalRootRequest = { id: string }

// Max directory entries returned by a single listDir before truncation kicks in. Keeps the
// renderer responsive on huge directories (e.g. node_modules).
export const LOCAL_DIR_ENTRY_CAP = 5000

const isWindowsDrivePath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path)
const isWindowsUncPath = (path: string): boolean => /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(path)
const isWindowsLocalPath = (path: string, platform: string): boolean =>
  platform === 'win32' && (isWindowsDrivePath(path) || isWindowsUncPath(path))

// Validates a local path before touching the filesystem. Returns an error kind or undefined.
// The security model is "Home start, full-disk navigable": we do NOT restrict to a root, but we
// reject non-absolute paths and paths containing ASCII control characters (which are never valid
// path components and would indicate a crafted/garbled input).
export const validateLocalPath = (
  path: string,
  platform: string
): 'not_absolute' | 'control_chars' | undefined => {
  if (typeof path !== 'string' || path.length === 0) return 'not_absolute'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(path)) return 'control_chars'
  const isPosixAbsolute = path.startsWith('/')
  const isAbsolute = platform === 'win32' ? isWindowsLocalPath(path, platform) : isPosixAbsolute
  if (!isAbsolute) return 'not_absolute'
  return undefined
}

// The quiet inline sentence both local browsers show when an address-bar/path-field submit fails
// validateLocalPath. The not_absolute hint is platform-aware: a POSIX-style example would
// mislead on Windows, where absolute paths lead with a drive letter.
export const describeInvalidLocalPath = (
  kind: 'not_absolute' | 'control_chars',
  platform: string
): string => {
  if (kind === 'control_chars') return 'That path contains invalid characters.'
  return platform === 'win32'
    ? 'Enter an absolute path, like C:\\folder.'
    : 'Enter an absolute path, starting at /.'
}

// Basenames that are always considered "sensitive" — reading them (or, for directories, entering
// them) is allowed per the chosen security model, but the UI surfaces a gentle warning first.
// Matched case-insensitively against the final path component. Covers credential directories
// (.ssh/.aws/.gnupg — the browser warns before entering these) and well-known secret files,
// including the SSH private keys and cloud credential files that carry no distinguishing suffix.
const SENSITIVE_BASENAMES = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.htpasswd',
  'credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519'
])
const SENSITIVE_SUFFIXES = ['.pem', '.key', '.env', '.p12', '.pfx']

// Returns true when a path's basename looks security-sensitive (keys, credentials, dotenv). Pure
// so both the browser listing and the preview open path can share one definition.
export const isSensitiveLocalPath = (path: string, platform: string): boolean => {
  const base = (
    path.split(isWindowsLocalPath(path, platform) ? /[\\/]/ : '/').pop() ?? ''
  ).toLowerCase()
  if (!base) return false
  if (SENSITIVE_BASENAMES.has(base)) return true
  if (base.startsWith('.env')) return true
  return SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix))
}

// Sorts entries directories-first, then case-insensitive alphabetical within each group. Returns a
// new array; does not mutate the input.
export const sortLocalEntries = (entries: LocalDirEntry[]): LocalDirEntry[] =>
  [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

// A listing failure, split so the renderer can show a short sentence and the offending path apart.
export type LocalListingProblem = { summary: string; path?: string }

// Turns a raw listDir rejection into something worth showing a person. Electron prefixes IPC
// rejections with "Error invoking remote method 'local-fs:list-dir':" and appends the node errno
// text ("ENOENT: no such file or directory, realpath '/x'"), which is why the unmapped message read
// like a stack trace. Matching on the errno code keeps this independent of that wrapping.
export const describeLocalListingError = (
  message: string,
  requestedPath: string
): LocalListingProblem => {
  const path = requestedPath || undefined
  if (/\bENOENT\b/.test(message)) return { summary: 'No such folder:', path }
  if (/\bENOTDIR\b/.test(message)) return { summary: 'Not a folder:', path }
  if (/\b(EACCES|EPERM)\b/.test(message)) return { summary: "You don't have access to:", path }
  if (/\bELOOP\b/.test(message)) return { summary: 'Too many symlinks to follow:', path }
  if (/\bENAMETOOLONG\b/.test(message)) return { summary: 'That path is too long:', path }
  if (/must be absolute/i.test(message))
    return { summary: 'Enter an absolute path, starting at /.' }
  if (/invalid characters/i.test(message))
    return { summary: 'That path contains invalid characters.' }
  // Unrecognized failure: keep the raw text rather than inventing a reason, minus the IPC wrapper.
  const unwrapped = message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
  return { summary: unwrapped || 'Could not open that folder.' }
}

// Resolves an address-bar input to an absolute path, lexically joining relative input onto cwd.
// The main process still calls realpath to canonicalize '..' and symlinks.
export const resolveLocalPath = (cwd: string, input: string, platform: string): string => {
  if (validateLocalPath(input, platform) === undefined) return input
  if (input === '') return cwd
  const windows = isWindowsLocalPath(cwd, platform)
  const separator = windows ? '\\' : '/'
  const base = cwd.replace(windows ? /[\\/]+$/ : /\/+$/, '')
  return `${base}${separator}${input}`
}

// Normalizes separators for scope comparisons: both POSIX and Windows separators count as
// separators (the app ships on mac/win), and trailing separators are dropped so a root recorded
// as "/data/" still matches "/data/x". Case is left alone — comparison is exact on purpose.
const normalizePathForScope = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')

// True when `path` is `root` itself or lives inside it. The separator boundary in the startsWith
// check matters: "/data2/x" must NOT count as within "/data".
export const isPathWithin = (path: string, root: string): boolean => {
  const candidate = normalizePathForScope(path)
  const base = normalizePathForScope(root)
  return candidate === base || candidate.startsWith(`${base}/`)
}

// Validates a folder the user wants to grant. Any valid absolute path qualifies — granting is no
// longer confined to home or already-granted roots (existence is guaranteed by the realpath in
// grantRoot). Home itself is rejected because it is the implicit root and granting it would be a
// no-op.
export const validateGrantCandidate = (
  path: string,
  home: string,
  platform: string
): { ok: true } | { ok: false; reason: 'not-absolute' | 'is-home' } => {
  if (validateLocalPath(path, platform) !== undefined) return { ok: false, reason: 'not-absolute' }
  if (normalizePathForScope(path) === normalizePathForScope(home))
    return { ok: false, reason: 'is-home' }
  return { ok: true }
}

const localPathRoot = (path: string, platform: string): string => {
  if (isWindowsDrivePath(path)) return path.slice(0, 3)
  return (platform === 'win32' ? path.match(/^[\\/]{2}[^\\/]+[\\/][^\\/]+/)?.[0] : undefined) ?? '/'
}

const withoutTrailingSeparators = (path: string, platform: string): string => {
  const root = localPathRoot(path, platform)
  if (path.length <= root.length) return root
  return path.replace(isWindowsLocalPath(path, platform) ? /[\\/]+$/ : /\/+$/, '')
}

export const sameLocalDirectory = (a: string, b: string, platform: string): boolean => {
  const left = withoutTrailingSeparators(a, platform)
  const right = withoutTrailingSeparators(b, platform)
  if (!isWindowsLocalPath(left, platform)) return left === right
  return left.replace(/\//g, '\\').toLowerCase() === right.replace(/\//g, '\\').toLowerCase()
}

export const parentLocalPath = (path: string, platform: string): string => {
  const root = localPathRoot(path, platform)
  const normalized = withoutTrailingSeparators(path, platform)
  if (sameLocalDirectory(normalized, root, platform)) return root
  const separator = isWindowsLocalPath(normalized, platform)
    ? Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
    : normalized.lastIndexOf('/')
  return separator < root.length ? root : normalized.slice(0, separator)
}

export const isLocalPathRoot = (path: string, platform: string): boolean =>
  sameLocalDirectory(path, localPathRoot(path, platform), platform)

// The mounted drive/volume a path lives on: the longest listDrives() entry containing it, so
// /media/user/usb/sub resolves to the usb mount rather than /. Windows compares
// case-insensitively (a cwd realpath'd to "c:\…" must still match the "C:\" entry) and tolerates
// either separator. Falls back to the lexical path root (C:\, UNC share, or /) when no enumerated
// drive matches — e.g. before the listDrives call has resolved.
export const localDriveRootFor = (
  path: string,
  drives: readonly LocalDrive[],
  platform: string
): string => {
  const windows = platform === 'win32'
  const separator = windows ? '\\' : '/'
  const normalize = (value: string): string =>
    windows ? value.replace(/\//g, '\\').toLowerCase() : value
  const candidate = normalize(path)
  let best: LocalDrive | undefined
  for (const drive of drives) {
    const root = normalize(drive.path)
    // The separator boundary matters: "/media/user/usb2" must NOT match the "/media/user/usb" drive.
    const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}${separator}`
    if (candidate === root || candidate.startsWith(prefix)) {
      if (!best || root.length > normalize(best.path).length) best = drive
    }
  }
  if (best) return best.path
  return localPathRoot(path, platform)
}
