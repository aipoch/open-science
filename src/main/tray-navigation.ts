import type { ActiveSessionInfo } from '../shared/storage'

export type TrayNavigationSession = Readonly<{
  id: string
  title: string
  projectName: string
  updatedAt: number
  pinned: boolean
}>

export type TrayNavigationSectionKind = 'running' | 'pinned' | 'recent'

export type TrayNavigationSection = Readonly<{
  kind: TrayNavigationSectionKind
  items: readonly TrayNavigationSession[]
  overflow: readonly TrayNavigationSession[]
}>

const SESSION_LIMIT = 5

const compareSessions = (left: TrayNavigationSession, right: TrayNavigationSession): number =>
  right.updatedAt - left.updatedAt ||
  left.title.localeCompare(right.title) ||
  left.id.localeCompare(right.id)

const uniqueById = (sessions: readonly TrayNavigationSession[]): TrayNavigationSession[] => {
  const seen = new Set<string>()
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false
    seen.add(session.id)
    return true
  })
}

const splitSection = (
  kind: TrayNavigationSectionKind,
  sessions: readonly TrayNavigationSession[],
  limit: number
): TrayNavigationSection => ({
  kind,
  items: sessions.slice(0, limit),
  overflow: sessions.slice(limit)
})

export const buildTrayNavigationSections = (
  sessions: readonly TrayNavigationSession[],
  running: readonly ActiveSessionInfo[],
  limit = SESSION_LIMIT
): TrayNavigationSection[] => {
  const normalizedLimit = Math.max(1, Math.floor(limit))
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const runningIds = new Set(running.map(({ sessionId }) => sessionId))
  const runningSessions = [...runningIds]
    .map((sessionId) => byId.get(sessionId))
    .filter((session): session is TrayNavigationSession => session !== undefined)
    .sort(compareSessions)
  const runningSet = new Set(runningSessions.map(({ id }) => id))
  const pinnedSessions = sessions
    .filter((session) => session.pinned && !runningSet.has(session.id))
    .sort(compareSessions)
  const pinnedSet = new Set(pinnedSessions.map(({ id }) => id))
  const recentSessions = sessions
    .filter((session) => !runningSet.has(session.id) && !pinnedSet.has(session.id))
    .sort(compareSessions)

  return [
    splitSection('running', uniqueById(runningSessions), normalizedLimit),
    splitSection('pinned', uniqueById(pinnedSessions), normalizedLimit),
    splitSection('recent', uniqueById(recentSessions), normalizedLimit)
  ].filter(({ items }) => items.length > 0)
}

export { SESSION_LIMIT }
