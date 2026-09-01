// Aggregates the authoritative sources of "actively running" sessions (an in-flight root or Side Chat
// prompt, delegated Attempt, or notebook cell mid-execution) so the storage-migration and close/quit flows
// can warn the user before interrupting them. Pure function driven by structural deps so tests can pass
// fakes without constructing the real runtimes.

import type { ActiveSessionInfo } from '../../shared/storage'
import { hasCurrentRunningDelegatedAttempt } from '../../shared/delegated-work-projection'
import type { PersistedChatSession } from '../../shared/session-persistence'

export type { ActiveSessionInfo }

type LegacyActiveSessionSource = { projectId: string; sessionId: string }
type ActiveNotebookSessionSource = { projectId: string; sessionId: string }

type ActiveDetectionDeps = {
  runtime: { getActivePromptSessions(): LegacyActiveSessionSource[] }
  sideChat: { getActivePromptSessions(): LegacyActiveSessionSource[] }
  delegated: { getActiveDelegatedSessions(): LegacyActiveSessionSource[] }
  notebook: { getActiveNotebookSessions(): ActiveNotebookSessionSource[] }
}

type DelegatedActivityProjection = Readonly<{
  recordSession(session: PersistedChatSession): void
  getActiveDelegatedSessions(): LegacyActiveSessionSource[]
}>

// Bridges the durable, async delegated-work owner to synchronous Electron close/migration gates.
// It stores only active identities, so terminal mutations release their blocker immediately and
// completed Sessions do not accumulate in memory.
const createDelegatedActivityProjection = (): DelegatedActivityProjection => {
  const activeSessions = new Map<string, LegacyActiveSessionSource>()
  return {
    recordSession: (session) => {
      const key = JSON.stringify([session.projectId, session.id])
      if (hasCurrentRunningDelegatedAttempt(session)) {
        activeSessions.set(key, { projectId: session.projectId, sessionId: session.id })
      } else {
        activeSessions.delete(key)
      }
    },
    getActiveDelegatedSessions: () => Array.from(activeSessions.values())
  }
}

const sessionKey = (entry: LegacyActiveSessionSource): string =>
  JSON.stringify([entry.projectId, entry.sessionId])

// Delegated work supersedes an agent row for the same Session because it carries the stronger
// hard-blocking policy. Root and Side Chat prompts share one agent row for their parent Session.
// Notebook work remains distinct, so a Session can still appear once as delegated/agent and once as
// notebook.
export const detectActiveSessions = (deps: ActiveDetectionDeps): ActiveSessionInfo[] => {
  const delegatedSessions = deps.delegated.getActiveDelegatedSessions()
  const delegatedKeys = new Set(delegatedSessions.map(sessionKey))
  const agentSessions = new Map(
    [...deps.runtime.getActivePromptSessions(), ...deps.sideChat.getActivePromptSessions()].map(
      (entry) => [sessionKey(entry), entry] as const
    )
  )
  return [
    ...delegatedSessions.map((entry): ActiveSessionInfo => ({
      projectId: entry.projectId,
      sessionId: entry.sessionId,
      kind: 'delegated'
    })),
    ...[...agentSessions.entries()]
      .filter(([key]) => !delegatedKeys.has(key))
      .map(([, entry]): ActiveSessionInfo => ({
        projectId: entry.projectId,
        sessionId: entry.sessionId,
        kind: 'agent'
      })),
    ...deps.notebook.getActiveNotebookSessions().map((entry) => ({
      projectId: entry.projectId,
      sessionId: entry.sessionId,
      kind: 'notebook' as const
    }))
  ]
}

export { createDelegatedActivityProjection }
