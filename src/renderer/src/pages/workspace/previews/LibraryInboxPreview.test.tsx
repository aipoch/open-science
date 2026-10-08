// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  literatureItemInputSchema,
  type LiteratureCatalogSearchRequest,
  type LiteratureInboxCandidateView
} from '../../../../../shared/literature'
import { LibraryInboxPreview } from './LibraryInboxPreview'
import LibraryPreview from './LibraryPreview'

const openLibrary = vi.hoisted(() => vi.fn())
vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: { getState: () => ({ openLibrary }) }
}))
const candidate = (id = 'candidate-1'): LiteratureInboxCandidateView => ({
  id,
  state: 'pending',
  createdAt: 1,
  updatedAt: 1,
  candidate: {
    item: literatureItemInputSchema.parse({
      title: `Paper ${id}`,
      itemType: 'journalArticle',
      abstract: 'Abstract detail'
    }),
    source: { provider: 'pubmed', rawMetadata: {} },
    origin: { kind: 'agent', projectId: 'other-project' }
  }
})
let rows: LiteratureInboxCandidateView[]
const listeners = new Set<() => void>()
const unsubscribe = vi.fn()
const search = vi.fn(async (request: LiteratureCatalogSearchRequest) => {
  const entries = rows.filter(
    (row) =>
      row.state === request.inboxState &&
      (!request.query || row.candidate.item.title.includes(request.query))
  )
  const offset = request.offset ?? 0
  const limit = request.limit ?? 20
  return {
    entries: entries.slice(offset, offset + limit),
    totalCount: entries.length,
    nextOffset: offset + limit < entries.length ? offset + limit : undefined
  }
})
const transact = vi.fn(
  async (command: { kind: string; candidateId?: string; candidateIds?: string[] }) => {
    if (command.kind === 'settle-candidates') {
      rows
        .filter(({ id }) => command.candidateIds?.includes(id))
        .forEach((row) => {
          row.state = 'accepted'
        })
      return
    }
    const row = rows.find(({ id }) => id === (command.candidateId ?? command.candidateIds?.[0]))!
    if (command.kind === 'restore-candidates' && row.state !== 'dismissed')
      throw new Error('Conflict')
    row.state =
      command.kind === 'accept-candidate'
        ? 'accepted'
        : command.kind === 'dismiss-candidate'
          ? 'dismissed'
          : 'pending'
  }
)
const settle = async (): Promise<void> => {
  await act(async () => {})
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
  }
}
const mount = (query = ''): ReturnType<typeof render> =>
  render(<LibraryInboxPreview query={query} onClearSearch={vi.fn()} openLiterature={openLibrary} />)
const click = async (name: string): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name }))
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  search.mockReset()
  transact.mockReset()
  listeners.clear()
  rows = [candidate()]
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        search,
        transact,
        onChanged: (listener: () => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
            unsubscribe()
          }
        }
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('selects the global Inbox and explicitly opens the full Inbox from the header', async () => {
  const { rerender } = render(
    <LibraryPreview
      projectId="project-a"
      isActive
      scopeRequest={{ collectionId: 'collection-a' }}
    />
  )
  await settle()
  await click('Inbox')
  expect(search).toHaveBeenLastCalledWith({
    scope: 'inbox',
    inboxState: 'pending',
    query: undefined,
    offset: 0,
    limit: 20
  })
  expect(screen.getByText('All projects')).toBeTruthy()
  expect(screen.getByText('Paper candidate-1')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Batch actions' })).toBeTruthy()
  await click('Open in Literature')
  expect(openLibrary).toHaveBeenCalledWith('user')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  await settle()
  expect(screen.getByText('No matching references')).toBeTruthy()
  rerender(<LibraryPreview projectId="project-a" isActive scopeRequest={{ section: 'inbox' }} />)
  await settle()
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  expect(screen.getByRole('button', { name: 'Inbox', pressed: true })).toBeTruthy()
  await click('Current project')
  expect(screen.getByRole('button', { name: 'Inbox', pressed: false })).toBeTruthy()
})

it('refreshes Agent saves and Web reconnects, and unsubscribes while the Preview is hidden', async () => {
  const { rerender } = render(<LibraryPreview isActive scopeRequest={{ section: 'inbox' }} />)
  await settle()
  rows.push(candidate('new'))
  await act(async () => {
    listeners.forEach((listener) => listener())
  })
  await settle()
  expect(screen.getByText('Paper new')).toBeTruthy()
  rows.push(candidate('reconnect'))
  await act(async () => {
    window.dispatchEvent(new Event('open-science:web-events-open'))
  })
  await settle()
  expect(screen.getByText('Paper reconnect')).toBeTruthy()
  rerender(<LibraryPreview isActive={false} scopeRequest={{ section: 'inbox' }} />)
  const reads = search.mock.calls.length
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  await settle()
  expect(search).toHaveBeenCalledTimes(reads)
  expect(unsubscribe).toHaveBeenCalled()
  rows.push(candidate('hidden'))
  rerender(<LibraryPreview isActive scopeRequest={{ section: 'inbox' }} />)
  await settle()
  expect(screen.getByText('Paper hidden')).toBeTruthy()
})

it('accepts without linking the current Workspace project and cannot replay a write on read retry', async () => {
  mount()
  await settle()
  search.mockRejectedValueOnce(new Error('Read offline'))
  await click('Accept')
  expect(transact).toHaveBeenCalledWith({ kind: 'accept-candidate', candidateId: 'candidate-1' })
  expect(screen.getByText('Could not load references.')).toBeTruthy()
  expect(screen.queryByText('Paper candidate-1')).toBeNull()
  await click('Retry')
  expect(screen.getByText('Inbox is clear')).toBeTruthy()
  expect(transact).toHaveBeenCalledTimes(1)
})

it('dismisses and restores each reference independently', async () => {
  rows.push(candidate('second'))
  mount()
  await settle()
  fireEvent.click(
    within(screen.getByRole('list', { name: 'Inbox' })).getAllByRole('button', {
      name: 'Dismiss'
    })[0]
  )
  await settle()
  await click('Dismiss')
  expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(2)
  expect(screen.getByText('Inbox is clear')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0])
  await settle()
  expect(transact).toHaveBeenLastCalledWith({
    kind: 'restore-candidates',
    candidateIds: ['candidate-1']
  })
  expect(screen.getByRole('button', { name: 'Paper candidate-1' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1)
})

it('keeps recovery after an uncertain dismissal without claiming the write failed or succeeded', async () => {
  mount()
  await settle()
  transact.mockImplementationOnce(async () => {
    rows[0].state = 'dismissed'
    throw new Error('Lost response')
  })
  await click('Dismiss')
  expect(
    screen.getByText('The update could not be confirmed. Check the Inbox before trying again.')
  ).toBeTruthy()
  expect(screen.queryByText('Dismissed from Inbox')).toBeNull()
  expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
  await click('Undo')
  expect(screen.getByRole('button', { name: 'Paper candidate-1' })).toBeTruthy()
})

it('reconciles an Undo conflict without restoring a reference accepted elsewhere', async () => {
  mount()
  await settle()
  await click('Dismiss')
  rows[0].state = 'accepted'
  await click('Undo')
  expect(rows[0].state).toBe('accepted')
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  expect(
    screen.getByText('The update could not be confirmed. Check the Inbox before trying again.')
  ).toBeTruthy()
})

it('guards repeated actions while the write is pending', async () => {
  let finish!: () => void
  transact.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  mount()
  await settle()
  const accept = screen.getByRole('button', { name: 'Accept' })
  fireEvent.click(accept)
  fireEvent.click(accept)
  expect(transact).toHaveBeenCalledTimes(1)
  expect((screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finish())
  await settle()
})

it('returns to the previous page after accepting the last reference on a later page', async () => {
  rows = Array.from({ length: 21 }, (_, i) => candidate(String(i)))
  mount()
  await settle()
  await click('Next page')
  expect(screen.getByText('Page 2')).toBeTruthy()
  await click('Accept')
  expect(screen.getByRole('button', { name: 'Paper 0' })).toBeTruthy()
  expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
  expect(screen.queryByRole('button', { name: 'Paper 20' })).toBeNull()
})

it('rejects an old read after a new search and keeps bounded search results', async () => {
  let finish!: (page: Awaited<ReturnType<typeof search>>) => void
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = mount()
  await settle()
  rerender(
    <LibraryInboxPreview query="missing" onClearSearch={vi.fn()} openLiterature={openLibrary} />
  )
  await settle()
  await act(async () =>
    finish({ entries: [candidate('stale')], totalCount: 1, nextOffset: undefined })
  )
  expect(screen.queryByText('Paper stale')).toBeNull()
  expect(screen.getByText('No matching references')).toBeTruthy()
})

it('uses the shared batch icon to select only explicit candidates and accept in one transaction', async () => {
  rows = [candidate('a'), candidate('b'), candidate('c')]
  render(<LibraryPreview isActive scopeRequest={{ section: 'inbox' }} />)
  await settle()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText(/Accepting will link to/)).toBeNull()
  await click('Batch actions')
  expect(screen.getAllByRole('checkbox')).toHaveLength(4)
  expect((screen.getByRole('button', { name: 'Accept' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper a' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper c' }))
  expect(screen.getByText('Selected: 2')).toBeTruthy()
  await click('Accept')
  expect(transact).toHaveBeenCalledExactlyOnceWith({
    kind: 'settle-candidates',
    candidateIds: ['a', 'c'],
    state: 'accepted'
  })
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(screen.getByRole('checkbox', { name: 'Select Paper b' })).toBeTruthy()
  expect(screen.getByText('Selected: 0')).toBeTruthy()
  await click('Done')
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
})

it('clears batch selection across search, pagination and mode changes and prunes settled candidates', async () => {
  rows = Array.from({ length: 21 }, (_, i) => candidate(String(i)))
  render(<LibraryPreview isActive scopeRequest={{ section: 'inbox' }} />)
  await settle()
  await click('Batch actions')
  const selectFirst = (): void => {
    fireEvent.click(within(screen.getByRole('list', { name: 'Inbox' })).getAllByRole('checkbox')[0])
  }
  selectFirst()
  await click('Next page')
  expect(screen.getByText('Selected: 0')).toBeTruthy()
  selectFirst()
  await click('Previous page')
  expect(screen.getByText('Selected: 0')).toBeTruthy()
  selectFirst()
  await click('Done')
  await click('Batch actions')
  expect(screen.getByText('Selected: 0')).toBeTruthy()
  selectFirst()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Paper 1' } })
  await settle()
  expect(screen.getByText('Selected: 0')).toBeTruthy()
  selectFirst()
  rows[1].state = 'accepted'
  await act(async () => {
    listeners.forEach((listener) => listener())
  })
  await settle()
  expect(screen.getByText('Selected: 0')).toBeTruthy()
  selectFirst()
  await click('Clear selection')
  expect(screen.getByText('Selected: 0')).toBeTruthy()
})

it('selects only the current Inbox page and reflects partial, full and cleared selection', async () => {
  rows = Array.from({ length: 21 }, (_, i) => candidate(String(i)))
  render(<LibraryPreview isActive scopeRequest={{ section: 'inbox' }} />)
  await settle()
  await click('Batch actions')
  const selectAll = (): HTMLInputElement =>
    screen.getByRole('checkbox', { name: 'Select all references' }) as HTMLInputElement
  expect(selectAll().checked).toBe(false)
  expect(selectAll().indeterminate).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper 0' }))
  expect(selectAll().indeterminate).toBe(true)
  fireEvent.click(selectAll())
  expect(screen.getByText('Selected: 20')).toBeTruthy()
  expect(selectAll().checked).toBe(true)
  expect(selectAll().indeterminate).toBe(false)
  fireEvent.click(selectAll())
  expect(screen.getByText('Selected: 0')).toBeTruthy()
  fireEvent.click(selectAll())
  await click('Clear selection')
  expect(selectAll().checked).toBe(false)
  fireEvent.click(selectAll())
  await click('Next page')
  expect(screen.getByText('Selected: 0')).toBeTruthy()
  expect(selectAll().checked).toBe(false)
  fireEvent.click(selectAll())
  expect(screen.getByText('Selected: 1')).toBeTruthy()
  await click('Accept')
  expect(transact).toHaveBeenCalledExactlyOnceWith({
    kind: 'settle-candidates',
    candidateIds: ['20'],
    state: 'accepted'
  })
  expect(rows.filter(({ state }) => state === 'pending')).toHaveLength(20)
})

it.each(['empty', 'failed'] as const)(
  'disables Inbox select all while loading and %s',
  async (state) => {
    rows = []
    if (state === 'failed') search.mockRejectedValueOnce(new Error('Offline'))
    render(
      <LibraryInboxPreview
        query=""
        batchMode
        onClearSearch={vi.fn()}
        openLiterature={openLibrary}
      />
    )
    const selectAll = (): HTMLInputElement =>
      screen.getByRole('checkbox', { name: 'Select all references' }) as HTMLInputElement
    expect(selectAll().disabled).toBe(true)
    await settle()
    expect(selectAll().disabled).toBe(true)
    expect(selectAll().checked).toBe(false)
    expect(selectAll().indeterminate).toBe(false)
  }
)

it('guards batch submission and reconciles a lost response without replaying on read retry', async () => {
  rows = [candidate('a'), candidate('b')]
  let finish!: () => void
  transact.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        finish = () => {
          rows[0].state = 'accepted'
          rows[1].state = 'accepted'
          reject(new Error('Lost batch response'))
        }
      })
  )
  render(<LibraryPreview isActive scopeRequest={{ section: 'inbox' }} />)
  await settle()
  await click('Batch actions')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all references' }))
  const accept = screen.getByRole('button', { name: 'Accept' })
  fireEvent.click(accept)
  fireEvent.click(accept)
  expect(transact).toHaveBeenCalledTimes(1)
  expect(
    screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).disabled)
  ).toBe(true)
  search.mockRejectedValueOnce(new Error('Read offline'))
  await act(async () => finish())
  await settle()
  expect(
    screen.getByText('The update could not be confirmed. Check the Inbox before trying again.')
  ).toBeTruthy()
  await click('Retry')
  expect(screen.getByText('Inbox is clear')).toBeTruthy()
  expect(transact).toHaveBeenCalledTimes(1)
})
