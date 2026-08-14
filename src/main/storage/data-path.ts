import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'

import { resolveDataRoot } from '../storage-root'

export const DATA_ROOT_SENTINEL = '$DATA'

const DATA_ROOT_PREFIX = `${DATA_ROOT_SENTINEL}/`
const WINDOWS_DRIVE_PREFIX = /(?:^|\/)[a-z]:/i

const invalidDataPathError = (): Error =>
  new Error('$DATA path must be a portable relative path within the data root.')

// True when `candidate` is inside `root` (not the root itself, not an escaping sibling).
const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(resolve(root), resolve(candidate))
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const isInsideOrEqual = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const tryNormalizeDataPathSuffix = (suffix: string): string | undefined => {
  if (suffix.includes('\\') || posix.isAbsolute(suffix) || win32.isAbsolute(suffix)) {
    return undefined
  }

  if (WINDOWS_DRIVE_PREFIX.test(suffix) || suffix.split('/').includes('..')) {
    return undefined
  }

  const normalized = posix.normalize(suffix)
  return normalized === '.' ? '' : normalized
}

const normalizeDataPathSuffix = (suffix: string): string => {
  const normalized = tryNormalizeDataPathSuffix(suffix)
  if (normalized === undefined) throw invalidDataPathError()
  return normalized
}

const resolveEncodedDataPath = (
  stored: string,
  dataRoot: string
): { encoded: string; decoded: string } => {
  const suffix = normalizeDataPathSuffix(stored.slice(DATA_ROOT_PREFIX.length))
  const root = resolve(dataRoot)
  const decoded = join(dataRoot, suffix)
  const resolvedDecoded = resolve(decoded)

  if (!isInsideOrEqual(root, resolvedDecoded)) throw invalidDataPathError()

  return { encoded: `${DATA_ROOT_PREFIX}${suffix}`, decoded }
}

// Replaces a data-root prefix with the portable "$DATA" sentinel; leaves external paths untouched.
export const encodeDataPath = (
  abs: string | undefined,
  dataRoot: string = resolveDataRoot()
): string | undefined => {
  if (!abs) return abs
  // Already-encoded sentinel: short-circuit before the relative() check below, which
  // otherwise resolves a non-absolute `abs` against process.cwd() and could spuriously
  // match depending on the working directory.
  if (abs.startsWith(DATA_ROOT_PREFIX)) {
    return resolveEncodedDataPath(abs, dataRoot).encoded
  }
  if (!isInside(dataRoot, abs)) return abs
  const rel = relative(dataRoot, abs).split(sep).join('/')
  const normalized = tryNormalizeDataPathSuffix(rel)
  return normalized === undefined ? abs : `${DATA_ROOT_PREFIX}${normalized}`
}

// Resolves a "$DATA/..." sentinel against the current data root; leaves other values untouched.
export const decodeDataPath = (
  stored: string | undefined,
  dataRoot: string = resolveDataRoot()
): string | undefined => {
  if (!stored) return stored
  if (!stored.startsWith(DATA_ROOT_PREFIX)) return stored
  return resolveEncodedDataPath(stored, dataRoot).decoded
}
