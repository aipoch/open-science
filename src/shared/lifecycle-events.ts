import type { Project } from './projects'
import type { PersistedChatSession } from './session-persistence'

type SessionUpsertEvent = {
  session: PersistedChatSession
  originClientId: string
}

// Main-owned permission authority is projected through the existing Session lifecycle channel,
// but it must merge into the live renderer Session instead of replacing in-flight chat state.
const MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID = 'main:permission-wait'

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

export { LIFECYCLE_CHANNELS, MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID }
export type { Project, ProjectDeletedEvent, SessionDeletedEvent, SessionUpsertEvent }
