// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useSearchResults } from './use-search-results'
import { useSearchSummaryCounts } from './use-search-summary-counts'
import type { SearchResult } from './search-result'
import type { Project } from '../../../../shared/projects'
import type { ProjectFilesChangedEvent } from '../../../../shared/project-files'

vi.mock('@/pages/literature/useLiteratureChanges', () => ({ useLiteratureChanges: () => {} }))
vi.mock('@/pages/literature/literature-read-pages', () => ({
  readLiteratureSelectionPage: vi.fn(async () => ({ entries: [], totalCount: 0 }))
}))
afterEach(cleanup)

const projects = (count: number): SearchResult[] =>
  Array.from({ length: count }, (_, i) => ({ kind: 'projects', item: { id: `p${i}` } as Project }))
const overview = { totalCount: 7, isIndexComplete: true }

it('loads only appended summary counts and refreshes the changed project', async () => {
  let changed!: (event: ProjectFilesChangedEvent) => void
  const unsubscribe = vi.fn()
  const getOverview = vi.fn(async () => overview)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectFiles: {
        getOverview,
        onChanged: (listener: typeof changed) => {
          changed = listener
          return unsubscribe
        }
      }
    }
  })
  const hook = renderHook(({ rows }) => useSearchSummaryCounts(true, rows), {
    initialProps: { rows: projects(10) }
  })
  await waitFor(() => expect(Object.keys(hook.result.current)).toHaveLength(10))
  hook.rerender({ rows: projects(20) })
  await waitFor(() => expect(Object.keys(hook.result.current)).toHaveLength(20))
  expect(getOverview).toHaveBeenCalledTimes(20)
  getOverview.mockResolvedValue({ ...overview, totalCount: 9 })
  act(() => changed({ projectId: 'p0' } as ProjectFilesChangedEvent))
  await waitFor(() => expect(hook.result.current['projects:p0']).toBe(9))
  expect(getOverview).toHaveBeenCalledTimes(21)
  getOverview.mockResolvedValue({ ...overview, totalCount: 12 })
  act(() => window.dispatchEvent(new Event('open-science:web-events-open')))
  await waitFor(() => expect(Object.values(hook.result.current)).toEqual(Array(20).fill(12)))
  expect(getOverview).toHaveBeenCalledTimes(41)
  hook.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  act(() => window.dispatchEvent(new Event('focus')))
  expect(getOverview).toHaveBeenCalledTimes(41)
})

it('keeps four count reads in flight across pagination and discards invalidated reads', async () => {
  let changed!: (event: ProjectFilesChangedEvent) => void
  const pending: (() => void)[] = []
  const getOverview = vi.fn(() => new Promise((resolve) => pending.push(() => resolve(overview))))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectFiles: {
        getOverview,
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        }
      }
    }
  })
  const hook = renderHook(({ rows }) => useSearchSummaryCounts(true, rows), {
    initialProps: { rows: projects(10) }
  })
  expect(getOverview).toHaveBeenCalledTimes(4)
  hook.rerender({ rows: projects(20) })
  expect(getOverview).toHaveBeenCalledTimes(4)
  act(() => changed({ projectId: 'p0' } as ProjectFilesChangedEvent))
  expect(getOverview).toHaveBeenCalledTimes(4)
  await act(async () => pending[0]!())
  expect(hook.result.current['projects:p0']).toBeUndefined()
  expect(getOverview).toHaveBeenCalledTimes(5)
  hook.unmount()
  await act(async () => pending.slice(1).forEach((resolve) => resolve()))
  expect(getOverview).toHaveBeenCalledTimes(5)
})

it('retains category pages and only refetches a changed effective refinement', async () => {
  const searchMessages = vi.fn(async () => ({ items: [], totalCount: 0, isComplete: true }))
  const searchArtifacts = vi.fn(async () => ({
    primary: { items: [], totalCount: 0 },
    isIndexComplete: true
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { sessions: { searchMessages }, projectFiles: { searchArtifacts } }
  })
  const scope = (category: string, role?: string): string =>
    JSON.stringify({ category, projectIds: ['p'], excludedSessionIds: [], role })
  const hook = renderHook(
    ({ category, role }: { category: string; role?: string }) =>
      useSearchResults(true, true, '', scope(category, role)),
    { initialProps: { category: 'all', role: undefined as string | undefined } }
  )
  await waitFor(() => expect(hook.result.current.pages.generated.loading).toBe(false))
  const page = hook.result.current.pages.generated
  hook.rerender({ category: 'messages', role: undefined })
  expect(hook.result.current.pages.generated).toBe(page)
  hook.rerender({ category: 'messages', role: 'user' })
  await waitFor(() => expect(searchMessages).toHaveBeenCalledTimes(2))
  expect(searchArtifacts).toHaveBeenCalledTimes(2)
  expect(hook.result.current.pages.generated).toBe(page)
})
