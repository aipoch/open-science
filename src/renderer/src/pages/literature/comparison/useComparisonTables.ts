import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLiteratureHost } from '../renderer-host'
import {
  comparisonTaskReference,
  isPendingComparisonCell
} from '../../../../../shared/literature-comparison'
import type {
  ComparisonCell,
  ComparisonRequest,
  ComparisonResult,
  ComparisonTable,
  ComparisonTableSummary
} from '../../../../../shared/literature-comparison'

// A full read deserializes fresh objects, even for cells and field definitions that did not change.
function reuseUnchanged<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  const byId = new Map(previous.map((item) => [item.id, item]))
  const merged = incoming.map((item) => {
    const old = byId.get(item.id)
    return old && JSON.stringify(old) === JSON.stringify(item) ? old : item
  })
  return previous.length === merged.length && merged.every((item, i) => item === previous[i])
    ? previous
    : merged
}

// Matrices contain every cell, unlike the smaller catalog list pages.
const MATRIX_CACHE_SIZE = 4
type MatrixSnapshot = { table: ComparisonTable; latestRevision: number }

export function useComparisonTables(activeTableId?: string): {
  tables: ComparisonTableSummary[]
  selectedTable?: ComparisonTable
  error: boolean
  refresh: () => Promise<void>
  command: (request: ComparisonRequest) => Promise<ComparisonResult>
  loadCellHistory: (tableId: string, cellId: string) => Promise<ComparisonCell>
} {
  const { api } = useLiteratureHost()
  const [tables, setTables] = useState<ComparisonTableSummary[]>([])
  const [snapshots, setSnapshots] = useState(() => new Map<string, MatrixSnapshot>())
  const latest = useRef(snapshots)
  const publish = useCallback((next: Map<string, MatrixSnapshot>) => {
    latest.current = next
    setSnapshots(next)
  }, [])
  const remember = useCallback(
    (table: ComparisonTable, latestRevision = table.revision) => {
      const next = new Map(latest.current)
      next.delete(table.id)
      next.set(table.id, { table, latestRevision })
      if (next.size > MATRIX_CACHE_SIZE) next.delete(next.keys().next().value!)
      publish(next)
    },
    [publish]
  )
  const [failure, setFailure] = useState<{ tableId?: string }>()
  const sequence = useRef(0)
  const inFlight = useRef<{ sequence: number; promise: Promise<void> } | undefined>(undefined)
  const refresh = useCallback((): Promise<void> => {
    const generation = sequence.current
    if (inFlight.current?.sequence === generation) return inFlight.current.promise
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await api.literature.comparisons({ action: 'list' })
        if (generation !== sequence.current) return
        // Compatibility with older hosts; only summaries enter list consumers.
        const summaries =
          result.summaries ??
          (result.tables.map((table) => ({
            id: table.id,
            name: table.name,
            state: table.state,
            issue: table.issue,
            memberCount: table.itemIds?.length ?? 0,
            total: table.cells.length,
            reference: comparisonTaskReference(table),
            pendingItemIds: [
              ...new Set(table.cells.filter(isPendingComparisonCell).map((cell) => cell.itemId))
            ],
            ...Object.fromEntries(
              ['pending', 'running', 'succeeded', 'failed', 'unavailable'].map((status) => [
                status,
                table.cells.filter((cell) => cell.status === status).length
              ])
            )
          })) as ComparisonTableSummary[])
        setTables((current) =>
          JSON.stringify(current) === JSON.stringify(summaries) ? current : summaries
        )
        const removed = [...latest.current.keys()].filter(
          (id) => !summaries.some((table) => table.id === id)
        )
        if (removed.length) {
          const next = new Map(latest.current)
          for (const id of removed) next.delete(id)
          publish(next)
        }
        const selectedSummary = summaries.find((table) => table.id === activeTableId)
        if (activeTableId && selectedSummary) {
          const cached = latest.current.get(activeTableId)
          const complete =
            cached && cached.table.revision === cached.latestRevision ? cached.table : undefined
          if (
            selectedSummary.revision !== undefined &&
            complete &&
            complete.revision === selectedSummary.revision
          ) {
            if ([...latest.current.keys()].at(-1) !== activeTableId) remember(complete)
            setFailure(undefined)
            return
          }
          let loaded: ComparisonTable | undefined
          // A concurrent table change invalidates earlier pages. Retry a bounded number of times.
          for (let restart = 0; restart < 3; restart += 1) {
            let offset: number | undefined
            let revision: number | undefined
            const cells: ComparisonCell[] = []
            const sources: NonNullable<ComparisonTable['taskSources']> = []
            do {
              const page = await api.literature.comparisons({
                action: 'read',
                tableId: activeTableId,
                ...(offset === undefined ? {} : { offset })
              })
              if (generation !== sequence.current) return
              const table = page.tables[0]
              if (!table || table.id !== activeTableId) throw new Error('Missing comparison table')
              if (offset === undefined && complete && complete.revision === table.revision) {
                loaded = complete
                break
              }
              if (revision !== undefined && revision !== table.revision) {
                loaded = undefined
                break
              }
              revision = table.revision
              cells.push(...table.cells)
              sources.push(...(table.taskSources ?? []))
              loaded = { ...table, cells, taskSources: sources }
              if (page.nextOffset !== undefined && page.nextOffset <= (offset ?? 0))
                throw new Error('Invalid comparison page')
              offset = page.nextOffset
            } while (offset !== undefined)
            if (loaded) break
          }
          if (!loaded) throw new Error('Comparison changed during read')
          const previous = cached?.table
          if (previous?.id === loaded.id && previous !== loaded) {
            loaded = {
              ...loaded,
              cells: reuseUnchanged(previous.cells, loaded.cells),
              fields: reuseUnchanged(previous.fields, loaded.fields)
            }
          }
          if (loaded !== complete || [...latest.current.keys()].at(-1) !== activeTableId)
            remember(loaded)
        }
        setFailure(undefined)
      } catch {
        if (generation === sequence.current) setFailure({ tableId: activeTableId })
      } finally {
        if (inFlight.current?.sequence === generation) inFlight.current = undefined
      }
    })
    inFlight.current = { sequence: generation, promise }
    return promise
  }, [api, activeTableId, publish, remember])
  // A command can settle after navigation; refresh the committed selection, not its old closure.
  const currentRefresh = useRef(refresh)
  useLayoutEffect(() => {
    currentRefresh.current = refresh
  }, [refresh])
  useEffect(() => {
    sequence.current += 1
    const initial = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), 3000)
    window.addEventListener('literature-comparisons-changed', refresh)
    return () => {
      sequence.current += 1
      clearTimeout(initial)
      clearInterval(timer)
      window.removeEventListener('literature-comparisons-changed', refresh)
    }
  }, [refresh])
  const command = useCallback(
    async (request: ComparisonRequest): Promise<ComparisonResult> => {
      let result: ComparisonResult
      try {
        result = await api.literature.comparisons(request)
      } catch (error) {
        if (
          request.action === 'update' &&
          error instanceof Error &&
          error.message.includes('comparison-config-changed')
        ) {
          // Refresh the projection without rebasing the editor's retained draft.
          sequence.current += 1
          await currentRefresh.current()
        }
        throw error
      }
      if (!['list', 'read', 'read-cell', 'check-sources', 'export'].includes(request.action)) {
        // A mutation supersedes any partially assembled projection.
        sequence.current += 1
        if (request.action === 'edit-cell') {
          const edited = result.cell
          const projection = result.tables[0]
          if (edited?.id === request.cellId && projection?.id === request.tableId) {
            const cached = latest.current.get(projection.id)
            if (cached && projection.revision > cached.latestRevision) {
              const previous = cached.table
              const index = previous.cells.findIndex((cell) => cell.id === edited.id)
              if (index >= 0) {
                const cells = previous.cells.slice()
                cells[index] = { ...cells[index], status: edited.status, manual: edited.manual }
                // Only a consecutive receipt accounts for every change since the full read.
                const revision =
                  projection.revision === previous.revision + 1
                    ? projection.revision
                    : previous.revision
                remember({ ...previous, revision, cells }, projection.revision)
              }
            }
          }
        }
        const refreshed = currentRefresh.current()
        // Notify all listeners while this generation's refresh is still in flight.
        window.dispatchEvent(new Event('literature-comparisons-changed'))
        await refreshed
      }
      return result
    },
    [api, remember]
  )
  const loadCellHistory = useCallback(
    async (tableId: string, cellId: string): Promise<ComparisonCell> => {
      let offset: number | undefined
      let loaded: ComparisonCell | undefined
      const history: ComparisonCell['history'] = []
      do {
        const result = await api.literature.comparisons({
          action: 'read-cell',
          tableId,
          cellId,
          ...(offset === undefined ? {} : { offset })
        })
        if (!result.cell || result.cell.id !== cellId) throw new Error('Missing comparison cell')
        history.push(...result.cell.history)
        loaded = { ...result.cell, history }
        if (result.nextOffset !== undefined && result.nextOffset <= (offset ?? 0))
          throw new Error('Invalid history page')
        offset = result.nextOffset
      } while (offset !== undefined)
      return loaded!
    },
    [api]
  )
  return {
    tables,
    selectedTable: activeTableId ? snapshots.get(activeTableId)?.table : undefined,
    error: Boolean(failure && failure.tableId === activeTableId),
    refresh,
    command,
    loadCellHistory
  }
}
