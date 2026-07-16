import { isAbsolute, join, relative, sep } from 'node:path'

import { resolveDataRoot } from '../storage-root'

export const DATA_ROOT_SENTINEL = '$DATA'

// True when `candidate` is inside `root` (not the root itself, not an escaping sibling).
const isInside = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
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
  if (abs.startsWith(`${DATA_ROOT_SENTINEL}/`)) return abs
  if (!isInside(dataRoot, abs)) return abs
  const rel = relative(dataRoot, abs).split(sep).join('/')
  return `${DATA_ROOT_SENTINEL}/${rel}`
}

// Resolves a "$DATA/..." sentinel against the current data root; leaves other values untouched.
export const decodeDataPath = (
  stored: string | undefined,
  dataRoot: string = resolveDataRoot()
): string | undefined => {
  if (!stored) return stored
  const prefix = `${DATA_ROOT_SENTINEL}/`
  if (!stored.startsWith(prefix)) return stored
  return join(dataRoot, stored.slice(prefix.length))
}
