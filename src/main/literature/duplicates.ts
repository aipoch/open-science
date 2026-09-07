import { LITERATURE_IDENTITY_SCHEMES, type LiteratureDuplicateGroup } from '../../shared/literature'

type DuplicateCandidate = {
  id: string
  itemType: string
  title: string
  issuedYear: number | null
  creators: { creator: { familyName: string; givenName: string; literalName: string } }[]
  identifiers: { scheme: string; normalizedValue: string }[]
}

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]+/gu, ' ')
    .trim()

const identitySchemes = new Set<string>(LITERATURE_IDENTITY_SCHEMES)

// Indexed exact matches keep the scan linear in the number of records and identifiers.
// Deliberately leave fuzzy titles and publication-year differences for manual review.
export const findLiteratureDuplicateGroups = (
  candidates: DuplicateCandidate[]
): LiteratureDuplicateGroup[] => {
  const parents = candidates.map((_, index) => index)
  const identifiers = candidates.map((item) => {
    const values = new Map<string, Set<string>>()
    for (const identifier of item.identifiers) {
      if (!identitySchemes.has(identifier.scheme)) continue
      const set = values.get(identifier.scheme) ?? new Set<string>()
      set.add(identifier.normalizedValue)
      values.set(identifier.scheme, set)
    }
    return values
  })
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]]
      index = parents[index]
    }
    return index
  }
  const keys = new Map<string, number>()
  const join = (left: number, right: number): void => {
    left = root(left)
    right = root(right)
    if (left === right) return
    for (const [scheme, values] of identifiers[left]) {
      const other = identifiers[right].get(scheme)
      if (other && (values.size !== other.size || [...values].some((value) => !other.has(value))))
        return
    }
    parents[right] = left
    for (const [scheme, values] of identifiers[right]) identifiers[left].set(scheme, values)
  }
  candidates.forEach((item, index) => {
    const itemKeys = item.identifiers
      .filter(({ scheme }) => identifiers[index].has(scheme))
      .map(({ scheme, normalizedValue }) => `${item.itemType}:${scheme}:${normalizedValue}`)
    const author = item.creators[0]?.creator
    const authorKey = author
      ? normalize(author.literalName || `${author.familyName} ${author.givenName.slice(0, 1)}`)
      : ''
    if (normalize(item.title) && item.issuedYear !== null && authorKey) {
      itemKeys.push(
        JSON.stringify([item.itemType, normalize(item.title), item.issuedYear, authorKey])
      )
    }
    for (const key of itemKeys) {
      const previous = keys.get(key)
      if (previous !== undefined) join(previous, index)
      else keys.set(key, index)
    }
  })
  const groups = new Map<number, DuplicateCandidate[]>()
  candidates.forEach((item, index) => {
    const key = root(index)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  })
  return [...groups.values()].flatMap((group) => {
    if (group.length < 2) return []
    const first = group[0]
    const sharedIdentifier = first.identifiers.some(
      ({ scheme, normalizedValue }) =>
        identitySchemes.has(scheme) &&
        group.every((item) =>
          item.identifiers.some(
            (identifier) =>
              identifier.scheme === scheme && identifier.normalizedValue === normalizedValue
          )
        )
    )
    return [
      {
        id: group.map(({ id }) => id).sort()[0],
        title: first.title,
        itemIds: group.map(({ id }) => id),
        match: sharedIdentifier ? ('identifier' as const) : ('metadata' as const)
      }
    ]
  })
}
