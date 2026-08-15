import { useEffect, useState } from 'react'

import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'
import { resolveProjectId } from '../../../../shared/project-scope'

type NotebookRunSnapshot = {
  sessionId?: string
  runsById: ReadonlyMap<string, NotebookRunRecord>
}

const EMPTY_RUNS_BY_ID: ReadonlyMap<string, NotebookRunRecord> = new Map()

// Loads the bounded recent full-run window only into this mounted renderer. Transcript activities retain just runId,
// so image payloads never become session messages, agent context, or replay preamble content.
const useNotebookRunsById = (
  reference: NotebookSessionReference | undefined
): ReadonlyMap<string, NotebookRunRecord> => {
  const [snapshot, setSnapshot] = useState<NotebookRunSnapshot>({
    runsById: EMPTY_RUNS_BY_ID
  })
  const sessionId = reference?.sessionId
  const projectId = reference ? resolveProjectId(reference) : undefined
  const workspaceCwd = reference?.workspaceCwd

  useEffect(() => {
    if (!sessionId || !projectId || workspaceCwd === undefined) {
      return undefined
    }

    let active = true
    let loading = false
    let reloadQueued = false
    const load = async (): Promise<void> => {
      if (loading) {
        reloadQueued = true
        return
      }
      loading = true
      do {
        reloadQueued = false
        try {
          const state = await window.api.notebook.state({ sessionId, projectId, workspaceCwd })

          if (!active) return
          setSnapshot({
            sessionId,
            runsById: new Map(state.runs.map((run) => [run.runId, run]))
          })
        } catch (error) {
          if (!active) return
          console.warn('Notebook run preview hydration failed', error)
          setSnapshot({ sessionId, runsById: EMPTY_RUNS_BY_ID })
        }
      } while (active && reloadQueued)
      loading = false
    }

    void load()
    const stopChanged = window.api.notebook.onChanged((event) => {
      if (event.sessionId === sessionId) void load()
    })

    return () => {
      active = false
      stopChanged()
    }
  }, [projectId, sessionId, workspaceCwd])

  return snapshot.sessionId === sessionId ? snapshot.runsById : EMPTY_RUNS_BY_ID
}

export { useNotebookRunsById }
