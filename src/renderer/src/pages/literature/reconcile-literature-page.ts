import type { LiteratureCatalogSearchPage } from '../../../../shared/literature'

// Catalog IPC values are plain, acyclic data. Reuse equal subtrees after transport cloning;
// metadataRevision alone cannot detect assessment, attachment or collection changes.
function shareEqual<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next
  if (Array.isArray(previous) !== Array.isArray(next)) return next
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  const keys = Object.keys(after)
  let equal = Object.keys(before).length === keys.length
  const result: Record<string, unknown> = Array.isArray(next)
    ? ([] as unknown as Record<string, unknown>)
    : {}
  for (const key of keys) {
    result[key] = shareEqual(before[key], after[key])
    if (!Object.hasOwn(before, key) || result[key] !== before[key]) equal = false
  }
  return equal ? previous : (result as T)
}

export function reconcileLiteraturePage(
  previous: LiteratureCatalogSearchPage | undefined,
  next: LiteratureCatalogSearchPage
): LiteratureCatalogSearchPage {
  if (!previous) return next
  const byId = new Map(
    previous.entries.flatMap((entry) => ('id' in entry ? [[entry.id, entry] as const] : []))
  )
  const entries = next.entries.map((entry) =>
    'id' in entry ? shareEqual(byId.get(entry.id), entry)! : entry
  )
  const sameEntries =
    entries.length === previous.entries.length &&
    entries.every((entry, index) => entry === previous.entries[index])
  return { ...next, entries: sameEntries ? previous.entries : entries }
}
