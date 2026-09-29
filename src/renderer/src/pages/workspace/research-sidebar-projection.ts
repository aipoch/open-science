import type { ResearchWorkspaceSnapshot } from '../../../../shared/research-workspace'
import type { ChatSession } from '@/stores/session-store'

// Source rows remain the real objects used by action menus and hover previews. Only activity and
// selection are projected from the writable Discussion; losing the source never hides that history.
export const projectResearchSidebar = (
  sessions: ChatSession[],
  workspaces: ResearchWorkspaceSnapshot[],
  activeSessionId: string | undefined
): {
  sessions: ChatSession[]
  activitySessionsByEntryId: ReadonlyMap<string, ChatSession>
  activeSessionId: string | undefined
} => {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const hidden = new Set<string>()
  const activitySessionsByEntryId = new Map<string, ChatSession>()
  let activeEntryId = activeSessionId
  for (const workspace of workspaces) {
    const source = byId.get(workspace.sourceSessionId)
    const discussion = workspace.discussionSessionId
      ? byId.get(workspace.discussionSessionId)
      : undefined
    if (
      !source ||
      !discussion ||
      workspace.sourceStatus !== 'available' ||
      workspace.discussionStatus !== 'available' ||
      source.projectId !== workspace.projectId ||
      discussion.projectId !== workspace.projectId ||
      source.archivedAt !== undefined ||
      discussion.archivedAt !== undefined
    )
      continue
    hidden.add(discussion.id)
    activitySessionsByEntryId.set(source.id, discussion)
    if (activeSessionId === discussion.id) activeEntryId = source.id
  }
  return {
    sessions: hidden.size ? sessions.filter((session) => !hidden.has(session.id)) : sessions,
    activitySessionsByEntryId,
    activeSessionId: activeEntryId
  }
}
