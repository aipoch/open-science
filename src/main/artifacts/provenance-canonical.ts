import { createHash } from 'node:crypto'

type CanonicalJson =
  null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson }

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

export { canonicalJson, sha256 }
export type { CanonicalJson }
