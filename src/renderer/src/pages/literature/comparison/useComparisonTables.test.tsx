// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComparisonTables } from './useComparisonTables'
const { comparisons, api } = vi.hoisted(() => {
  const comparisons = vi.fn()
  return { comparisons, api: { literature: { comparisons } } }
})
vi.mock('../renderer-host', () => ({ useLiteratureHost: () => ({ api }) }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const summary = {
  id: 'table',
  name: 'Evidence',
  state: 'running',
  memberCount: 1,
  total: 2,
  pending: 1,
  running: 0,
  succeeded: 1,
  failed: 0,
  unavailable: 0
}
const table = {
  id: 'table',
  revision: 1,
  members: [{ itemId: 'paper', sourceKey: 'final-source' }],
  fields: [],
  cells: [],
  state: 'running'
}
describe('comparison subscriptions', () => {
  it('uses the same pending scope for summaries from older hosts', async () => {
    const cells = [
      { id: 'revised', itemId: 'revised', status: 'pending', history: [{ id: 'old' }] },
      { id: 'new', itemId: 'new', status: 'unavailable', history: [] },
      { id: 'failed', itemId: 'failed', status: 'failed', history: [{ id: 'failed' }] },
      { id: 'missing', itemId: 'missing', status: 'unavailable', history: [{ id: 'missing' }] },
      { id: 'saved', itemId: 'saved', status: 'succeeded', history: [{ id: 'saved' }] }
    ]
    comparisons.mockResolvedValue({ tables: [{ ...table, cells }] })
    const { result } = renderHook(() => useComparisonTables())
    await waitFor(() =>
      expect(result.current.tables[0]?.pendingItemIds).toEqual(['revised', 'new'])
    )
  })
  it('polls summaries without requesting table data for background consumers', async () => {
    comparisons.mockResolvedValue({ tables: [], summaries: [summary] })
    const { result } = renderHook(() => useComparisonTables())
    await waitFor(() => expect(result.current.tables).toEqual([summary]))
    expect(comparisons.mock.calls).toEqual([[{ action: 'list' }]])
    expect(result.current.selectedTable).toBeUndefined()
  })
  it('merges selected pages and restarts if configuration revisions differ', async () => {
    let reads = 0
    comparisons.mockImplementation(async (request) => {
      if (request.action === 'list') return { tables: [], summaries: [summary] }
      reads += 1
      if (reads === 1)
        return { tables: [{ ...table, cells: [{ id: 'discarded' }] }], nextOffset: 10 }
      if (reads === 2) return { tables: [{ ...table, revision: 2, cells: [] }] }
      return request.offset === undefined
        ? { tables: [{ ...table, revision: 2, cells: [{ id: 'first' }] }], nextOffset: 10 }
        : { tables: [{ ...table, revision: 2, cells: [{ id: 'last' }] }] }
    })
    const { result } = renderHook(() => useComparisonTables('table'))
    await waitFor(() =>
      expect(result.current.selectedTable?.cells).toEqual([{ id: 'first' }, { id: 'last' }])
    )
    expect(reads).toBe(4)
    expect(result.current.selectedTable?.members).toEqual(table.members)
  })
  it('checks the first page on a poll and only rereads later pages when the revision changes', async () => {
    let revision = 1
    comparisons.mockImplementation(async (request) => {
      if (request.action === 'list') return { tables: [], summaries: [summary] }
      return request.offset === undefined
        ? { tables: [{ ...table, revision, cells: [] }], nextOffset: 10 }
        : { tables: [{ ...table, revision, cells: [{ id: 'last-' + revision }] }] }
    })
    const { result } = renderHook(() => useComparisonTables('table'))
    await waitFor(() => expect(result.current.selectedTable?.revision).toBe(1))
    const first = result.current.selectedTable
    comparisons.mockClear()
    await act(() => result.current.refresh())
    expect(result.current.selectedTable).toBe(first)
    expect(comparisons.mock.calls).toEqual([
      [{ action: 'list' }],
      [{ action: 'read', tableId: 'table' }]
    ])
    revision++
    await act(() => result.current.refresh())
    expect(result.current.selectedTable?.cells).toEqual([{ id: 'last-2' }])
  })
  it('polls only the validated summary while the complete matrix revision is current', async () => {
    let revision = 1
    comparisons.mockImplementation(async (request) =>
      request.action === 'list'
        ? { tables: [], summaries: [{ ...summary, revision }] }
        : { tables: [{ ...table, revision }] }
    )
    const { result } = renderHook(() => useComparisonTables('table'))
    await waitFor(() => expect(result.current.selectedTable?.revision).toBe(1))
    comparisons.mockClear()
    await act(() => result.current.refresh())
    expect(comparisons.mock.calls).toEqual([[{ action: 'list' }]])
    revision++
    await act(() => result.current.refresh())
    expect(result.current.selectedTable?.revision).toBe(2)
  })
  it('immediately restores a visited matrix and only rereads a changed revision', async () => {
    let revision = 1
    const release = Promise.withResolvers<void>()
    comparisons.mockImplementation(async ({ action, tableId }) => {
      if (action === 'list')
        return { tables: [], summaries: ['A', 'B'].map((id) => ({ ...summary, id, revision })) }
      if (revision === 2) await release.promise
      return { tables: [{ ...table, id: tableId, revision }] }
    })
    const { result, rerender } = renderHook(({ id }) => useComparisonTables(id), {
      initialProps: { id: 'A' }
    })
    await waitFor(() => expect(result.current.selectedTable?.id).toBe('A'))
    const first = result.current.selectedTable
    rerender({ id: 'B' })
    expect(result.current.selectedTable).toBeUndefined()
    await waitFor(() => expect(result.current.selectedTable?.id).toBe('B'))
    comparisons.mockClear()
    rerender({ id: 'A' })
    expect(result.current.selectedTable).toBe(first)
    await waitFor(() => expect(comparisons).toHaveBeenCalledWith({ action: 'list' }))
    expect(comparisons.mock.calls.some(([req]) => req.action === 'read')).toBe(false)
    revision = 2
    rerender({ id: 'B' })
    await waitFor(() => expect(comparisons).toHaveBeenCalledWith({ action: 'read', tableId: 'B' }))
    expect(result.current.selectedTable).toMatchObject({ id: 'B', revision: 1 })
    await act(async () => release.resolve())
    expect(result.current.selectedTable).toMatchObject({ id: 'B', revision: 2 })
  })
  it('coalesces slow refreshes and ignores a prior selection response', async () => {
    let resolveOld!: (value: unknown) => void
    comparisons.mockImplementation((request) =>
      request.action === 'list'
        ? Promise.resolve({ tables: [], summaries: [summary, { ...summary, id: 'new' }] })
        : request.tableId === 'table'
          ? new Promise((resolve) => {
              resolveOld = resolve
            })
          : Promise.resolve({ tables: [{ ...table, id: 'new' }] })
    )
    const { result, rerender } = renderHook(({ id }) => useComparisonTables(id), {
      initialProps: { id: 'table' }
    })
    await waitFor(() => expect(resolveOld).toBeDefined())
    const count = comparisons.mock.calls.length
    void result.current.refresh()
    expect(comparisons).toHaveBeenCalledTimes(count)
    rerender({ id: 'new' })
    await waitFor(() => expect(result.current.selectedTable?.id).toBe('new'))
    await act(async () => {
      resolveOld({ tables: [table] })
    })
    expect(result.current.selectedTable?.id).toBe('new')
  })
  it('reports a selected-table read failure and permits retry', async () => {
    let fail = true
    comparisons.mockImplementation(async (request) => {
      if (request.action === 'list') return { tables: [], summaries: [summary] }
      if (fail) throw new Error('offline')
      return { tables: [table] }
    })
    const { result } = renderHook(() => useComparisonTables('table'))
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.selectedTable).toBeUndefined()
    fail = false
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBe(false)
    expect(result.current.selectedTable?.id).toBe('table')
  })
  it.each([
    { conflict: false, switchAgain: false },
    { conflict: true, switchAgain: false },
    { conflict: false, switchAgain: true }
  ])(
    'refreshes the current selection after an old command settles (conflict=$conflict, switchAgain=$switchAgain)',
    async ({ conflict, switchAgain }) => {
      const oldCommand = Promise.withResolvers<void>()
      const delayedRead = Promise.withResolvers<void>()
      const reads: string[] = []
      const snapshots = ['table', 'B', 'C'].map((id) => ({ ...table, id }))
      let bReads = 0
      const error = new Error('comparison-config-changed')
      comparisons.mockImplementation(async (request) => {
        if (request.action === 'list')
          return { tables: [], summaries: snapshots.map(({ id }) => ({ ...summary, id })) }
        if (request.action === 'pause' || request.action === 'update') {
          await oldCommand.promise
          if (conflict) throw error
          return { tables: [table] }
        }
        reads.push(request.tableId)
        if (request.tableId === 'B' && ++bReads > 1) await delayedRead.promise
        return { tables: [snapshots.find(({ id }) => id === request.tableId)] }
      })
      const projections: (string | undefined)[] = []
      const { result, rerender } = renderHook(
        ({ id }) => {
          const value = useComparisonTables(id)
          projections.push(value.selectedTable?.id)
          return value
        },
        { initialProps: { id: 'table' } }
      )
      await waitFor(() => expect(result.current.selectedTable?.id).toBe('table'))
      const command = result.current
        .command(
          conflict
            ? {
                action: 'update',
                tableId: 'table',
                expectedRevision: 1,
                name: 'Draft',
                sourcePolicy: 'abstract',
                fields: []
              }
            : { action: 'pause', tableId: 'table' }
        )
        .catch((failure) => failure)
      rerender({ id: 'B' })
      await waitFor(() => expect(result.current.selectedTable?.id).toBe('B'))
      const start = projections.length
      await act(async () => oldCommand.resolve())
      await waitFor(() => expect(bReads).toBe(2))
      expect(result.current.selectedTable?.id).toBe('B')
      expect(projections.slice(start).every((id) => id === 'B')).toBe(true)
      expect(reads).toEqual(['table', 'B', 'B'])
      if (switchAgain) {
        rerender({ id: 'C' })
        await waitFor(() => expect(result.current.selectedTable?.id).toBe('C'))
      }
      await act(async () => {
        delayedRead.resolve()
        const outcome = await command
        if (conflict) expect(outcome).toBe(error)
      })
      expect(result.current.selectedTable?.id).toBe(switchAgain ? 'C' : 'B')
      expect(reads.filter((id) => id === 'table')).toHaveLength(1)
    }
  )
  it.each([false, true])(
    'applies an edit receipt when the full refresh fails without overwriting a newer snapshot (%s)',
    async (newerSnapshot) => {
      const first = { id: 'first' }
      const attempt = { id: 'attempt', value: 'Extracted result' }
      const saved = { value: 'A', confirmed: true, attemptId: attempt.id }
      const cell = { id: 'last', status: 'succeeded', history: [attempt], manual: saved }
      const edited = { value: 'B', confirmed: false }
      const releaseReceipt = Promise.withResolvers<void>()
      const newerManual = { ...saved, value: 'C' }
      let revision = 1
      let fail = false
      comparisons.mockImplementation(async (request) => {
        if (request.action === 'list') return { tables: [], summaries: [summary] }
        if (request.action === 'edit-cell') {
          await releaseReceipt.promise
          fail = true
          return {
            tables: [{ ...table, revision: 2, cells: [first] }],
            cell: { ...cell, status: 'running', history: [], manual: edited }
          }
        }
        if (fail) throw new Error('offline')
        const projection = { ...table, revision }
        const projectedCell = revision === 3 ? { ...cell, manual: newerManual } : cell
        return request.offset === undefined
          ? { tables: [{ ...projection, cells: [first] }], nextOffset: 10 }
          : { tables: [{ ...projection, cells: [projectedCell] }] }
      })
      const { result } = renderHook(() => useComparisonTables('table'))
      await waitFor(() => expect(result.current.selectedTable?.cells).toEqual([first, cell]))
      const command = result.current.command({
        action: 'edit-cell',
        tableId: 'table',
        cellId: cell.id,
        value: edited.value,
        confirmed: false,
        expectedFieldVersion: 1,
        expectedSourceKey: 'final-source'
      })
      if (newerSnapshot) {
        revision = 3
        await act(async () => {
          await result.current.refresh()
        })
        expect(result.current.selectedTable?.revision).toBe(3)
      }
      await act(async () => {
        releaseReceipt.resolve()
        await command
      })
      expect(result.current.error).toBe(true)
      expect(result.current.selectedTable?.revision).toBe(newerSnapshot ? 3 : 2)
      expect(result.current.selectedTable?.cells).toEqual([
        first,
        newerSnapshot
          ? { ...cell, manual: newerManual }
          : { ...cell, status: 'running', manual: edited }
      ])
    }
  )

  it.each([2, 3])(
    'applies an edit with revision %i without losing intervening changes',
    async (revision) => {
      const first = { id: 'first', status: 'succeeded', history: [{ id: 'history' }] }
      const second = { id: 'second', history: [] }
      const manual = { value: 'updated', confirmed: false }
      let saved = false
      comparisons.mockImplementation(async (req) => {
        if (req.action === 'list')
          return { tables: [], summaries: [{ ...summary, revision: saved ? revision : 1 }] }
        if (req.action === 'edit-cell') {
          saved = true
          return {
            tables: [{ ...table, revision, cells: [second] }],
            cell: { ...first, history: [], manual }
          }
        }
        return {
          tables: [
            {
              ...table,
              revision: saved ? revision : 1,
              cells: saved
                ? [
                    { ...first, manual },
                    { ...second, status: 'failed' }
                  ]
                : [first, second]
            }
          ]
        }
      })
      const { result } = renderHook(() => useComparisonTables('table'))
      await waitFor(() => expect(result.current.selectedTable?.revision).toBe(1))
      comparisons.mockClear()
      await act(async () => {
        await result.current.command({
          action: 'edit-cell',
          tableId: 'table',
          cellId: 'first',
          value: 'updated',
          confirmed: false,
          expectedFieldVersion: 1,
          expectedSourceKey: 'source'
        })
      })
      expect(result.current.selectedTable?.revision).toBe(revision)
      expect(result.current.selectedTable?.cells[0]).toEqual({ ...first, manual })
      expect(comparisons.mock.calls.filter(([req]) => req.action === 'read')).toHaveLength(
        revision === 2 ? 0 : 1
      )
      if (revision === 2) expect(result.current.selectedTable?.cells[1]).toBe(second)
      else expect(result.current.selectedTable?.cells[1].status).toBe('failed')
    }
  )
  it('clears a deleted selection without trying to read it again', async () => {
    let deleted = false
    comparisons.mockImplementation(async (request) => {
      if (request.action === 'list') return { tables: [], summaries: deleted ? [] : [summary] }
      if (request.action === 'delete') {
        deleted = true
        return { tables: [] }
      }
      if (deleted) throw new Error('comparison-not-found')
      return { tables: [table] }
    })
    const { result } = renderHook(() => useComparisonTables('table'))
    await waitFor(() => expect(result.current.selectedTable?.id).toBe('table'))
    await act(async () => {
      await result.current.command({ action: 'delete', tableId: 'table' })
    })
    expect(result.current.tables).toEqual([])
    expect(result.current.selectedTable).toBeUndefined()
    expect(result.current.error).toBe(false)
    expect(comparisons.mock.calls.filter(([request]) => request.action === 'read')).toHaveLength(1)
  })

  it('refreshes a configuration conflict without retrying the stale write or hiding its error', async () => {
    let conflicted = false
    const conflict = new Error('comparison-config-changed')
    comparisons.mockImplementation(async (request) => {
      if (request.action === 'list') return { tables: [], summaries: [summary] }
      if (request.action === 'update') {
        conflicted = true
        throw conflict
      }
      return { tables: [{ ...table, revision: conflicted ? 2 : 1 }] }
    })
    const { result } = renderHook(() => useComparisonTables('table'))
    await waitFor(() => expect(result.current.selectedTable?.revision).toBe(1))
    await act(async () => {
      await expect(
        result.current.command({
          action: 'update',
          tableId: 'table',
          expectedRevision: 1,
          name: 'Draft',
          sourcePolicy: 'full-text',
          fields: []
        })
      ).rejects.toBe(conflict)
    })
    expect(result.current.selectedTable?.revision).toBe(2)
    expect(comparisons.mock.calls.filter(([request]) => request.action === 'update')).toHaveLength(
      1
    )
  })

  it('reads paged history and export chunks without refreshing or publishing mutation events', async () => {
    comparisons.mockImplementation(async (request) =>
      request.action === 'list'
        ? { tables: [], summaries: [] }
        : request.action === 'read-cell'
          ? {
              tables: [],
              cell: { id: 'cell', history: [{ id: request.offset ? 'last' : 'first' }] },
              ...(request.offset ? {} : { nextOffset: 2 })
            }
          : { tables: [], csv: 'chunk' }
    )
    const changed = vi.fn()
    window.addEventListener('literature-comparisons-changed', changed)
    const { result } = renderHook(() => useComparisonTables())
    await waitFor(() => expect(comparisons).toHaveBeenCalledTimes(1))
    await act(async () => {
      expect((await result.current.loadCellHistory('table', 'cell')).history).toEqual([
        { id: 'first' },
        { id: 'last' }
      ])
      await result.current.command({ action: 'export', tableId: 'table', kind: 'matrix' })
    })
    expect(comparisons.mock.calls.filter(([request]) => request.action === 'list')).toHaveLength(1)
    expect(changed).not.toHaveBeenCalled()
    window.removeEventListener('literature-comparisons-changed', changed)
  })
})
