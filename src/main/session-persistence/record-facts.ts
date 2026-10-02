import { SessionProjectionAfterCommitError } from './save-session'
import {
  isSessionSizeLimitError,
  type PersistedChatSession
} from '../../shared/session-persistence'

// Observe actual authoritative replacements, never reads or metadata hydration. These facts
// belong to one exact Project/Session and cannot be cleared by an unrelated successful save.
export const observeSessionRecordWrites = <
  Repository extends {
    saveSession(
      session: PersistedChatSession,
      expectedRevision?: number
    ): Promise<PersistedChatSession>
    saveSessionWithBindingRepair?(
      session: PersistedChatSession,
      expectedRevision: number
    ): Promise<PersistedChatSession>
  }
>(
  repository: Repository,
  facts: {
    failedSizeLimit: (session: PersistedChatSession) => Promise<void>
    committed: (session: PersistedChatSession) => void
  }
): Repository =>
  new Proxy(repository, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (property !== 'saveSession' && property !== 'saveSessionWithBindingRepair')
        return value.bind(target)
      return async (
        session: PersistedChatSession,
        ...revision: [expectedRevision?: number]
      ): Promise<PersistedChatSession> => {
        // Transient Main facts are response-only even if a client forges or echoes them.
        const { recordProblems: ignored, ...candidate } = session
        void ignored
        let saved: PersistedChatSession
        try {
          saved = await (value as Repository['saveSession']).call(target, candidate, ...revision)
        } catch (error) {
          if (error instanceof SessionProjectionAfterCommitError)
            facts.committed(error.committedSession)
          else if (isSessionSizeLimitError(error)) await facts.failedSizeLimit(candidate)
          throw error
        }
        facts.committed(saved)
        return saved
      }
    }
  })
