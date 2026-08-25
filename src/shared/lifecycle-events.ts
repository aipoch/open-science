import type { Project } from './projects'
import type { PersistedChatSession } from './session-persistence'

type SessionUpsertEvent = {
  session: PersistedChatSession
  originClientId: string
}

// Main-owned permission authority is projected through the existing Session lifecycle channel,
// but it must merge into the live renderer Session instead of replacing in-flight chat state.
const MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID = 'main:permission-wait'
const MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID = 'main:runtime-context'
const MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID = 'main:durable-continuation'
const MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID = 'main:enabled-compute-hosts'
const MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID = 'main:delegated-work'
const MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID = 'main:session-details'

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

export {
  LIFECYCLE_CHANNELS,
  MAIN_DELEGATED_WORK_LIFECYCLE_CLIENT_ID,
  MAIN_DURABLE_CONTINUATION_LIFECYCLE_CLIENT_ID,
  MAIN_ENABLED_COMPUTE_HOSTS_LIFECYCLE_CLIENT_ID,
  MAIN_SESSION_DETAILS_LIFECYCLE_CLIENT_ID,
  MAIN_PERMISSION_WAIT_LIFECYCLE_CLIENT_ID,
  MAIN_RUNTIME_CONTEXT_LIFECYCLE_CLIENT_ID
}
export type { Project, ProjectDeletedEvent, SessionDeletedEvent, SessionUpsertEvent }
