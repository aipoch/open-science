import { useEffect, useState } from 'react'

import type { NotebookRunRecord, NotebookSessionReference } from '../../../../shared/notebook'
import { resolveProjectId } from '../../../../shared/project-scope'

type NotebookRunSnapshot = {
  sessionId?: string
  runsById: ReadonlyMap<string, NotebookRunRecord>
}

const EMPTY_RUNS_BY_ID: ReadonlyMap<string, NotebookRunRecord> = new Map()

// Keeps the recent full-run window in this mounted renderer, then hydrates only historical runIds
// referenced by the mounted transcript. Image payloads never enter session messages or agent context.
const useNotebookRunsById = (
  reference: NotebookSessionReference | undefined,
  referencedRunIds: readonly string[] = []
): ReadonlyMap<string, NotebookRunRecord> => {
  const [snapshot, setSnapshot] = useState<NotebookRunSnapshot>({
    runsById: EMPTY_RUNS_BY_ID
  })
  const sessionId = reference?.sessionId
  const projectId = reference ? resolveProjectId(reference) : undefined
  const workspaceCwd = reference?.workspaceCwd
  const referencedRunIdsKey = JSON.stringify([...new Set(referencedRunIds)].sort())

  useEffect(() => {
    if (!sessionId || !projectId || workspaceCwd === undefined) {
      return undefined
    }

    let active = true
    let loading = false
    let reloadQueued = false
    const requestedRunIds = JSON.parse(referencedRunIdsKey) as string[]
    const historicalRunsById = new Map<string, NotebookRunRecord>()
    const attemptedRunIds = new Set<string>()
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
          const recentRunsById = new Map(state.runs.map((run) => [run.runId, run]))
          const missingRunIds = requestedRunIds.filter(
            (runId) => !recentRunsById.has(runId) && !attemptedRunIds.has(runId)
          )
          if (missingRunIds.length > 0) {
            const targetedState = await window.api.notebook.state({
              sessionId,
              projectId,
              workspaceCwd,
              runIds: missingRunIds
            })
            if (!active) return
            for (const runId of missingRunIds) attemptedRunIds.add(runId)
            const missingRunIdSet = new Set(missingRunIds)
            for (const run of targetedState.runs) {
              if (missingRunIdSet.has(run.runId)) historicalRunsById.set(run.runId, run)
            }
          }
          setSnapshot({
            sessionId,
            runsById: new Map([...historicalRunsById, ...recentRunsById])
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
  }, [projectId, referencedRunIdsKey, sessionId, workspaceCwd])

  return snapshot.sessionId === sessionId ? snapshot.runsById : EMPTY_RUNS_BY_ID
}

export { useNotebookRunsById }
