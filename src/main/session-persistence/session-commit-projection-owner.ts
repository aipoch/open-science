import { hasCurrentRunningDelegatedAttempt } from '../../shared/delegated-work-projection'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { Logger } from '../logger'

type SessionUpdateOwner = 'delegated-work' | 'runtime-context'
type SessionUpdatePublisher = (session: PersistedChatSession, owner: SessionUpdateOwner) => void
type ActiveDelegatedSession = Readonly<{ projectId: string; sessionId: string }>
type SessionCommitRepository = {
  saveSession(
    session: PersistedChatSession,
    expectedRevision?: number
  ): Promise<PersistedChatSession | void>
  saveCommittedProjectSession?(session: PersistedChatSession): Promise<void>
}

// Adapts the authoritative repository once so every Session commit updates the synchronous
// delegated-activity projection. Publication remains best-effort derived state and cannot affect a
// commit or its projection.
class SessionCommitProjectionOwner {
  private readonly activeDelegatedSessions = new Map<string, ActiveDelegatedSession>()

  constructor(
    private readonly publishSessionUpdate: SessionUpdatePublisher | undefined,
    private readonly log: Logger
  ) {}

  observeRepository<T extends SessionCommitRepository>(repository: T): T {
    const saveSession = repository.saveSession.bind(repository)
    const saveCommittedProjectSession = repository.saveCommittedProjectSession?.bind(repository)
    return new Proxy(repository, {
      get: (target, property) => {
        if (property === 'saveSession') {
          return async (session: PersistedChatSession, expectedRevision?: number) => {
            const persisted = await (expectedRevision === undefined
              ? saveSession(session)
              : saveSession(session, expectedRevision))
            this.observeCommittedSession(persisted ?? session)
            return persisted
          }
        }
        if (property === 'saveCommittedProjectSession' && saveCommittedProjectSession) {
          return async (session: PersistedChatSession) => {
            await saveCommittedProjectSession(session)
            this.observeCommittedSession(session)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }

  publish(session: PersistedChatSession, owner: SessionUpdateOwner): void {
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

  private observeCommittedSession(session: PersistedChatSession): void {
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
}

export { SessionCommitProjectionOwner }
export type { SessionUpdateOwner, SessionUpdatePublisher }
