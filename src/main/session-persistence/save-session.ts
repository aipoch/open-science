import type { PersistedChatSession } from '../../shared/session-persistence'
import type { RuntimeSessionChanges } from '../../shared/runtime-session-projection'

// Main-only evidence from the reducer which produced this candidate. Never part of IPC options.
export type MainSessionSaveOptions = {
  runtimeChanges?: {
    previous: PersistedChatSession
    changes: RuntimeSessionChanges
  }
  // Invoked once the authoritative JSON/JSONL replacement has committed and before derived
  // catalog writes. Upstream terminal receipts use it to acknowledge event durability.
  onJsonCommitted?: (session: PersistedChatSession) => void
}

type RevisionedSessionRepository = {
  saveSession(
    session: PersistedChatSession,
    expectedRevision?: number,
    options?: MainSessionSaveOptions
  ): Promise<PersistedChatSession>
}

export const saveSessionWithRevision = async (
  repository: RevisionedSessionRepository,
  session: PersistedChatSession,
  expectedRevision?: number,
  options?: MainSessionSaveOptions
): Promise<PersistedChatSession> => {
  if (options) return repository.saveSession(session, expectedRevision, options)
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
