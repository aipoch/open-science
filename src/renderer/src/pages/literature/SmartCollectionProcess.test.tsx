// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SmartCollectionProcess } from './SmartCollectionProcess'
import { createSmartCollectionState } from './smart-collection-state'
import { WEB_EVENT_CONNECTION_STATE_EVENT } from '../../../../shared/web-event-connection'
import type {
  SmartCollectionView,
  SmartRunProgress
} from '../../../../shared/literature-smart-collections'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)
const transact = vi.fn()
let state: ReturnType<typeof createSmartCollectionState>
let snapshot: SmartRunProgress
const summary = (runId = 'run'): SmartCollectionView => ({
  scope: { kind: 'library' },
  sourceAvailable: true,
  configured: true,
  sourceName: '',
  overrides: 0,
  total: 2,
  matches: 0,
  pending: 2,
  counts: { match: 0, review: 0, 'no-match': 0, pending: 2 },
  rows: [],
  run: {
    id: runId,
    kind: 'refresh',
    state: 'running',
    done: 0,
    total: 2,
    inputTokens: 0,
    outputTokens: 0,
    usageIncomplete: false,
    updatedAt: 1
  }
})
const publish = (runId = 'run'): void => {
  state.finishWrite(summary(runId))
}
beforeEach(() => {
  state = createSmartCollectionState('collection')
  publish()
  snapshot = {
    runId: 'run',
    state: 'running',
    total: 2,
    done: 0,
    counts: { match: 0, review: 0, noMatch: 0, pending: 2, error: 0, unavailable: 0 },
    candidates: [{ id: 'paper', title: 'Candidate paper', state: 'pending' }],
    outcomes: []
  }
  transact.mockReset().mockImplementation(async () => ({
    kind: 'collection',
    id: 'collection',
    smartRunProgress: structuredClone(snapshot)
  }))
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { transact } } })
})
const finishPaper = (): void => {
  snapshot = {
    ...snapshot,
    done: 1,
    candidates: [],
    counts: { ...snapshot.counts, match: 1, pending: 1 },
    outcomes: [
      {
        id: 'paper',
        title: 'Committed paper',
        state: 'done',
        verdict: 'match',
        override: 'exclude'
      }
    ]
  }
}
it('moves only committed results and retains the manual-decision label', async () => {
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  await screen.findByText('Candidate paper')
  expect(transact).toHaveBeenCalledWith({
    kind: 'read-smart-run-progress',
    collectionId: 'collection',
    runId: 'run'
  })
  finishPaper()
  act(() => publish())
  await screen.findByText('Committed paper')
  expect(screen.queryByText('Candidate paper')).toBeNull()
  expect(screen.getByText('Manually excluded')).toBeTruthy()
})
it('refreshes title and manual labels when a settled paper changes without new results', async () => {
  finishPaper()
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  await screen.findByText('Committed paper')
  snapshot.outcomes = [{ ...snapshot.outcomes[0]!, title: 'Corrected title', override: 'include' }]
  act(() => publish())
  await screen.findByText('Corrected title')
  expect(screen.getByText('Manually included')).toBeTruthy()
  expect(screen.queryByText('Committed paper')).toBeNull()
  expect(screen.queryByText('Manually excluded')).toBeNull()
})

it('reflects paused analysis without exposing a separate display pause', async () => {
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  await screen.findByText('Candidate paper')
  snapshot.state = 'cancelled'
  act(() => publish())
  await screen.findByText(/^Paused/)
  expect(screen.queryByRole('button', { name: 'Pause display' })).toBeNull()
  expect(screen.getByText('Candidate paper')).toBeTruthy()
  snapshot.state = 'running'
  finishPaper()
  act(() => publish())
  await screen.findByText('Committed paper')
})
it('rejects a late response after the run changes', async () => {
  const oldSnapshot = structuredClone(snapshot)
  let release!: (value: unknown) => void
  transact.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  await waitFor(() => expect(transact).toHaveBeenCalledOnce())
  snapshot = {
    ...snapshot,
    runId: 'replacement',
    candidates: [{ id: 'other', title: 'Replacement paper', state: 'pending' }]
  }
  act(() => publish('replacement'))
  await screen.findByText('Replacement paper')
  await act(async () => release({ smartRunProgress: oldSnapshot }))
  expect(screen.queryByText('Candidate paper')).toBeNull()
  expect(screen.getByText('Replacement paper')).toBeTruthy()
})
it('keeps the last snapshot visible on read failure and retries without restarting analysis', async () => {
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  await screen.findByText('Candidate paper')
  transact.mockRejectedValueOnce(new Error('offline'))
  act(() => publish())
  await screen.findByText(
    'Run details could not be refreshed. Displayed results may be out of date.'
  )
  expect(screen.getByText('Candidate paper')).toBeTruthy()
  finishPaper()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Committed paper')
})
it.each([null, 'Paper without evidence'])(
  'shows unavailable papers separately: %s',
  async (title) => {
    snapshot = {
      ...snapshot,
      state: 'completed',
      done: 2,
      counts: { ...snapshot.counts, pending: 0, unavailable: 2 },
      candidates: [],
      outcomes: [{ id: 'unavailable', title, state: 'done' }]
    }
    render(<SmartCollectionProcess collectionId="collection" state={state} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Failed / unavailable' }))
    expect(
      within(screen.getByRole('article')).getByText(title ?? 'Reference unavailable')
    ).toBeTruthy()
    expect(screen.getAllByText('No recent results.')).toHaveLength(3)
  }
)
it('does not request run details until an update exists', () => {
  state = createSmartCollectionState('collection')
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  expect(screen.getByText('Start an update to see the screening process.')).toBeTruthy()
  expect(transact).not.toHaveBeenCalled()
})

it('preserves expanded review and keyboard focus while pausing and reconciling', async () => {
  snapshot.outcomes = [{ id: 'review', title: 'Review paper', state: 'done', verdict: 'uncertain' }]
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  await screen.findByText('Candidate paper')
  const disclosure = screen.getByRole('button', { name: 'Needs review' })
  fireEvent.click(disclosure)
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  disclosure.focus()
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(disclosure.isConnected).toBe(true)
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(disclosure)
})

it('defers replay and hidden-page reads until a fresh live reconciliation', async () => {
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  await screen.findByText('Candidate paper')
  const reads = transact.mock.calls.length
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, { detail: { phase: 'replaying' } })
    )
  })
  finishPaper()
  act(() => publish())
  expect(transact).toHaveBeenCalledTimes(reads)
  expect(screen.queryByText('Committed paper')).toBeNull()
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(WEB_EVENT_CONNECTION_STATE_EVENT, { detail: { phase: 'live' } })
    )
  })
  await screen.findByText('Committed paper')
  const currentReads = transact.mock.calls.length
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    publish()
  })
  expect(transact).toHaveBeenCalledTimes(currentReads)
  visibility.mockRestore()
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(transact.mock.calls.length).toBeGreaterThan(currentReads)
})

it('shows the final snapshot and has no display pause control', async () => {
  render(<SmartCollectionProcess collectionId="collection" state={state} />)
  await screen.findByText('Candidate paper')
  finishPaper()
  snapshot.state = 'completed'
  snapshot.counts.pending = 0
  act(() => {
    const completed = summary()
    completed.run!.state = 'completed'
    state.finishWrite(completed)
  })
  await screen.findByText('Committed paper')
  expect(screen.getByText(/^Completed/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Pause display' })).toBeNull()
})

it('shows a loading process instead of the previous run while analysis starts', () => {
  render(<SmartCollectionProcess collectionId="collection" state={state} starting />)
  expect(screen.getByRole('region', { name: 'Screening process' })).toBeTruthy()
  expect(screen.getByText('Loading…')).toBeTruthy()
  expect(transact).not.toHaveBeenCalled()
})
