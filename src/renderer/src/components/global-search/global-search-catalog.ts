export const GLOBAL_SEARCH_PAGE_SIZE = 8
export const RECENT_SESSION_LIMIT = 5
export const OTHER_PROJECT_RESULT_LIMIT = 5

export type SearchableSession = {
  id: string
  projectId: string
  title: string
  number?: number
  updatedAt: number
  artifactCount: number
  isPending?: boolean
}

export type SessionSearchResult = SearchableSession & {
  kind: 'session'
  // Undefined when the Project is not in `projectNames`. This module stays pure and locale-free, so
  // the placeholder wording belongs to the view that renders it, not here.
  projectName?: string
}

export type SessionSearchGroups = {
  primary: SessionSearchResult[]
  primaryTotalCount: number
  other: SessionSearchResult[]
}

const foldAsciiCase = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => character.toLowerCase())

const compareByRecency = (left: SearchableSession, right: SearchableSession): number =>
  right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)

const validSessionNumber = (number: number | undefined): number | undefined =>
  number !== undefined && Number.isSafeInteger(number) && number > 0 ? number : undefined

const toResult = (
  session: SearchableSession,
  projectNames: Map<string, string>
): SessionSearchResult => ({
  ...session,
  kind: 'session',
  projectName: projectNames.get(session.projectId)
})

// Session titles and numbers are already hydrated in the renderer. Keep this local filter
// deliberately narrow so global search does not accidentally become message-body or metadata
// search. A numeric query is an identity lookup: exact number first, then number prefixes.
export const searchSessionTitles = ({
  sessions,
  projectNames,
  primaryProjectId,
  query,
  visiblePrimaryCount
}: {
  sessions: SearchableSession[]
  projectNames: Map<string, string>
  primaryProjectId: string | undefined
  query: string
  visiblePrimaryCount: number
}): SessionSearchGroups => {
  const foldedQuery = foldAsciiCase(query.trim())
  const numericQuery = /^\d+$/.test(foldedQuery) ? foldedQuery : undefined
  const matches = sessions
    .filter(
      (session) =>
        !session.isPending &&
        projectNames.has(session.projectId) &&
        (numericQuery
          ? String(validSessionNumber(session.number) ?? '').startsWith(numericQuery)
          : foldAsciiCase(session.title).includes(foldedQuery))
    )
    .sort((left, right) => {
      if (numericQuery) {
        const exactOrder =
          Number(String(validSessionNumber(right.number)) === numericQuery) -
          Number(String(validSessionNumber(left.number)) === numericQuery)
        if (exactOrder !== 0) return exactOrder
      }
      return compareByRecency(left, right)
    })
  const primaryMatches = primaryProjectId
    ? matches.filter((session) => session.projectId === primaryProjectId)
    : matches

  return {
    primary: primaryMatches
      .slice(0, visiblePrimaryCount)
      .map((session) => toResult(session, projectNames)),
    primaryTotalCount: primaryMatches.length,
    other: primaryProjectId
      ? matches
          .filter((session) => session.projectId !== primaryProjectId)
          .slice(0, OTHER_PROJECT_RESULT_LIMIT)
          .map((session) => toResult(session, projectNames))
      : []
  }
}

export const getRecentSessions = (
  sessions: SearchableSession[],
  projectId?: string
): SearchableSession[] =>
  sessions
    .filter((session) => !session.isPending && (!projectId || session.projectId === projectId))
    .sort(compareByRecency)
    .slice(0, RECENT_SESSION_LIMIT)

// The count advertises what the next click reveals, never every remaining match.
export const getNextBatchCount = (totalCount: number, visibleCount: number): number =>
  Math.max(0, Math.min(GLOBAL_SEARCH_PAGE_SIZE, totalCount - visibleCount))
