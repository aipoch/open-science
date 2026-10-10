import type { ChatSession } from '@/stores/session-store'

export type ResearchProjectDestination =
  | { kind: 'session'; sessionId: string; sourceImportId?: string }
  | { kind: 'research'; sourceSessionId: string; sourceImportId: string }
  | { kind: 'draft' }

const storageKey = (projectId: string): string =>
  `open-science:research-project-destination:${projectId}`
const importId = (session: ChatSession): string | undefined =>
  session.packageOrigin?.importId ?? session.importedResearch?.importId
const visible = (session: ChatSession, projectId: string): boolean =>
  session.projectId === projectId && session.archivedAt === undefined && !session.isPending

export const hasImportedResearch = (sessions: readonly ChatSession[], projectId: string): boolean =>
  sessions.some((session) => visible(session, projectId) && Boolean(importId(session)))

export const readResearchProjectDestination = (
  projectId: string
): ResearchProjectDestination | undefined => {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(storageKey(projectId)) ?? 'null')
    if (!stored || typeof stored !== 'object' || !('kind' in stored)) return undefined
    if (stored.kind === 'draft') return { kind: 'draft' }
    if (
      stored.kind === 'session' &&
      'sessionId' in stored &&
      typeof stored.sessionId === 'string' &&
      (!('sourceImportId' in stored) || typeof stored.sourceImportId === 'string')
    )
      return {
        kind: 'session',
        sessionId: stored.sessionId,
        ...('sourceImportId' in stored ? { sourceImportId: stored.sourceImportId as string } : {})
      }
    if (
      stored.kind === 'research' &&
      'sourceSessionId' in stored &&
      typeof stored.sourceSessionId === 'string' &&
      'sourceImportId' in stored &&
      typeof stored.sourceImportId === 'string'
    )
      return {
        kind: 'research',
        sourceSessionId: stored.sourceSessionId,
        sourceImportId: stored.sourceImportId
      }
  } catch {
    // A local navigation preference must never block opening a project.
  }
  return undefined
}

// This preference belongs to the local UI, never to a Session or a published .science package.
// Ordinary projects retain their existing most-recent-session navigation.
export const rememberResearchProjectDestination = (
  projectId: string,
  destination: ResearchProjectDestination,
  sessions: readonly ChatSession[]
): void => {
  if (!hasImportedResearch(sessions, projectId)) return
  try {
    const selected =
      destination.kind === 'session'
        ? sessions.find(
            (session) => session.projectId === projectId && session.id === destination.sessionId
          )
        : undefined
    const value =
      selected && importId(selected)
        ? { ...destination, sourceImportId: importId(selected) }
        : destination
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(value))
  } catch {
    // Storage can be unavailable; navigation still succeeds without remembering it.
  }
}

export const resolveResearchProjectDestination = (
  projectId: string,
  sessions: readonly ChatSession[],
  remembered: ResearchProjectDestination | undefined
): ResearchProjectDestination | undefined => {
  if (!hasImportedResearch(sessions, projectId)) return undefined
  const eligible = sessions.filter((session) => visible(session, projectId))
  if (remembered?.kind === 'draft') return remembered
  if (
    remembered?.kind === 'session' &&
    eligible.some(
      (session) =>
        session.id === remembered.sessionId && importId(session) === remembered.sourceImportId
    )
  )
    return remembered
  if (
    remembered?.kind === 'research' &&
    eligible.some(
      (session) =>
        session.id === remembered.sourceSessionId && importId(session) === remembered.sourceImportId
    )
  )
    return remembered
  const recent = [...eligible].sort((left, right) => right.updatedAt - left.updatedAt)[0]
  if (!recent) return { kind: 'draft' }
  const sourceImportId = importId(recent)
  return sourceImportId
    ? { kind: 'research', sourceSessionId: recent.id, sourceImportId }
    : { kind: 'session', sessionId: recent.id }
}
