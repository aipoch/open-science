import { sessionRevision, type PersistedChatSession } from '../../shared/session-persistence'

type RevisionedSessionRepository = {
  saveSession(
    session: PersistedChatSession,
    expectedRevision?: number
  ): Promise<PersistedChatSession | void>
}

export const saveSessionWithRevision = async (
  repository: RevisionedSessionRepository,
  session: PersistedChatSession,
  expectedRevision?: number
): Promise<PersistedChatSession> => {
  const revision = expectedRevision ?? sessionRevision(session)
  const persisted = await (expectedRevision === undefined
    ? repository.saveSession(session)
    : repository.saveSession(session, expectedRevision))
  if (persisted) return persisted
  if (expectedRevision === undefined) return session
  return { ...session, revision: revision + 1 }
}
