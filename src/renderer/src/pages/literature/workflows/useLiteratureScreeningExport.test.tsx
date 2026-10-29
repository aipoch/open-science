// @vitest-environment jsdom
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import type { LiteratureRendererHost } from '../public/host'
import { useLiteratureScreeningExport } from './useLiteratureScreeningExport'
import type { SmartCollectionView } from '@aipoch/literature-screening/contracts'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const changes = new Set<() => void>()
const recoveries = new Set<() => void>()
const projectDeleted = new Set<() => void>()
const projectCleanup = new Set<() => void>()
const search = vi.fn()
const transact = vi.fn()
const saveBlobFile = vi.fn()
const exportRecord = vi.fn()
const host = {
  api: {
    literature: {
      search,
      transact,
      exportRecord,
      onChanged: (listener: () => void) => {
        changes.add(listener)
        return () => changes.delete(listener)
      }
    },
    projects: {
      onDeleted: (listener: () => void) => {
        projectDeleted.add(listener)
        return () => projectDeleted.delete(listener)
      },
      onDeletionCleanupChanged: (listener: () => void) => {
        projectCleanup.add(listener)
        return () => projectCleanup.delete(listener)
      }
    },
    saveBlobFile
  } as unknown as LiteratureRendererHost['api'],
  onRecovered: (listener: () => void) => {
    recoveries.add(listener)
    return () => recoveries.delete(listener)
  }
}
const { renderHook } = createLiteratureTestRenderer(host)
const view: SmartCollectionView = {
  scope: { kind: 'library' },
  sourceName: '',
  sourceAvailable: true,
  configured: false,
  total: 1,
  matches: 0,
  pending: 1,
  overrides: 0,
  counts: { match: 0, 'no-match': 0, review: 0, pending: 1 },
  rows: [{ id: 'paper', title: '中文 trial', verdict: 'pending' }]
}
const record = {
  id: 'paper',
  metadataRevision: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  createdAt: 1,
  updatedAt: 1,
  item: {
    itemType: 'journalArticle',
    title: '中文 trial',
    abstract: '',
    issuedText: '',
    containerTitle: '',
    shortTitle: '',
    language: '',
    rights: '',
    url: '',
    extra: '',
    typeFields: {},
    creators: [],
    identifiers: []
  }
}
const collections = ['smart', 'other'].map((id) => ({
  id,
  name: id,
  description: 'Adult trials',
  revision: 1,
  smart: true,
  itemCount: 0,
  createdAt: 1,
  updatedAt: 1
}))

afterEach(cleanup)
beforeEach(() => {
  changes.clear()
  recoveries.clear()
  projectDeleted.clear()
  projectCleanup.clear()
  search.mockReset().mockImplementation(async (request) => ({
    entries: request.scope === 'collections' ? collections : [record],
    totalCount: request.scope === 'collections' ? collections.length : 1
  }))
  transact.mockReset().mockImplementation(async (command) => ({
    kind: 'collection',
    id: command.collectionId,
    smart: { ...view, rows: command.summaryOnly ? [] : view.rows }
  }))
  saveBlobFile.mockReset().mockResolvedValue({ saved: true, filePath: '/tmp/screening.csv' })
  exportRecord.mockReset()
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it('deduplicates exports, saves complete BOM bytes, and keeps the fixed snapshot when the save dialog opens', async () => {
  const paused = deferred<{ entries: typeof collections }>()
  search.mockImplementationOnce(() => paused.promise)
  const save = deferred<{ saved: boolean }>()
  saveBlobFile.mockImplementationOnce(() => save.promise)
  const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
  let operation!: Promise<boolean>
  act(() => {
    operation = result.current.exportResults()
  })
  expect(result.current.exporting).toBe(true)
  await expect(result.current.exportResults()).resolves.toBe(false)
  await act(async () => {
    paused.resolve({ entries: collections })
  })
  await waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
  const request = saveBlobFile.mock.calls[0]![0]
  expect([...new Uint8Array(request.data).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(new TextDecoder().decode(request.data)).toContain('中文 trial')
  expect(request.suggestedName).toBe('smart-screening-results.csv')
  expect(request.mimeType).toBe('text/csv;charset=utf-8')
  // A later library edit cannot alter the bytes already handed to the save dialog.
  changes.forEach((notify) => notify())
  await act(async () => {
    save.resolve({ saved: true })
    expect(await operation).toBe(true)
  })
  expect(result.current.exporting).toBe(false)
  expect(result.current.error).toBeUndefined()
  expect(changes.size).toBe(0)
  expect(recoveries.size).toBe(0)
  expect(projectDeleted.size).toBe(0)
  expect(projectCleanup.size).toBe(0)
})

it.each(['change', 'recovery', 'focus', 'reconnect'] as const)(
  'rejects %s during reading without saving any partial file',
  async (event) => {
    const paused = deferred<{ entries: typeof collections }>()
    search.mockImplementationOnce(() => paused.promise)
    const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
    let operation!: Promise<boolean>
    act(() => {
      operation = result.current.exportResults()
    })
    if (event === 'change') changes.forEach((notify) => notify())
    if (event === 'recovery') recoveries.forEach((notify) => notify())
    if (event === 'focus') window.dispatchEvent(new Event('focus'))
    if (event === 'reconnect') window.dispatchEvent(new Event('open-science:web-events-open'))
    await act(async () => {
      paused.resolve({ entries: collections })
      expect(await operation).toBe(false)
    })
    expect(saveBlobFile).not.toHaveBeenCalled()
    expect(result.current.error).toBe('Screening data changed during export. Please try again.')
  }
)

it.each(['deleted', 'cleanup'] as const)(
  'rejects a project %s event during the final collection read without a literature event',
  async (event) => {
    const paused = deferred<{ entries: typeof collections }>()
    transact.mockImplementation(async (command) => ({
      kind: 'collection',
      id: command.collectionId,
      smart: {
        ...view,
        scope: { kind: 'project', id: 'project' },
        sourceName: 'Project',
        rows: command.summaryOnly ? [] : view.rows
      }
    }))
    search.mockImplementation(async (request) => {
      if (request.scope !== 'collections') return { entries: [record], totalCount: 1 }
      if (transact.mock.calls.some(([command]) => command.summaryOnly)) return paused.promise
      return { entries: collections }
    })
    const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
    let operation!: Promise<boolean>
    act(() => {
      operation = result.current.exportResults()
    })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(3))
    expect(view.matches).toBe(0)
    const listeners = event === 'deleted' ? projectDeleted : projectCleanup
    expect(listeners.size).toBe(1)
    listeners.forEach((notify) => notify())
    await act(async () => {
      paused.resolve({ entries: collections })
      expect(await operation).toBe(false)
    })
    expect(saveBlobFile).not.toHaveBeenCalled()
    expect(result.current.error).toBe('Screening data changed during export. Please try again.')
  }
)

it('does not publish an old failure into a different collection and lets that collection export', async () => {
  const paused = deferred<{ entries: typeof collections }>()
  search.mockImplementationOnce(() => paused.promise)
  const { result, rerender } = renderHook(({ id }) => useLiteratureScreeningExport(id), {
    initialProps: { id: 'smart' }
  })
  let old!: Promise<boolean>
  act(() => {
    old = result.current.exportResults()
  })
  const retainedExport = result.current.exportResults
  rerender({ id: 'other' })
  expect(changes.size).toBe(0)
  expect(result.current.exporting).toBe(false)
  await expect(retainedExport()).resolves.toBe(false)
  await act(async () => {
    expect(await result.current.exportResults()).toBe(true)
  })
  await act(async () => {
    paused.reject(new Error('old read failed'))
    expect(await old).toBe(false)
  })
  expect(result.current.error).toBeUndefined()
  expect(saveBlobFile).toHaveBeenCalledOnce()
  expect(saveBlobFile.mock.calls[0]![0].suggestedName).toBe('other-screening-results.csv')
})

it('removes listeners immediately on unmount and never saves the abandoned read', async () => {
  const paused = deferred<{ entries: typeof collections }>()
  search.mockImplementationOnce(() => paused.promise)
  const { result, unmount } = renderHook(() => useLiteratureScreeningExport('smart'))
  let operation!: Promise<boolean>
  act(() => {
    operation = result.current.exportResults()
  })
  unmount()
  expect(changes.size).toBe(0)
  expect(recoveries.size).toBe(0)
  paused.resolve({ entries: collections })
  expect(await operation).toBe(false)
  expect(saveBlobFile).not.toHaveBeenCalled()
})

it('reports a failed metadata read without saving and allows retry/cancellation', async () => {
  search
    .mockImplementationOnce(async () => ({ entries: collections }))
    .mockRejectedValueOnce(new Error('metadata read failed'))
  const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
  await act(async () => {
    expect(await result.current.exportResults()).toBe(false)
  })
  expect(result.current.error).toBe('Screening results could not be exported.')
  expect(saveBlobFile).not.toHaveBeenCalled()
  saveBlobFile.mockResolvedValueOnce({ saved: false })
  await act(async () => {
    expect(await result.current.exportResults()).toBe(false)
  })
  expect(saveBlobFile).toHaveBeenCalledOnce()
  expect(result.current.error).toBeUndefined()
})

it('hydrates oversized metadata through the existing digest checked record transfer', async () => {
  const { LITERATURE_OVERSIZED_REFERENCE } = await import('@aipoch/literature-library/client')
  search.mockImplementation(async (request) => {
    if (request.scope === 'collections') return { entries: collections }
    if (request.countOnly) return { entries: [], totalCount: 1 }
    throw new Error(`${LITERATURE_OVERSIZED_REFERENCE}paper`)
  })
  exportRecord.mockResolvedValue({ digest: 'a'.repeat(64), chunk: JSON.stringify(record) })
  const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
  await act(async () => {
    expect(await result.current.exportResults()).toBe(true)
  })
  expect(exportRecord).toHaveBeenCalledWith({ itemId: 'paper', offset: 0, digest: undefined })
  expect(new TextDecoder().decode(saveBlobFile.mock.calls[0]![0].data)).toContain('中文 trial')
})

it('adversarial: exports included excluded and pending candidates using filter-aware responses', async () => {
  const candidateRows = [
    { id: 'included', title: 'Included title', verdict: 'match' },
    { id: 'excluded', title: 'Excluded title', verdict: 'no-match' },
    { id: 'pending', title: 'Pending title', verdict: 'pending' }
  ]
  const metadata = candidateRows.map((row) => ({
    ...record,
    id: row.id,
    item: { ...record.item, title: row.title }
  }))
  search.mockImplementation(async (request) => ({
    entries:
      request.scope === 'collections' ? collections.map((c) => ({ ...c, itemCount: 1 })) : metadata,
    totalCount: request.scope === 'collections' ? collections.length : metadata.length
  }))
  transact.mockImplementation(async (command) => ({
    kind: 'collection',
    id: command.collectionId,
    smart: {
      ...view,
      total: 3,
      matches: 1,
      pending: 1,
      counts: { match: 1, 'no-match': 1, review: 0, pending: 1 },
      rows: command.summaryOnly
        ? []
        : candidateRows.filter(
            (row) => (command.filter ?? 'all') === 'all' || row.verdict === command.filter
          )
    }
  }))
  const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
  await act(async () => {
    expect(await result.current.exportResults()).toBe(true)
  })
  expect(saveBlobFile).toHaveBeenCalledOnce()
  const csv = new TextDecoder().decode(saveBlobFile.mock.calls[0]![0].data)
  for (const row of candidateRows) expect(csv).toContain(`"${row.id}","${row.title}"`)
  expect(csv.split('\r\n')).toHaveLength(5)
})

it('adversarial: rejects a collection-only event immediately in the final read window', async () => {
  const paused = deferred<{ entries: typeof collections }>()
  search.mockImplementation(async (request) => {
    if (request.scope !== 'collections') return { entries: [record], totalCount: 1 }
    if (transact.mock.calls.some(([command]) => command.summaryOnly)) return paused.promise
    return { entries: collections }
  })
  const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
  let operation!: Promise<boolean>
  act(() => {
    operation = result.current.exportResults()
  })
  await waitFor(() => expect(search).toHaveBeenCalledTimes(3))
  vi.useFakeTimers()
  try {
    for (const notify of changes)
      (notify as (event: unknown) => void)({ revision: 2, collectionIds: ['smart'] })
    await act(async () => {
      paused.resolve({ entries: collections })
      expect(await operation).toBe(false)
    })
    expect(saveBlobFile).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('adversarial: duplicate starts save once without relying on a timeout', async () => {
  const paused = deferred<{ entries: typeof collections }>()
  search.mockImplementationOnce(() => paused.promise)
  const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
  let first!: Promise<boolean>, second!: Promise<boolean>
  act(() => {
    first = result.current.exportResults()
    second = result.current.exportResults()
  })
  let duplicateResult!: boolean
  await act(async () => {
    duplicateResult = await second
  })
  await act(async () => {
    paused.resolve({ entries: collections })
    expect(await first).toBe(true)
  })
  expect(duplicateResult).toBe(false)
  expect(saveBlobFile).toHaveBeenCalledOnce()
})

it('adversarial: an old finally cannot unlock a new pending export', async () => {
  const oldRead = deferred<{ entries: typeof collections }>()
  search.mockImplementationOnce(() => oldRead.promise)
  const { result, rerender } = renderHook(({ id }) => useLiteratureScreeningExport(id), {
    initialProps: { id: 'smart' }
  })
  let old!: Promise<boolean>
  act(() => {
    old = result.current.exportResults()
  })
  rerender({ id: 'other' })
  const newRead = deferred<{ entries: typeof collections }>()
  search.mockImplementationOnce(() => newRead.promise)
  let current!: Promise<boolean>
  act(() => {
    current = result.current.exportResults()
  })
  await act(async () => {
    oldRead.reject(new Error('old read failed'))
    expect(await old).toBe(false)
  })
  let third!: boolean
  await act(async () => {
    third = await result.current.exportResults()
  })
  await act(async () => {
    newRead.resolve({ entries: collections })
    expect(await current).toBe(true)
  })
  expect(third).toBe(false)
  expect(saveBlobFile).toHaveBeenCalledOnce()
  expect(saveBlobFile.mock.calls[0]![0].suggestedName).toBe('other-screening-results.csv')
})

it('adversarial: a retained old callback cannot save after switching collections', async () => {
  const { result, rerender } = renderHook(({ id }) => useLiteratureScreeningExport(id), {
    initialProps: { id: 'smart' }
  })
  const retained = result.current.exportResults
  rerender({ id: 'other' })
  await act(async () => {
    expect(await retained()).toBe(false)
  })
  expect(saveBlobFile).not.toHaveBeenCalled()
})

it.each(['deleted', 'cleanup'] as const)(
  'adversarial: a project %s notification prevents save by behavior',
  async (event) => {
    const paused = deferred<{ entries: typeof collections }>()
    transact.mockImplementation(async (command) => ({
      kind: 'collection',
      id: command.collectionId,
      smart: {
        ...view,
        scope: { kind: 'project', id: 'project' },
        sourceName: 'Project',
        rows: command.summaryOnly ? [] : view.rows
      }
    }))
    search.mockImplementation(async (request) => {
      if (request.scope !== 'collections') return { entries: [record], totalCount: 1 }
      if (transact.mock.calls.some(([command]) => command.summaryOnly)) return paused.promise
      return { entries: collections }
    })
    const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
    let operation!: Promise<boolean>
    act(() => {
      operation = result.current.exportResults()
    })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(3))
    const listeners = event === 'deleted' ? projectDeleted : projectCleanup
    for (const notify of listeners) notify()
    await act(async () => {
      paused.resolve({ entries: collections })
      expect(await operation).toBe(false)
    })
    expect(saveBlobFile).not.toHaveBeenCalled()
  }
)

it('adversarial: rejects mixed-version oversized chunks without saving', async () => {
  const { LITERATURE_OVERSIZED_REFERENCE } = await import('@aipoch/literature-library/client')
  search.mockImplementation(async (request) => {
    if (request.scope === 'collections') return { entries: collections }
    if (request.countOnly) return { entries: [], totalCount: 1 }
    throw new Error(`${LITERATURE_OVERSIZED_REFERENCE}paper`)
  })
  const json = JSON.stringify(record),
    half = Math.floor(json.length / 2)
  exportRecord
    .mockResolvedValueOnce({ digest: 'a'.repeat(64), chunk: json.slice(0, half), nextOffset: half })
    .mockResolvedValueOnce({ digest: 'b'.repeat(64), chunk: json.slice(half) })
  const { result } = renderHook(() => useLiteratureScreeningExport('smart'))
  await act(async () => {
    expect(await result.current.exportResults()).toBe(false)
  })
  expect(saveBlobFile).not.toHaveBeenCalled()
})
