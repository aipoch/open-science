import type { Project } from './projects'
import type { PersistedChatSession } from './session-persistence'

type SessionSavedEvent = {
  session: PersistedChatSession
  created: boolean
}

type ProjectDeletedEvent = {
  projectId: string
}

type SessionDeletedEvent = {
  projectId: string
  sessionId: string
}

const LIFECYCLE_CHANNELS = {
  projectCreated: 'project:created',
  projectUpdated: 'project:updated',
  projectDeleted: 'project:deleted',
  sessionSaved: 'session:saved',
  sessionDeleted: 'session:deleted'
} as const

export { LIFECYCLE_CHANNELS }
export type { Project, ProjectDeletedEvent, SessionDeletedEvent, SessionSavedEvent }
