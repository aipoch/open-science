import type { ChatSession } from '@/stores/session-store'
import type { ResearchMembership } from '../../../../shared/session-persistence'
import { researchIdentity } from './research-draft-identity'

export type ResearchNavigationGroup = {
  key: string
  source: ResearchMembership
  session: ChatSession
  discussions: ChatSession[]
}

export const importedResearchSource = (session: ChatSession): ResearchMembership | undefined => {
  const importId = session.packageOrigin?.importId ?? session.importedResearch?.importId
  return importId
    ? {
        sourceProjectId: session.projectId,
        sourceSessionId: session.id,
        sourceImportId: importId,
        sourceTitle: session.title
      }
    : undefined
}

// Only authoritative import and membership projections establish this hierarchy. Reading a
// source, an import-looking id, or a matching title never reclassifies an ordinary conversation.
// If a source disappears, its discussions remain accessible in the ordinary session sections.
export const buildResearchNavigation = (
  sessions: readonly ChatSession[]
): { research: ResearchNavigationGroup[]; ordinary: ChatSession[] } => {
  const research = sessions.flatMap((session) => {
    const source = session.archivedAt === undefined ? importedResearchSource(session) : undefined
    return source
      ? [{ key: researchIdentity(source), source, session, discussions: [] as ChatSession[] }]
      : []
  })
  const groups = new Map(research.map((group) => [group.key, group]))
  const sourceIds = new Set(research.map((group) => group.session.id))
  const ordinary: ChatSession[] = []
  for (const session of sessions) {
    if (session.archivedAt !== undefined || sourceIds.has(session.id)) continue
    const membership = session.researchMembership
    const group = membership ? groups.get(researchIdentity(membership)) : undefined
    if (group && session.projectId === group.source.sourceProjectId) group.discussions.push(session)
    else ordinary.push(session)
  }
  return { research, ordinary }
}

export type ResearchNavigationRow =
  | { kind: 'research'; session: ChatSession; source: ResearchMembership }
  | { kind: 'session'; session: ChatSession }

// Rendering and numbered shortcuts consume the same sequence, including collapsed groups.
export const visibleResearchNavigationRows = (
  research: readonly ResearchNavigationGroup[],
  ordinary: readonly ChatSession[],
  collapsed: ReadonlySet<string>
): ResearchNavigationRow[] => [
  ...research.flatMap((group): ResearchNavigationRow[] => [
    { kind: 'research', session: group.session, source: group.source },
    ...(collapsed.has(group.key)
      ? []
      : group.discussions.map((session) => ({ kind: 'session' as const, session })))
  ]),
  ...ordinary.map((session) => ({ kind: 'session' as const, session }))
]
