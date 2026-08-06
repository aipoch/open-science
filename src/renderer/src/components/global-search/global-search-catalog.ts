export const GLOBAL_SEARCH_PAGE_SIZE = 8
export const RECENT_SESSION_LIMIT = 5
export const OTHER_PROJECT_RESULT_LIMIT = 5

export type SearchableSession = {
  id: string
  projectId: string
  title: string
  updatedAt: number
  artifactCount: number
  isPending?: boolean
}

export type SessionSearchResult = SearchableSession & {
  kind: 'session'
  projectName: string
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

const toResult = (
  session: SearchableSession,
  projectNames: Map<string, string>
): SessionSearchResult => ({
  ...session,
  kind: 'session',
  projectName: projectNames.get(session.projectId) ?? 'Unknown project'
})

// Session titles are already hydrated in the renderer. Keep this local filter deliberately narrow
// so global search does not accidentally become message-body or metadata search.
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
  const matches = sessions
    .filter(
      (session) =>
        !session.isPending &&
        projectNames.has(session.projectId) &&
        foldAsciiCase(session.title).includes(foldedQuery)
    )
    .sort(compareByRecency)
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
