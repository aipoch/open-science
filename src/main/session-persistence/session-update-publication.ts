import type { PersistedChatSession } from '../../shared/session-persistence'
import { hasCurrentRunningDelegatedAttempt } from '../../shared/delegated-work-projection'
import type { Logger } from '../logger'

type SessionUpdateOwner = 'delegated-work' | 'runtime-context'
type SessionUpdatePublisher = (session: PersistedChatSession, owner: SessionUpdateOwner) => void
type ActiveDelegatedSession = Readonly<{ projectId: string; sessionId: string }>

// Owns the synchronous delegated-activity index derived from every durable Session commit. The
// coordinator exposes only the read side, so persistence callers cannot forget which mutations must
// update close/quit and migration safety gates.
class SessionUpdatePublicationOwner {
  private readonly activeDelegatedSessions = new Map<string, ActiveDelegatedSession>()

  constructor(
    private readonly publishSessionUpdate: SessionUpdatePublisher | undefined,
    private readonly log: Logger
  ) {}

  observeCommittedSession(session: PersistedChatSession): void {
    const key = JSON.stringify([session.projectId, session.id])
    if (hasCurrentRunningDelegatedAttempt(session)) {
      this.activeDelegatedSessions.set(key, {
        projectId: session.projectId,
        sessionId: session.id
      })
    } else {
      this.activeDelegatedSessions.delete(key)
    }
  }

  publish(session: PersistedChatSession, owner: SessionUpdateOwner): void {
    this.observeCommittedSession(session)
    try {
      this.publishSessionUpdate?.(structuredClone(session), owner)
    } catch (error) {
      this.log.warn(`${owner} Session publication failed`, {
        errorCategory: error instanceof Error ? error.name : typeof error
      })
    }
  }

  getActiveDelegatedSessions(): ActiveDelegatedSession[] {
    return Array.from(this.activeDelegatedSessions.values())
  }
}

export { SessionUpdatePublicationOwner }
export type { SessionUpdateOwner, SessionUpdatePublisher }
