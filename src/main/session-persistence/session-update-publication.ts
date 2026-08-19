import type { PersistedChatSession } from '../../shared/session-persistence'
import type { Logger } from '../logger'

type SessionUpdateOwner = 'delegated-work' | 'runtime-context'
type SessionUpdatePublisher = (session: PersistedChatSession, owner: SessionUpdateOwner) => void

const createSafeSessionUpdatePublisher =
  (publish: SessionUpdatePublisher | undefined, log: Logger): SessionUpdatePublisher =>
  (session, owner) => {
    try {
      publish?.(structuredClone(session), owner)
    } catch (error) {
      log.warn(`${owner} Session publication failed`, {
        errorCategory: error instanceof Error ? error.name : typeof error
      })
    }
  }

export { createSafeSessionUpdatePublisher }
export type { SessionUpdateOwner, SessionUpdatePublisher }
