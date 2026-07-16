// Aggregates the two authoritative sources of "actively running" sessions (an in-flight agent
// prompt, or a notebook cell mid-execution) so the storage-migration flow can warn the user before
// interrupting them. Pure function driven by structural deps so tests can pass fakes without
// constructing the real runtimes.

export type ActiveSessionInfo = {
  projectName: string
  sessionId: string
  kind: 'agent' | 'notebook'
  // Optional; main doesn't hold session titles — the renderer maps sessionId -> title.
  title?: string
}

type ActiveSessionSource = { projectName: string; sessionId: string }

type ActiveDetectionDeps = {
  runtime: { getActivePromptSessions(): ActiveSessionSource[] }
  notebook: { getActiveNotebookSessions(): ActiveSessionSource[] }
}

// No dedup: an agent prompt and a notebook cell are distinct concerns, and a session can
// legitimately have both running at once.
export const detectActiveSessions = (deps: ActiveDetectionDeps): ActiveSessionInfo[] => [
  ...deps.runtime.getActivePromptSessions().map((entry) => ({ ...entry, kind: 'agent' as const })),
  ...deps.notebook
    .getActiveNotebookSessions()
    .map((entry) => ({ ...entry, kind: 'notebook' as const }))
]
