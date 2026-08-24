// Aggregates the authoritative sources of "actively running" sessions (an in-flight root prompt,
// delegated Attempt, or notebook cell mid-execution) so the storage-migration and close/quit flows can warn
// the user before interrupting them. Pure function driven by structural deps so tests can pass fakes
// without constructing the real runtimes.

import type { ActiveSessionInfo } from '../../shared/storage'
export type { ActiveSessionInfo }

type LegacyActiveSessionSource = { projectId: string; sessionId: string }
type ActiveNotebookSessionSource = { projectId: string; sessionId: string }

type ActiveDetectionDeps = {
  runtime: { getActivePromptSessions(): LegacyActiveSessionSource[] }
  delegated: { getActiveDelegatedSessions(): LegacyActiveSessionSource[] }
  notebook: { getActiveNotebookSessions(): ActiveNotebookSessionSource[] }
}

// Delegated work supersedes a root-agent row for the same Session because it carries the stronger
// hard-blocking policy. Notebook work remains distinct, so a Session can still appear once as
// delegated/agent and once as notebook.
export const detectActiveSessions = (deps: ActiveDetectionDeps): ActiveSessionInfo[] => {
  const delegatedSessions = deps.delegated.getActiveDelegatedSessions()
  const delegatedKeys = new Set(
    delegatedSessions.map((entry) => JSON.stringify([entry.projectId, entry.sessionId]))
  )
  const rootSessions = deps.runtime
    .getActivePromptSessions()
    .filter((entry) => !delegatedKeys.has(JSON.stringify([entry.projectId, entry.sessionId])))
  return [
    ...delegatedSessions.map((entry): ActiveSessionInfo => ({
      projectId: entry.projectId,
      sessionId: entry.sessionId,
      kind: 'delegated'
    })),
    ...rootSessions.map((entry): ActiveSessionInfo => ({
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
