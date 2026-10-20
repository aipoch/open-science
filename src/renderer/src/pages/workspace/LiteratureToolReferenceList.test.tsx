// @vitest-environment jsdom
import { createLiteratureTestRenderer } from '../../../../../test/renderer/literature'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureCatalogSearchPage } from '../../../../shared/literature'
import { LiteratureToolReferenceList } from './LiteratureToolReferenceList'
import { LiteratureCandidateSessionContext } from './literature-candidate-session-context'

const { render } = createLiteratureTestRenderer({
  get api() {
    return window.api
  },
  onRecovered: () => () => {}
})

const item = (id: string): LiteratureItemView => ({
  id,
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: `Paper ${id}`,
    abstract: `Abstract ${id}`,
    issuedYear: 2026
  })
})
const previousApi = window.api
const listeners = new Set<() => void>()
const search = vi.fn<(request: { itemIds?: string[] }) => Promise<LiteratureCatalogSearchPage>>()
const notify = async (): Promise<void> => {
  await act(async () => listeners.forEach((listener) => listener()))
}
beforeEach(() => {
  listeners.clear()
  search
    .mockReset()
    .mockImplementation(async ({ itemIds = [] }) => ({ entries: itemIds.map(item) }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        search,
        get: vi.fn(async (id: string) => item(id)),
        onChanged: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
})
const list = (ids: string[], sessionId = 'session'): React.JSX.Element => (
  <LiteratureCandidateSessionContext.Provider value={{ sessionId }}>
    <LiteratureToolReferenceList itemIds={ids} />
  </LiteratureCandidateSessionContext.Provider>
)

it('shows only three named references and loads additional metadata on demand', async () => {
  const ids = Array.from({ length: 16 }, (_, i) => String(i))
  const view = render(list([ids[0], ...ids]))
  const rows = await view.findByRole('list', { name: 'References' })
  expect(within(rows).getAllByRole('listitem')).toHaveLength(3)
  expect(search).toHaveBeenCalledWith({
    scope: 'library',
    itemIds: ids.slice(0, 3),
    limit: 100,
    offset: 0
  })
  fireEvent.click(view.getByRole('button', { name: 'Show more' }))
  await waitFor(() => expect(within(rows).getAllByRole('listitem')).toHaveLength(13))
  expect(search).toHaveBeenLastCalledWith({
    scope: 'library',
    itemIds: ids.slice(0, 13),
    limit: 100,
    offset: 0
  })
  fireEvent.click(view.getByRole('button', { name: 'Show less' }))
  await waitFor(() => expect(within(rows).getAllByRole('listitem')).toHaveLength(3))
})

it('opens the selected reference in a dialog without changing the route and restores focus', async () => {
  const view = render(list(['a', 'b']))
  const button = await view.findByRole('button', { name: 'Paper b' })
  const url = location.href
  button.focus()
  fireEvent.click(button)
  const dialog = await view.findByRole('dialog', { name: 'Paper b' })
  expect(within(dialog).getByText('Abstract b')).toBeDefined()
  expect(window.api.literature.get).toHaveBeenCalledWith('b')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(button))
  expect(location.href).toBe(url)
})

it('keeps a reference row mounted during refresh and rejects an obsolete same-list response', async () => {
  const view = render(list(['a']))
  const button = await view.findByRole('button', { name: 'Paper a' })
  let resolve!: (result: LiteratureCatalogSearchPage) => void
  search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await notify()
  expect(view.getByRole('button', { name: 'Paper a' })).toBe(button)
  search.mockResolvedValue({
    entries: [{ ...item('a'), item: { ...item('a').item, title: 'Updated paper' } }]
  })
  await notify()
  await view.findByRole('button', { name: 'Updated paper' })
  await act(async () => resolve({ entries: [item('a')] }))
  expect(view.queryByRole('button', { name: 'Paper a' })).toBeNull()
  view.unmount()
  expect(listeners.size).toBe(0)
})

it('shows unavailable references and retries failures without retaining stale links', async () => {
  const view = render(list(['a', 'b']))
  await view.findByRole('button', { name: 'Paper a' })
  search.mockRejectedValueOnce(new Error('offline'))
  await notify()
  await view.findByText('Could not load references.')
  expect(view.queryByRole('button', { name: 'Paper a' })).toBeNull()
  search.mockResolvedValue({ entries: [item('b')] })
  fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  await view.findByText('Reference unavailable')
  expect(view.getByRole('button', { name: 'Paper b' })).toBeDefined()
})

it('does not resolve historical references and resets reads when session identity changes', async () => {
  const view = render(<LiteratureToolReferenceList itemIds={['a']} />)
  expect(search).not.toHaveBeenCalled()
  view.rerender(
    <LiteratureCandidateSessionContext.Provider
      value={{ sessionId: 'fork', liveActivityIds: new Set(['new']) }}
    >
      <LiteratureToolReferenceList itemIds={['a']} activityId="old" />
    </LiteratureCandidateSessionContext.Provider>
  )
  expect(search).not.toHaveBeenCalled()
  let resolve!: (result: LiteratureCatalogSearchPage) => void
  search.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  view.rerender(list(['a']))
  view.rerender(list(['b'], 'another'))
  await view.findByRole('button', { name: 'Paper b' })
  await act(async () => resolve({ entries: [item('a')] }))
  expect(view.queryByRole('button', { name: 'Paper a' })).toBeNull()
})

it('follows response-budget pagination even when the requested ID batch is small', async () => {
  search
    .mockResolvedValueOnce({ entries: [item('a')], nextOffset: 1 })
    .mockResolvedValueOnce({ entries: [item('b'), item('c')] })
  const view = render(list(['a', 'b', 'c']))
  await view.findByRole('button', { name: 'Paper c' })
  expect(search).toHaveBeenLastCalledWith({
    scope: 'library',
    itemIds: ['a', 'b', 'c'],
    limit: 100,
    offset: 1
  })
  expect(view.queryByText('Reference unavailable')).toBeNull()
})

it('keeps an open detail and expanded list when another reference is imported', async () => {
  const ids = ['a', 'b', 'c', 'd']
  const view = render(list(ids))
  fireEvent.click(await view.findByRole('button', { name: 'Show more' }))
  fireEvent.click(await view.findByRole('button', { name: 'Paper d' }))
  await view.findByRole('dialog', { name: 'Paper d' })
  view.rerender(list([...ids, 'e']))
  expect(view.getByRole('dialog', { name: 'Paper d' })).toBeDefined()
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  await view.findByRole('button', { name: 'Paper d' })
  expect(view.getByRole('button', { name: 'Show less' })).toBeDefined()
})
