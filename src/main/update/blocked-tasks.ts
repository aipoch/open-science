import type { ActiveSessionInfo } from '../../shared/storage'
import type { UpdateBlocker, UpdateStatus } from '../../shared/update'

/** Join authoritative active identities to persisted titles; never invent task rows or counts. */
export function projectUpdateBlockedTasks(
  active: readonly ActiveSessionInfo[],
  summaries: readonly { id: string; projectId: string; title: string }[],
  blockers: readonly UpdateBlocker[]
): NonNullable<UpdateStatus['blockedTasks']> {
  const titles = new Map(
    summaries.map((session) => [JSON.stringify([session.projectId, session.id]), session.title])
  )
  return active.flatMap((session) => {
    if (!blockers.includes(session.kind)) return []
    const title = titles.get(JSON.stringify([session.projectId, session.sessionId]))
    return title ? [{ ...session, title }] : []
  })
}
