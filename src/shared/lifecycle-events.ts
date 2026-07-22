import type { Project } from './projects'
import type { PersistedChatSession } from './session-persistence'

type SessionUpsertEvent = {
  session: PersistedChatSession
  originClientId: string
}

type ProjectDeletedEvent = {
  projectId: string
}

type SessionDeletedEvent = {
  projectId: string
  sessionId: string
}

const LIFECYCLE_CHANNELS = {
  clientId: 'lifecycle:client-id',
  projectCreated: 'project:created',
  projectUpdated: 'project:updated',
  projectDeleted: 'project:deleted',
  sessionCreated: 'session:created',
  sessionUpdated: 'session:updated',
  sessionDeleted: 'session:deleted'
} as const

export { LIFECYCLE_CHANNELS }
export type { Project, ProjectDeletedEvent, SessionDeletedEvent, SessionUpsertEvent }
