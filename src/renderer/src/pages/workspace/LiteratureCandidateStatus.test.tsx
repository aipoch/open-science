// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNavigationStore } from '@/stores/navigation-store'
import type { LiteratureCandidateStatesResult } from '../../../../shared/literature'
import { LiteratureCandidateStatus } from './LiteratureCandidateStatus'
import { LiteratureCandidateSessionContext } from './literature-candidate-session-context'
import { buildLiteratureLibraryToolSummary } from './literature-tool-presentation'
import { WorkspaceLiteratureToolCard } from './WorkspaceLiteratureToolCard'

const previousApi = window.api
const read =
  vi.fn<(request: { candidateIds: string[] }) => Promise<LiteratureCandidateStatesResult>>()
const remove = vi.fn()
let notify: () => void
beforeEach(() => {
  read.mockReset().mockResolvedValue({ candidates: [{ candidateId: 'a', state: 'pending' }] })
  remove.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        getCandidateStates: read,
        onChanged: (listener: () => void) => {
          notify = listener
          return remove
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
  <LiteratureCandidateSessionContext.Provider value={sessionId}>
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
    <LiteratureCandidateSessionContext.Provider value="session">
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
  fireEvent.click(view.getByRole('button', { name: 'Open reference' }))
  expect(open).toHaveBeenCalledWith('paper', 'user')
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
  view.unmount()
  const calls = read.mock.calls.length
  await act(async () => {
    resolve({ candidates: [] })
    notify()
    window.dispatchEvent(new Event('focus'))
  })
  expect(read).toHaveBeenCalledTimes(calls)
  expect(remove).toHaveBeenCalledOnce()
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
