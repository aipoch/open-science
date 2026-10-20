// @vitest-environment jsdom
import { createLiteratureTestRenderer } from '../../../../../test/renderer/literature'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNavigationStore } from '@/stores/navigation-store'
import type { LiteratureCandidateStatesResult } from '../../../../shared/literature'
import { LiteratureCandidateStatus } from './LiteratureCandidateStatus'
import { LiteratureCandidateSessionContext } from './literature-candidate-session-context'
import { buildLiteratureLibraryToolSummary } from './literature-tool-presentation'
import { WorkspaceLiteratureToolCard } from './WorkspaceLiteratureToolCard'

const { render } = createLiteratureTestRenderer({
  get api() {
    return window.api
  },
  onRecovered: () => () => {}
})

const reference = (id: string): LiteratureItemView => ({
  id,
  metadataRevision: 1,
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: `Reference ${id}` }),
  attachments: [],
  collectionIds: [],
  projectIds: [],
  createdAt: 1,
  updatedAt: 1
})
const previousApi = window.api
const read =
  vi.fn<(request: { candidateIds: string[] }) => Promise<LiteratureCandidateStatesResult>>()
const remove = vi.fn()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((listener) => listener())
beforeEach(() => {
  read.mockReset().mockResolvedValue({ candidates: [{ candidateId: 'a', state: 'pending' }] })
  remove.mockClear()
  listeners.clear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        search: vi.fn(async ({ itemIds }: { itemIds: string[] }) => ({
          entries: itemIds.map(reference)
        })),
        get: vi.fn(async (id: string) => reference(id)),
        getCandidateStates: read,
        onChanged: (listener: () => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
            remove()
          }
        }
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
})
const status = (ids = ['a'], sessionId: string | null = 'session'): React.JSX.Element => (
  <LiteratureCandidateSessionContext.Provider value={sessionId ? { sessionId } : null}>
    <LiteratureCandidateStatus candidateIds={ids} />
  </LiteratureCandidateSessionContext.Provider>
)

it('updates the real saved-tool card after import without rewriting its receipt', async () => {
  const output = { results: [{ kind: 'candidate', id: 'a', state: 'pending' }] }
  const original = JSON.stringify(output)
  const summary = buildLiteratureLibraryToolSummary('save', {}, output)
  const open = vi
    .spyOn(useNavigationStore.getState(), 'openLiteratureItem')
    .mockImplementation(() => {})
  const view = render(
    <LiteratureCandidateSessionContext.Provider value={{ sessionId: 'session' }}>
      <WorkspaceLiteratureToolCard summary={summary} />
    </LiteratureCandidateSessionContext.Provider>
  )
  expect(await view.findByText('Pending review: 1')).toBeDefined()
  read.mockResolvedValue({
    candidates: [{ candidateId: 'a', state: 'accepted', acceptedItemId: 'paper' }]
  })
  await act(async () => notify())
  expect(await view.findByText('Imported: 1')).toBeDefined()
  expect(view.queryByText('Pending review: 1')).toBeNull()
  expect(view.queryByRole('button', { name: 'Open Inbox' })).toBeNull()
  fireEvent.click(await view.findByRole('button', { name: 'Reference paper' }))
  expect(await view.findByRole('dialog', { name: 'Reference paper' })).toBeDefined()
  expect(open).not.toHaveBeenCalled()
  expect(summary.savedCount).toBe(1)
  expect(JSON.stringify(output)).toBe(original)
  view.unmount()
  render(status())
  expect(await view.findByText('Imported: 1')).toBeDefined()
})

it('distinguishes missing and deleted references from accepted, pending, and dismissed candidates', async () => {
  read.mockResolvedValue({
    candidates: [
      { candidateId: 'a', state: 'pending' },
      { candidateId: 'b', state: 'accepted', acceptedItemId: 'survivor' },
      { candidateId: 'c', state: 'dismissed' },
      { candidateId: 'd', state: 'accepted' }
    ]
  })
  const view = render(status(['a', 'a', 'b', 'c', 'd', 'missing']))
  expect(await view.findByText('Current status unavailable: 2')).toBeDefined()
  expect(view.getByText('Imported: 1')).toBeDefined()
  expect(view.getByText('Pending review: 1')).toBeDefined()
  expect(view.getByText('Dismissed: 1')).toBeDefined()
  expect(read).toHaveBeenCalledWith({ candidateIds: ['a', 'b', 'c', 'd', 'missing'] })
})

it('keeps the Inbox action mounted while focus revalidates the same candidates', async () => {
  const view = render(status())
  const button = await view.findByRole('button', { name: 'Open Inbox' })
  let resolve!: (result: LiteratureCandidateStatesResult) => void
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(view.getByRole('button', { name: 'Open Inbox' })).toBe(button)
  expect(view.getByRole('status').getAttribute('aria-busy')).toBe('true')
  await act(async () =>
    resolve({ candidates: [{ candidateId: 'a', state: 'accepted', acceptedItemId: 'paper' }] })
  )
  expect(view.queryByRole('button', { name: 'Open Inbox' })).toBeNull()
  expect(view.getByText('Imported: 1')).toBeDefined()
})

it('hides stale pending counts on failure and allows explicit retry', async () => {
  const view = render(status())
  await view.findByText('Pending review: 1')
  read.mockRejectedValueOnce(new Error('offline'))
  await act(async () => notify())
  expect(await view.findByText('Could not check current library status.')).toBeDefined()
  expect(view.queryByText('Pending review: 1')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  expect(await view.findByText('Pending review: 1')).toBeDefined()
})

it('ignores late responses after switching identities, refreshing, and unmounting', async () => {
  let resolve!: (result: LiteratureCandidateStatesResult) => void
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const view = render(status())
  read.mockResolvedValue({ candidates: [{ candidateId: 'b', state: 'dismissed' }] })
  view.rerender(status(['b'], 'other-session'))
  expect(await view.findByText('Dismissed: 1')).toBeDefined()
  await act(async () => resolve({ candidates: [{ candidateId: 'a', state: 'pending' }] }))
  expect(view.queryByText('Pending review: 1')).toBeNull()
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await act(async () => notify())
  await act(async () => window.dispatchEvent(new Event('open-science:web-events-open')))
  expect(await view.findByText('Dismissed: 1')).toBeDefined()
  await waitFor(() => expect(view.getByRole('status').getAttribute('aria-busy')).toBe('false'))
  await act(async () => resolve({ candidates: [{ candidateId: 'b', state: 'pending' }] }))
  expect(view.getByText('Dismissed: 1')).toBeDefined()
  expect(view.queryByText('Pending review: 1')).toBeNull()
  read.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  await act(async () => notify())
  view.unmount()
  const calls = read.mock.calls.length
  await act(async () => {
    resolve({ candidates: [] })
    notify()
    window.dispatchEvent(new Event('focus'))
  })
  expect(read).toHaveBeenCalledTimes(calls)
  expect(listeners.size).toBe(0)
})

it('revalidates after focus and reconnect and never resolves imported history locally', async () => {
  const view = render(status())
  await view.findByText('Pending review: 1')
  await act(async () => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  await act(async () => window.dispatchEvent(new Event('open-science:web-events-open')))
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  view.rerender(status(['a'], null))
  expect(view.getByText('Historical result; current library status is unavailable.')).toBeDefined()
  expect(view.queryByRole('button')).toBeNull()
  await act(async () => notify())
  expect(read).toHaveBeenCalledTimes(3)
})

it('keeps summary-only history neutral and bounds batch reads', async () => {
  const view = render(status([]))
  expect(read).not.toHaveBeenCalled()
  expect(view.queryByRole('button')).toBeNull()
  read.mockImplementation(async ({ candidateIds }) => ({
    candidates: candidateIds.map((candidateId) => ({ candidateId, state: 'pending' }))
  }))
  view.rerender(status(Array.from({ length: 201 }, (_, i) => `candidate-${i}`)))
  expect(await view.findByText('Pending review: 201')).toBeDefined()
  expect(read.mock.calls.map(([request]) => request.candidateIds.length)).toEqual([200, 1])
})

it('rechecks deleted, restored, and missing destinations without keeping failed navigation', async () => {
  const accepted = {
    candidates: [{ candidateId: 'a', state: 'accepted' as const, acceptedItemId: 'paper' }]
  }
  read.mockResolvedValue(accepted)
  const view = render(status())
  await view.findByRole('button', { name: 'Reference paper' })
  read.mockRejectedValueOnce(new Error('offline'))
  await act(async () => notify())
  await view.findByText('Could not check current library status.')
  expect(view.queryByRole('button', { name: 'Reference paper' })).toBeNull()
  read.mockResolvedValue({ candidates: [{ candidateId: 'a', state: 'accepted' }] })
  fireEvent(window, new Event('focus'))
  await view.findByText('Current status unavailable: 1')
  expect(view.queryByText(/Pending review:/)).toBeNull()
  read.mockResolvedValue(accepted)
  fireEvent(window, new Event('open-science:web-events-open'))
  await view.findByRole('button', { name: 'Reference paper' })
  read.mockResolvedValue({ candidates: [] })
  await act(async () => notify())
  await view.findByText('Current status unavailable: 1')
  expect(view.queryByRole('button')).toBeNull()
})

it('reads only each card’s candidate IDs on refresh and cleans up all subscriptions', async () => {
  read.mockImplementation(async ({ candidateIds }) => ({
    candidates: candidateIds.map((candidateId) => ({
      candidateId,
      state: 'accepted',
      acceptedItemId: `item-${candidateId}`
    }))
  }))
  const ids = Array.from({ length: 20 }, (_, index) => `saved-${index}`)
  const view = render(
    <LiteratureCandidateSessionContext.Provider value={{ sessionId: 'session' }}>
      {ids.map((id) => (
        <WorkspaceLiteratureToolCard
          key={id}
          summary={buildLiteratureLibraryToolSummary(
            'save',
            {},
            {
              results: [{ kind: 'candidate', id, state: 'pending' }]
            }
          )}
        />
      ))}
    </LiteratureCandidateSessionContext.Provider>
  )
  expect(await view.findAllByText('Imported: 1')).toHaveLength(20)
  expect(read.mock.calls.map(([request]) => request.candidateIds)).toEqual(ids.map((id) => [id]))
  await act(async () => {
    for (const listener of listeners) {
      listener()
      await Promise.resolve()
    }
  })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(40))
  expect(read.mock.calls.slice(20).map(([request]) => request.candidateIds)).toEqual(
    ids.map((id) => [id])
  )
  view.unmount()
  expect(listeners.size).toBe(0)
  fireEvent(window, new Event('focus'))
  await act(async () => notify())
  expect(read).toHaveBeenCalledTimes(40)
})
