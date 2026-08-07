import { useEffect, useState } from 'react'

import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'

type NotebookRunSnapshot = {
  sessionId?: string
  runsById: ReadonlyMap<string, NotebookRunRecord>
}

const EMPTY_RUNS_BY_ID: ReadonlyMap<string, NotebookRunRecord> = new Map()

// Loads full run records only into this mounted renderer. Transcript activities retain just runId,
// so image payloads never become session messages, agent context, or replay preamble content.
const useNotebookRunsById = (
  reference: NotebookSessionReference | undefined
): ReadonlyMap<string, NotebookRunRecord> => {
  const [snapshot, setSnapshot] = useState<NotebookRunSnapshot>({
    runsById: EMPTY_RUNS_BY_ID
  })
  const sessionId = reference?.sessionId
  const projectName = reference?.projectName
  const workspaceCwd = reference?.workspaceCwd

  useEffect(() => {
    if (!sessionId || !projectName || workspaceCwd === undefined) {
      return undefined
    }

    let active = true
    let requestSequence = 0
    const load = async (): Promise<void> => {
      const sequence = ++requestSequence

      try {
        const state = await window.api.notebook.state({ sessionId, projectName, workspaceCwd })

        if (!active || sequence !== requestSequence) return
        setSnapshot({
          sessionId,
          runsById: new Map(state.runs.map((run) => [run.runId, run]))
        })
      } catch (error) {
        if (!active || sequence !== requestSequence) return
        console.warn('Notebook run preview hydration failed', error)
        setSnapshot({ sessionId, runsById: EMPTY_RUNS_BY_ID })
      }
    }

    void load()
    const stopChanged = window.api.notebook.onChanged((event) => {
      if (event.sessionId === sessionId) void load()
    })

    return () => {
      active = false
      stopChanged()
    }
  }, [projectName, sessionId, workspaceCwd])

  return snapshot.sessionId === sessionId ? snapshot.runsById : EMPTY_RUNS_BY_ID
}

export { useNotebookRunsById }
