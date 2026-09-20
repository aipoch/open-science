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

// Only constructed after authoritative JSON replacement has returned successfully. A derived
// catalog failure cannot turn that known commit into a failed provider execution.
export class SessionProjectionAfterCommitError extends Error {
  constructor(
    readonly committedSession: PersistedChatSession,
    cause: unknown
  ) {
    super('Session JSON committed; derived Session catalog update is incomplete.', { cause })
    this.name = 'SessionProjectionAfterCommitError'
  }
}
