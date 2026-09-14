import type { PersistedChatSession } from '../../shared/session-persistence'

type RevisionedSessionRepository = {
  saveSession(
    session: PersistedChatSession,
    expectedRevision?: number
  ): Promise<PersistedChatSession>
}

export const saveSessionWithRevision = async (
  repository: RevisionedSessionRepository,
  session: PersistedChatSession,
  expectedRevision?: number
): Promise<PersistedChatSession> => {
  return expectedRevision === undefined
    ? repository.saveSession(session)
    : repository.saveSession(session, expectedRevision)
}
