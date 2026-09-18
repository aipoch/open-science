import {
  findSearchMatches,
  normalizeSearchText,
  searchTitleRank,
  type SearchSort
} from '../../../../shared/search-text'

export type SearchableSession = {
  id: string
  projectId: string
  title: string
  number?: number
  updatedAt: number
  artifactCount: number
  isPending?: boolean
}

// Scope and pagination belong to the view. Retain original objects, including hydrated counts,
// so the renderer can consume matching Sessions without rebuilding them through an ID lookup.
export const searchSessionTitles = <Session extends SearchableSession>({
  sessions,
  query,
  sort = 'relevance'
}: {
  sessions: Session[]
  query: string
  sort?: SearchSort
}): Session[] => {
  const needle = normalizeSearchText(query.trim())
  const numeric = /^\d+$/.test(needle)
  const numberText = (session: Session): string =>
    Number.isSafeInteger(session.number) && session.number! > 0 ? String(session.number) : ''
  return sessions
    .filter(
      (session) =>
        !session.isPending &&
        (numeric
          ? numberText(session).startsWith(needle)
          : !needle || findSearchMatches(session.title, query, 1).length > 0)
    )
    .sort(
      (a, b) =>
        (sort === 'relevance'
          ? Math.max(searchTitleRank(b.title, query), searchTitleRank(numberText(b), query)) -
            Math.max(searchTitleRank(a.title, query), searchTitleRank(numberText(a), query))
          : 0) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id)
    )
}
