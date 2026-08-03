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

// The single settings key under computeBookmarks reserved for local (non-SSH) bookmarks. Reusing
// the compute bookmark store avoids a settings-schema migration; SSH providers are keyed by
// provider_id, which never collides with this literal.
export const LOCAL_BOOKMARKS_KEY = 'local'

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
