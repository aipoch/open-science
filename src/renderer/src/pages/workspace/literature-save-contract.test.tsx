// @vitest-environment jsdom
import { act, cleanup, render, renderHook, fireEvent, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { LiteratureChangedEvent } from '@aipoch/literature-library/contracts'
import { WorkspaceLiteratureToolCard } from './WorkspaceLiteratureToolCard'
import { buildLiteratureLibraryToolSummary } from './literature-tool-presentation'
import { LibraryPreviewNavigationContext } from './previews/library-reference-actions'
import { useNavigationStore } from '../../stores/navigation-store'
import { useLiteratureSaveState } from './use-literature-save-state'

it('keeps missing and deleted saved references neutral, and refreshes restored items', async () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    {},
    {
      results: [{ kind: 'candidate', id: 'saved', state: 'pending' }]
    }
  )
  let missing = false
  let available = true
  let fail = false
  const get = vi.fn(async () => {
    if (fail) throw new Error('Offline')
    return available ? { id: 'item' } : undefined
  })
  const previousApi = window.api
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      literature: {
        search: vi.fn(async ({ inboxState }: { inboxState: string }) => ({
          entries:
            !missing && inboxState === 'accepted'
              ? [{ id: 'saved', state: 'accepted', candidate: {}, acceptedItemId: 'item' }]
              : [],
          totalCount: missing ? 0 : 1
        })),
        get
      }
    }
  })
  try {
    const view = render(<WorkspaceLiteratureToolCard summary={summary} />)
    await waitFor(() => expect(view.getByText('Already in library: 1')).toBeDefined())
    fail = true
    await act(async () => fireEvent(window, new Event('focus')))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await expect(get.mock.results[1].value).rejects.toThrow('Offline')
    expect(view.getByText('Already in library: 1')).toBeDefined()
    fail = false
    available = false
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(view.queryByText('Already in library: 1')).toBeNull())
    expect(view.queryByRole('button', { name: 'Open reference' })).toBeNull()
    expect(view.queryByText(/Pending review:/)).toBeNull()
    expect(view.getByText('Other results: 1')).toBeDefined()
    available = true
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(view.getByText('Already in library: 1')).toBeDefined())
    missing = true
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(view.queryByText('Already in library: 1')).toBeNull())
    expect(view.queryByText(/Pending review:/)).toBeNull()
    expect(view.queryByRole('button', { name: 'Open Inbox' })).toBeNull()
    expect(summary.savedCount).toBe(1)
  } finally {
    cleanup()
    window.api = previousApi
  }
})

it('shares paged catalog reads across cards without caching them across refresh events', async () => {
  const search = vi.fn(
    async ({
      inboxState,
      offset = 0,
      limit
    }: {
      inboxState: string
      offset?: number
      limit: number
    }) =>
      inboxState === 'pending'
        ? {
            entries: Array.from({ length: limit }, (_, index) => ({
              id: `unrelated-${offset + index}`,
              state: 'pending',
              candidate: {}
            })),
            totalCount: 10_000,
            ...(offset + limit < 10_000 ? { nextOffset: offset + limit } : {})
          }
        : {
            entries: Array.from({ length: 20 }, (_, index) => ({
              id: `saved-${index}`,
              state: 'accepted',
              candidate: {},
              acceptedItemId: `item-${index}`
            })),
            totalCount: 20
          }
  )
  const get = vi.fn(async (id: string) => ({ id }))
  const listeners = new Set<(event: LiteratureChangedEvent) => void>()
  const previousApi = window.api
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      literature: {
        search,
        get,
        onChanged: (listener: (event: LiteratureChangedEvent) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
  try {
    const cards = Array.from({ length: 20 }, (_, index) =>
      renderHook(() =>
        useLiteratureSaveState(
          buildLiteratureLibraryToolSummary(
            'save',
            {},
            {
              results: [{ kind: 'candidate', id: `saved-${index}`, state: 'pending' }]
            }
          )
        )
      )
    )
    await waitFor(() =>
      cards.forEach(({ result }, index) =>
        expect(result.current.existingItemIds).toEqual([`item-${index}`])
      )
    )
    expect(search).toHaveBeenCalledTimes(101)
    expect(get).toHaveBeenCalledTimes(20)
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(40))
    expect(search).toHaveBeenCalledTimes(202)
    // Native event dispatch can run microtasks between listeners; synthetic focus does not.
    await act(async () => {
      for (const listener of listeners) {
        listener({ revision: 1, itemIds: ['unrelated'] })
        await Promise.resolve()
      }
    })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(60))
    expect(search).toHaveBeenCalledTimes(303)
    cleanup()
    expect(listeners.size).toBe(0)
    fireEvent(window, new Event('focus'))
    await act(async () => {})
    expect(search).toHaveBeenCalledTimes(303)
  } finally {
    cleanup()
    window.api = previousApi
  }
})

it('does not reuse an in-flight pre-change read when the same receipt refreshes', async () => {
  let resolveOld!: (page: { entries: object[]; totalCount: number }) => void
  const oldRead = new Promise<{ entries: object[]; totalCount: number }>((resolve) => {
    resolveOld = resolve
  })
  const search = vi
    .fn()
    .mockReturnValueOnce(oldRead)
    .mockResolvedValueOnce({ entries: [], totalCount: 0 })
    .mockResolvedValueOnce({
      entries: [{ id: 'saved', state: 'accepted', candidate: {}, acceptedItemId: 'item' }],
      totalCount: 1
    })
  const previousApi = window.api
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { literature: { search, get: vi.fn(async () => ({ id: 'item' })) } }
  })
  try {
    const { result } = renderHook(() =>
      useLiteratureSaveState(
        buildLiteratureLibraryToolSummary(
          'save',
          {},
          {
            results: [{ kind: 'candidate', id: 'saved', state: 'pending' }]
          }
        )
      )
    )
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    fireEvent(window, new Event('open-science:web-events-open'))
    await waitFor(() => expect(result.current.existingItemIds).toEqual(['item']))
    await act(async () =>
      resolveOld({
        entries: [{ id: 'saved', state: 'pending', candidate: {} }],
        totalCount: 1
      })
    )
    expect(result.current.savedCount).toBe(0)
    expect(search).toHaveBeenCalledTimes(3)
  } finally {
    cleanup()
    window.api = previousApi
  }
})

it('reconciles historical save receipts with current Inbox state on changes and remount', async () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    {},
    {
      results: [
        { kind: 'candidate', id: 'a', state: 'pending' },
        { kind: 'candidate', id: 'b', state: 'pending' }
      ]
    }
  )
  let accepted = false
  let allAccepted = false
  let dismissed = false
  let fail = false
  const listeners = new Set<(event: LiteratureChangedEvent) => void>()
  const search = vi.fn(async ({ inboxState, offset }: { inboxState?: string; offset?: number }) => {
    if (fail) throw new Error('Offline')
    const rows = [
      {
        id: 'a',
        state: dismissed ? 'dismissed' : accepted ? 'accepted' : 'pending',
        candidate: {},
        ...(accepted && !dismissed ? { acceptedItemId: 'item-a' } : {})
      },
      {
        id: 'b',
        state: allAccepted ? 'accepted' : 'pending',
        candidate: {},
        ...(allAccepted ? { acceptedItemId: 'item-b' } : {})
      },
      { id: 'unrelated', state: 'pending', candidate: {} }
    ].filter(({ state }) => state === inboxState)
    const start = offset ?? 0
    return {
      entries: rows.slice(start, start + 1),
      totalCount: rows.length,
      ...(start + 1 < rows.length ? { nextOffset: start + 1 } : {})
    }
  })
  const previousApi = window.api
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      literature: {
        search,
        get: vi.fn(async (id: string) => ({ id })),
        onChanged: (listener: (event: LiteratureChangedEvent) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
  })
  const navigate = vi
    .spyOn(useNavigationStore.getState(), 'openLiteratureItem')
    .mockImplementation(() => {})
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    await waitFor(() => expect(search).toHaveBeenCalled())
    expect(rendered.getByText('Pending review: 2')).toBeDefined()
    // An unsuccessful read must not turn a pending receipt into a library item.
    fail = true
    const readsBeforeFailure = search.mock.calls.length
    await act(async () => {
      listeners.forEach((listener) => listener({ revision: 1, candidateIds: ['a'] }))
    })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(readsBeforeFailure + 1))
    await expect(search.mock.results[readsBeforeFailure].value).rejects.toThrow('Offline')
    expect(rendered.queryByText('Already in library: 1')).toBeNull()
    fail = false
    accepted = true
    await act(async () => {
      listeners.forEach((listener) =>
        listener({ revision: 2, candidateIds: ['a'], itemIds: ['item-a'] })
      )
    })
    await waitFor(() => expect(rendered.getByText('Pending review: 1')).toBeDefined())
    expect(rendered.getByText('Already in library: 1')).toBeDefined()
    fireEvent.click(rendered.getByRole('button', { name: 'Open existing reference 1' }))
    expect(navigate).toHaveBeenCalledWith('item-a', 'user')
    expect(summary.savedCount).toBe(2) // The transcript receipt is immutable.
    rendered.unmount()
    expect(listeners.size).toBe(0)
    const remounted = render(<WorkspaceLiteratureToolCard summary={summary} />)
    await waitFor(() => expect(remounted.getByText('Pending review: 1')).toBeDefined())
    // Focus/reconnect reconciliation covers mutations missed while away.
    accepted = false
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(remounted.getByText('Pending review: 2')).toBeDefined())
    accepted = true
    allAccepted = true
    fireEvent(window, new Event('open-science:web-events-open'))
    await waitFor(() => expect(remounted.getByText('Already in library: 2')).toBeDefined())
    expect(remounted.queryByText(/Pending review:/)).toBeNull()
    expect(remounted.queryByRole('button', { name: 'Open Inbox' })).toBeNull()
    // Dismissal is not import, and another paper's state cannot affect this receipt.
    dismissed = true
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(remounted.getByText('Already in library: 1')).toBeDefined())
    expect(remounted.getByText('Other results: 1')).toBeDefined()
  } finally {
    cleanup()
    window.api = previousApi
    navigate.mockRestore()
  }
})

it('ignores a stale catalog read after switching receipt identities', async () => {
  const makeSummary = (id: string): ReturnType<typeof buildLiteratureLibraryToolSummary> =>
    buildLiteratureLibraryToolSummary(
      'save',
      {},
      {
        results: [{ kind: 'candidate', id, state: 'pending' }]
      }
    )
  let resolveOld!: (page: { entries: []; totalCount: number }) => void
  const oldRead = new Promise<{ entries: []; totalCount: number }>((resolve) => {
    resolveOld = resolve
  })
  const search = vi
    .fn()
    .mockReturnValueOnce(oldRead)
    .mockResolvedValueOnce({ entries: [], totalCount: 0 })
    .mockResolvedValueOnce({
      entries: [{ id: 'new', state: 'accepted', candidate: {}, acceptedItemId: 'new-item' }],
      totalCount: 1
    })
  const previousApi = window.api
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { literature: { search, get: vi.fn(async (id: string) => ({ id })) } }
  })
  try {
    const { result, rerender } = renderHook(({ summary }) => useLiteratureSaveState(summary), {
      initialProps: { summary: makeSummary('old') }
    })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    rerender({ summary: makeSummary('new') })
    await waitFor(() => expect(result.current.existingItemIds).toEqual(['new-item']))
    await act(async () => {
      resolveOld({ entries: [], totalCount: 0 })
    })
    expect(result.current.existingItemIds).toEqual(['new-item'])
    expect(search).toHaveBeenCalledTimes(3)
  } finally {
    cleanup()
    window.api = previousApi
  }
})

it('does not describe an existing library receipt as an Inbox save', () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    { refs: ['doi:10.1234/existing'] },
    {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            openScienceLiteraturePresentation: {
              libraryAction: 'save',
              candidateCount: 1,
              savedCount: 1,
              itemTitles: ['Existing item']
            }
          })
        },
        {
          type: 'text',
          text: JSON.stringify({ results: [{ kind: 'item', id: 'existing', state: 'present' }] })
        }
      ]
    }
  )
  const navigate = vi
    .spyOn(useNavigationStore.getState(), 'openLiteratureItem')
    .mockImplementation(() => {})
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    const card = rendered.getByTestId('literature-tool-card')
    expect(card.textContent).not.toContain('Inbox')
    expect(card.textContent).toContain('Already in library: 1')
    fireEvent.click(rendered.getByRole('button', { name: 'Open reference' }))
    expect(navigate).toHaveBeenCalledWith('existing', 'user')
  } finally {
    cleanup()
    navigate.mockRestore()
  }
})

it('shows mixed outcomes and opens the corresponding destinations', () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    { candidates: [{}, {}, {}, {}, {}] },
    {
      results: [
        { kind: 'candidate', id: 'pending', state: 'pending' },
        { kind: 'candidate', id: 'pending', state: 'pending' },
        { kind: 'item', id: 'existing', state: 'present' }
      ],
      failure: { inputIndex: 3, code: 'INBOX_SAVE_FAILED', message: 'Failed' }
    }
  )
  const inbox = vi.spyOn(useNavigationStore.getState(), 'openLibrary').mockImplementation(() => {})
  const existing = vi
    .spyOn(useNavigationStore.getState(), 'openLiteratureItem')
    .mockImplementation(() => {})
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    expect(rendered.getByText('Pending review: 1')).toBeDefined()
    expect(rendered.getByText('Already in library: 1')).toBeDefined()
    expect(rendered.getByText('Repeated inputs: 1')).toBeDefined()
    expect(rendered.getByText('Not attempted: 1')).toBeDefined()
    expect(
      rendered.getByText('Could not save reference 4. Earlier results are kept.')
    ).toBeDefined()
    fireEvent.click(rendered.getByRole('button', { name: 'Open Inbox' }))
    expect(inbox).toHaveBeenCalledWith('user')
    fireEvent.click(rendered.getByRole('button', { name: 'Open existing reference 1' }))
    expect(existing).toHaveBeenCalledWith('existing', 'user')
  } finally {
    cleanup()
    inbox.mockRestore()
    existing.mockRestore()
  }
})

it('does not infer destinations or pending counts from historical summary-only output', () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    { refs: ['doi:10.1234/paper'] },
    {
      openScienceLiteraturePresentation: { libraryAction: 'save', candidateCount: 1, savedCount: 1 }
    }
  )
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    expect(summary.savedCount).toBeUndefined()
    expect(rendered.queryAllByRole('button')).toHaveLength(0)
    expect(rendered.getByTestId('literature-tool-card').textContent).not.toContain('Pending review')
  } finally {
    cleanup()
  }
})

it('does not label dismissed receipts as pending review', () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    {},
    { results: [{ kind: 'candidate', id: 'dismissed', state: 'dismissed' }] }
  )
  expect(summary).toMatchObject({ savedCount: 0, otherCount: 1, existingItemIds: [] })
})

it('opens Inbox from a downloaded PDF receipt delivered through MCP text content', () => {
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    {},
    {
      content: [
        { type: 'text', text: JSON.stringify({ status: 'pending-review', candidateId: 'pdf-1' }) }
      ]
    }
  )
  const inbox = vi.spyOn(useNavigationStore.getState(), 'openLibrary').mockImplementation(() => {})
  try {
    const rendered = render(<WorkspaceLiteratureToolCard summary={summary} />)
    expect(rendered.getByText('PDF downloaded to Inbox')).toBeDefined()
    expect(rendered.getByText('Pending review: 1')).toBeDefined()
    fireEvent.click(rendered.getByRole('button', { name: 'Open Inbox' }))
    expect(inbox).toHaveBeenCalledWith('user')
  } finally {
    cleanup()
    inbox.mockRestore()
  }
})

it('opens the contextual Preview Inbox without navigating away or inferring a new destination', () => {
  const openPreview = vi.fn()
  const navigate = vi
    .spyOn(useNavigationStore.getState(), 'openLibrary')
    .mockImplementation(() => {})
  const summary = buildLiteratureLibraryToolSummary(
    'save',
    {},
    { results: [{ kind: 'candidate', id: 'pending', state: 'pending' }] }
  )
  try {
    const view = render(
      <LibraryPreviewNavigationContext.Provider value={openPreview}>
        <WorkspaceLiteratureToolCard summary={summary} />
      </LibraryPreviewNavigationContext.Provider>
    )
    fireEvent.click(view.getByRole('button', { name: 'Open Inbox' }))
    fireEvent.click(view.getByRole('button', { name: 'Open Inbox' }))
    expect(openPreview.mock.calls).toEqual([[{ section: 'inbox' }], [{ section: 'inbox' }]])
    expect(navigate).not.toHaveBeenCalled()
  } finally {
    cleanup()
    navigate.mockRestore()
  }
})
