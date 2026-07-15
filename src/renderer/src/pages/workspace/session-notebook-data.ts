import type {
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionState
} from '../../../../shared/notebook'

// Minimal read-only slice of window.api.notebook the session viewer depends on.
type NotebookLoaderApi = {
  getReference: (request: NotebookSessionRequest) => Promise<NotebookSessionReference | null>
  state: (request: NotebookSessionRequest) => Promise<NotebookSessionState>
}

// Loads a session's persisted runs without spawning a kernel or creating run.json. Probe the
// read-only reference first: a session that never ran code returns [] here — no runtime is
// registered and no file is created. Only when a reference already exists do we read full state,
// which registers a lazy, un-spawned interpreter and reads the existing run.json (the Python
// process still starts only on execute, which this viewer never calls).
const loadSessionNotebookRuns = async (
  api: NotebookLoaderApi,
  request: NotebookSessionRequest
): Promise<NotebookRunRecord[]> => {
  const reference = await api.getReference(request)

  if (!reference) return []

  const state = await api.state(request)

  return state.runs
}

export { loadSessionNotebookRuns }
export type { NotebookLoaderApi }
