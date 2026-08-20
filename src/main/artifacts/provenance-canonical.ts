import { createHash } from 'node:crypto'

type CanonicalJson =
  null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson }

const isCanonicalJsonValue = (value: unknown, seen: Set<object> = new Set()): boolean => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true
  }
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((entry) => isCanonicalJsonValue(entry, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((entry) => isCanonicalJsonValue(entry, seen))
  seen.delete(value)
  return valid
}

const canonicalize = (value: CanonicalJson): CanonicalJson => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

const canonicalJson = (value: CanonicalJson): string => JSON.stringify(canonicalize(value))
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')

export { canonicalJson, isCanonicalJsonValue, sha256 }
export type { CanonicalJson }
