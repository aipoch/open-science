import { useCallback, useEffect, useRef, useState } from 'react'

import {
  NOTEBOOK_STATE_TARGET_RUN_LIMIT,
  type NotebookRunRecord,
  type NotebookSessionReference
} from '../../../../shared/notebook'
import { resolveProjectId } from '../../../../shared/project-scope'

type NotebookRunSnapshot = {
  scopeKey?: string
  runsById: ReadonlyMap<string, NotebookRunRecord>
}

const EMPTY_RUNS_BY_ID: ReadonlyMap<string, NotebookRunRecord> = new Map()
const MAX_HISTORICAL_RUN_CACHE = 20

type NotebookRunCache = {
  scopeKey?: string
  recentRunsById: Map<string, NotebookRunRecord>
  historicalRunsById: Map<string, NotebookRunRecord>
  protectedRunIds: ReadonlySet<string>
}

const trimHistoricalRuns = (
  cache: NotebookRunCache,
  protectedRunIds: ReadonlySet<string>
): void => {
  for (const runId of cache.historicalRunsById.keys()) {
    if (cache.historicalRunsById.size <= MAX_HISTORICAL_RUN_CACHE) break
    if (!protectedRunIds.has(runId)) cache.historicalRunsById.delete(runId)
  }
}

// Keeps the recent full-run window in this mounted renderer, then hydrates only historical runIds
// requested by transcript surfaces (expanded details or near-viewport figures). Image payloads never
// enter session messages or agent context. Historical records use a small LRU, except currently
// requested records remain protected.
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
  const scopeKey =
    sessionId && projectId && workspaceCwd !== undefined
      ? JSON.stringify([projectId, sessionId, workspaceCwd])
      : undefined
  const referencedRunIdsKey = JSON.stringify([...new Set(referencedRunIds)].sort())
  const cacheRef = useRef<NotebookRunCache>({
    recentRunsById: new Map(),
    historicalRunsById: new Map(),
    protectedRunIds: new Set()
  })

  const publish = useCallback((cache: NotebookRunCache): void => {
    if (cacheRef.current !== cache || !cache.scopeKey) return
    setSnapshot({
      scopeKey: cache.scopeKey,
      runsById: new Map([...cache.historicalRunsById, ...cache.recentRunsById])
    })
  }, [])

  useEffect(() => {
    if (!sessionId || !projectId || workspaceCwd === undefined) {
      cacheRef.current = {
        recentRunsById: new Map(),
        historicalRunsById: new Map(),
        protectedRunIds: new Set()
      }
      return undefined
    }

    const cache: NotebookRunCache = {
      scopeKey,
      recentRunsById: new Map(),
      historicalRunsById: new Map(),
      protectedRunIds: new Set()
    }
    cacheRef.current = cache
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
          const nextRecentRunsById = new Map(state.runs.map((run) => [run.runId, run]))
          for (const [runId, run] of cache.recentRunsById) {
            if (!nextRecentRunsById.has(runId) && cache.protectedRunIds.has(runId)) {
              cache.historicalRunsById.delete(runId)
              cache.historicalRunsById.set(runId, run)
            }
          }
          for (const runId of nextRecentRunsById.keys()) cache.historicalRunsById.delete(runId)
          cache.recentRunsById = nextRecentRunsById
          trimHistoricalRuns(cache, cache.protectedRunIds)
          publish(cache)
        } catch (error) {
          if (!active) return
          console.warn('Notebook run preview hydration failed', error)
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
  }, [projectId, publish, scopeKey, sessionId, workspaceCwd])

  useEffect(() => {
    if (!sessionId || !projectId || workspaceCwd === undefined) return undefined
    const cache = cacheRef.current
    if (cache.scopeKey !== scopeKey) return undefined

    const requestedRunIds = JSON.parse(referencedRunIdsKey) as string[]
    const protectedRunIds = new Set(requestedRunIds)
    cache.protectedRunIds = protectedRunIds
    trimHistoricalRuns(cache, protectedRunIds)
    publish(cache)
    const missingRunIds = requestedRunIds.filter(
      (runId) => !cache.recentRunsById.has(runId) && !cache.historicalRunsById.has(runId)
    )
    if (missingRunIds.length === 0) return undefined

    let active = true
    const hydrate = async (): Promise<void> => {
      for (
        let offset = 0;
        offset < missingRunIds.length;
        offset += NOTEBOOK_STATE_TARGET_RUN_LIMIT
      ) {
        const batch = missingRunIds.slice(offset, offset + NOTEBOOK_STATE_TARGET_RUN_LIMIT)
        try {
          const targetedState = await window.api.notebook.state({
            sessionId,
            projectId,
            workspaceCwd,
            runIds: batch
          })
          if (!active || cacheRef.current !== cache) return
          const batchIds = new Set(batch)
          for (const run of targetedState.runs) {
            if (!batchIds.has(run.runId)) continue
            cache.historicalRunsById.delete(run.runId)
            cache.historicalRunsById.set(run.runId, run)
          }
          trimHistoricalRuns(cache, cache.protectedRunIds)
          publish(cache)
        } catch (error) {
          if (!active) return
          console.warn('Notebook historical run hydration failed', error)
        }
      }
    }
    void hydrate()

    return () => {
      active = false
    }
  }, [projectId, publish, referencedRunIdsKey, scopeKey, sessionId, workspaceCwd])

  return snapshot.scopeKey === scopeKey ? snapshot.runsById : EMPTY_RUNS_BY_ID
}

export { useNotebookRunsById }
