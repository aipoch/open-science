// Aggregates the two authoritative sources of "actively running" sessions (an in-flight agent
// prompt, or a notebook cell mid-execution) so the storage-migration and close/quit flows can warn
// the user before interrupting them. Pure function driven by structural deps so tests can pass fakes
// without constructing the real runtimes.

import type { ActiveSessionInfo } from '../../shared/storage'

export type { ActiveSessionInfo }

// The runtime layer calls the artifact/notebook storage key `projectName`, but it holds the project
// id; this module translates it to the honest `projectId` on the ActiveSessionInfo it exposes.
type ActiveSessionSource = { projectName: string; sessionId: string }

type ActiveDetectionDeps = {
  runtime: { getActivePromptSessions(): ActiveSessionSource[] }
  notebook: { getActiveNotebookSessions(): ActiveSessionSource[] }
}

// No dedup: an agent prompt and a notebook cell are distinct concerns, and a session can
// legitimately have both running at once.
export const detectActiveSessions = (deps: ActiveDetectionDeps): ActiveSessionInfo[] => [
  ...deps.runtime.getActivePromptSessions().map((entry) => ({
    projectId: entry.projectName,
    sessionId: entry.sessionId,
    kind: 'agent' as const
  })),
  ...deps.notebook.getActiveNotebookSessions().map((entry) => ({
    projectId: entry.projectName,
    sessionId: entry.sessionId,
    kind: 'notebook' as const
  }))
]
