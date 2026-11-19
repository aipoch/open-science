import { CitationLookupError } from './CitationLookupError'
// @vitest-environment jsdom
import { FileTypeIcon } from '@/pages/workspace/file-type-icon'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type {
  LiteratureRelatedRecord,
  LiteratureRelatedRequest,
  LiteratureRelatedResult
} from '@aipoch/literature-discovery/contracts'
import { LiteratureRelatedLookup } from './LiteratureRelatedLookup'

const { render } = createLiteratureTestRenderer({
  FileTypeIcon,
  get api() {
    return window.api
  }
})
const related = vi.fn<(request: LiteratureRelatedRequest) => Promise<LiteratureRelatedResult>>()
const transact = vi.fn()
const item: LiteratureItemView = {
  id: 'local',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Seed' })
}
const paperId = (letter: string): string => `europe-pmc:MED:${letter.charCodeAt(0)}`
const record = (letter: string): LiteratureRelatedRecord => ({
  paperId: paperId(letter),
  item: literatureItemInputSchema.parse({
    itemType: 'document',
    title: `Paper ${letter}`,
    url: `https://europepmc.org/article/MED/${letter.charCodeAt(0)}`
  })
})
const result = (extra: Partial<LiteratureRelatedResult> = {}): LiteratureRelatedResult => ({
  itemId: 'local',
  metadataRevision: 1,
  direction: 'references',
  state: 'ready',
  provider: 'europe-pmc',
  seed: record('a'),
  records: [record('b'), record('c')],
  resolutionToken: '00000000-0000-4000-8000-000000000000',
  ...extra
})
beforeEach(() => {
  related
    .mockReset()
    .mockImplementation(async (request) => result({ direction: request.direction }))
  transact.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: { related, transact, cancelRelated: vi.fn().mockResolvedValue(undefined) }
    }
  })
})
afterEach(() => {
  cleanup()
})
it('starts from one paper, switches relationship direction and stages only explicit selections', async () => {
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  expect(transact).not.toHaveBeenCalled()
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cited by' }), { button: 0, ctrlKey: false })
  await waitFor(() =>
    expect(related).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: 'local', direction: 'citations', offset: 0 })
    )
  )
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  transact.mockResolvedValue({ kind: 'candidate', id: 'candidate', state: 'pending' })
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact).toHaveBeenCalledTimes(1)
  expect(transact).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'stage-candidate',
      candidate: expect.objectContaining({
        source: expect.objectContaining({
          provider: 'europe-pmc',
          externalId: paperId('b')
        }),
        origin: { kind: 'manual-discovery' }
      })
    })
  )
})
it('reports duplicates, dismissed candidates and partial failures without auto-restoring', async () => {
  related.mockResolvedValue(result({ records: [record('b'), record('c'), record('d')] }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  for (const label of ['b', 'c', 'd'])
    fireEvent.click(screen.getByRole('checkbox', { name: `Select Paper ${label}` }))
  transact
    .mockResolvedValueOnce({ kind: 'item', id: 'saved', state: 'present' })
    .mockResolvedValueOnce({ kind: 'candidate', id: 'dismissed', state: 'dismissed' })
    .mockRejectedValueOnce(new Error('failed'))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('Could not add this reference. Try again.')
  expect(screen.getByText('Already in Library')).toBeTruthy()
  expect(screen.getByText('Previously dismissed; review it in Inbox.')).toBeTruthy()
  expect(transact.mock.calls.every(([command]) => command.kind === 'stage-candidate')).toBe(true)
  transact.mockResolvedValueOnce({ kind: 'candidate', id: 'retry', state: 'pending' })
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact).toHaveBeenCalledTimes(4)
})
it('appends unique results while preserving selections and retries failed pages in place', async () => {
  let finishRetry!: (value: LiteratureRelatedResult) => void
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ state: 'unavailable', records: [], issue: 'rate-limited' }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetry = resolve
        })
    )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  expect(screen.getByText('Loaded: 2')).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  const alert = await screen.findByRole('alert')
  expect(screen.getByText('Loaded: 2')).toBeTruthy()
  expect(
    (screen.getByRole('checkbox', { name: 'Select Paper b' }) as HTMLInputElement).checked
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('checkbox', { name: 'Select Paper b' })).toHaveProperty('checked', true)
  expect(screen.queryByText('Searching…')).toBeNull()
  await act(async () => finishRetry(result({ records: [record('b'), record('d')] })))
  await screen.findByText('Paper d')
  expect(screen.getByText('Loaded: 3')).toBeTruthy()
  expect(screen.getAllByText('Paper b')).toHaveLength(1)
  expect(screen.getByText('Paper c')).toBeTruthy()
  expect(
    (screen.getByRole('checkbox', { name: 'Select Paper b' }) as HTMLInputElement).checked
  ).toBe(true)
  expect(related).toHaveBeenLastCalledWith(
    expect.objectContaining({ offset: 20, resolutionToken: result().resolutionToken })
  )
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cited by' }), { button: 0, ctrlKey: false })
  await waitFor(() =>
    expect(related).toHaveBeenLastCalledWith(
      expect.objectContaining({ direction: 'citations', offset: 0 })
    )
  )
  expect(screen.queryByText('Paper d')).toBeNull()
})
it('bounds loaded list pages without discarding the selected papers', async () => {
  related.mockImplementation(async (request) =>
    result({
      records: [record(String.fromCharCode(98 + request.offset / 20))],
      nextOffset: request.offset + 20
    })
  )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  for (const letter of ['c', 'd', 'e', 'f']) {
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText(`Paper ${letter}`)
  }
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  expect(screen.getByText(/Loaded 5 pages for this direction/)).toBeTruthy()
  expect(screen.getByText('Loaded: 5')).toBeTruthy()
  expect(
    (screen.getByRole('checkbox', { name: 'Select Paper b' }) as HTMLInputElement).checked
  ).toBe(true)
  expect(related).toHaveBeenCalledTimes(5)
})

it('retains each direction scroll, selections and loaded pages without another request', async () => {
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ records: [record('d')] }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByText('Paper d')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper d' }))
  screen.getByRole('tabpanel').scrollTop = 123
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cited by' }), { button: 0, ctrlKey: false })
  await screen.findByText('Paper b')
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'References' }), {
    button: 0,
    ctrlKey: false
  })
  expect(screen.getByText('Loaded: 3')).toBeTruthy()
  expect(
    (screen.getByRole('checkbox', { name: 'Select Paper d' }) as HTMLInputElement).checked
  ).toBe(true)
  expect(screen.getByRole('tabpanel').scrollTop).toBe(123)
  expect(related).toHaveBeenCalledTimes(3)
})

it('uses graph identity merging for list counts and persists the actual retrieval time', async () => {
  const retrievedAt = 1700000000000
  const b = record('b'),
    c = record('c')
  b.item.identifiers = [{ scheme: 'doi', value: '10.1234/same', isPrimary: true }]
  c.item.identifiers = b.item.identifiers
  related.mockResolvedValue(
    result({
      records: [
        { ...b, retrievedAt },
        { ...c, retrievedAt }
      ]
    })
  )
  transact.mockResolvedValue({ kind: 'candidate', id: 'saved', state: 'pending' })
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Loaded: 1')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact.mock.calls[0][0].candidate.source.rawMetadata.retrievedAt).toBe(retrievedAt)
})

it('ignores an outstanding load-more request after navigating away', async () => {
  related.mockResolvedValueOnce(result({ nextOffset: 20 }))
  const view = render(
    <LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />
  )
  await screen.findByText('Paper b')
  let resolve!: (value: LiteratureRelatedResult) => void
  related.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  view.unmount()
  resolve(result())
  expect(transact).not.toHaveBeenCalled()
})
it('requires a fresh lookup when an appended page reports an expired seed', async () => {
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ state: 'unavailable', records: [], issue: 'expired' }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('alert')
  expect(
    (screen.getByRole('button', { name: 'Add selected to Inbox' }) as HTMLButtonElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Reload from starting paper' }))
  await waitFor(() =>
    expect(related).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, resolutionToken: undefined })
    )
  )
})

it('replaces the accessible loading placeholder when the first lookup finishes', async () => {
  let finish!: (value: LiteratureRelatedResult) => void
  related.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  const status = await screen.findByRole('status')
  expect(status.textContent).toContain('Searching…')
  expect(status.textContent).toContain('Papers referenced by this paper.')
  expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByRole('checkbox')).toBeNull()
  await act(async () => finish(result()))
  await screen.findByText('Paper b')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false')
})

it('does not flash a skeleton for a response within the loading delay', async () => {
  vi.useFakeTimers()
  try {
    let finish!: (value: LiteratureRelatedResult) => void
    related.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
    await act(async () => {})
    expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('true')
    await act(async () => vi.advanceTimersByTime(199))
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => finish(result()))
    await act(async () => vi.advanceTimersByTime(200))
    expect(screen.getByText('Paper b')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps the same notice mounted while switching tabs and retrying a limited request', async () => {
  related.mockResolvedValueOnce(
    result({ state: 'unavailable', records: [], issue: 'rate-limited' })
  )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  const notice = await screen.findByRole('alert')
  for (const action of ['switch', 'retry']) {
    let finish!: (value: LiteratureRelatedResult) => void
    related.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    vi.useFakeTimers()
    try {
      if (action === 'switch')
        fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cited by' }), {
          button: 0,
          ctrlKey: false
        })
      else fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await act(async () => vi.advanceTimersByTime(250))
      expect(screen.getByRole('alert')).toBe(notice)
      expect(screen.queryByText('Searching…')).toBeNull()
      expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(
        true
      )
      await act(async () =>
        finish(
          result({
            direction: 'citations',
            state: 'unavailable',
            records: [],
            issue: 'rate-limited'
          })
        )
      )
      expect(screen.getByRole('alert')).toBe(notice)
    } finally {
      vi.useRealTimers()
    }
  }
})

it('holds the parent save guard across the complete batch including failed items', async () => {
  const onSavingChange = vi.fn()
  const finishes: Array<(value: unknown) => void> = []
  transact.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)))
  render(
    <LiteratureRelatedLookup
      item={item}
      initialDirection="references"
      onSaved={vi.fn()}
      onSavingChange={onSavingChange}
    />
  )
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper c' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  expect(onSavingChange.mock.calls).toEqual([[true]])
  await act(async () => finishes[0]({ kind: 'candidate', id: 'first', state: 'pending' }))
  expect(transact).toHaveBeenCalledTimes(2)
  expect(onSavingChange.mock.calls).toEqual([[true]])
  await act(async () => finishes[1](Promise.reject(new Error('staging failed'))))
  expect(onSavingChange.mock.calls).toEqual([[true], [false]])
  expect(screen.getByText('In Inbox')).toBeTruthy()
  expect(screen.getByText('Could not add this reference. Try again.')).toBeTruthy()
})

it('starts the graph with a fresh lookup after the list token expires', async () => {
  related
    .mockImplementationOnce(async () => result({ nextOffset: 20 }))
    .mockImplementationOnce(async () =>
      result({ state: 'unavailable', records: [], issue: 'expired' })
    )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
  await screen.findByText('These results expired. Search again.')
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  await screen.findByRole('button', { name: 'Select Paper b' })
  await waitFor(() =>
    expect(related.mock.calls.slice(2).map(([r]) => r.direction)).toEqual([
      'references',
      'citations'
    ])
  )
  expect(related.mock.calls[2][0].resolutionToken).toBeUndefined()
})

it('lazily mounts the graph and preserves its selection and zoom across list switches without refetching', async () => {
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  expect(related).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('group', { name: 'Citation graph' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  await screen.findByRole('button', { name: 'Select Paper c' })
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  const zoom = svg.getAttribute('data-zoom')
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  expect(screen.queryByRole('group', { name: 'Citation graph' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Set as center' })).toBeNull()
  expect(screen.getByRole('checkbox', { name: 'Select Paper b' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  expect(screen.getByRole('button', { name: 'Select Paper b' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(screen.getByRole('group', { name: 'Citation graph' }).getAttribute('data-zoom')).toBe(zoom)
  expect(related).toHaveBeenCalledTimes(3)
  expect(transact).not.toHaveBeenCalled()
})
it('shares root invalidation with the cached list so returning cannot stage stale selections', async () => {
  related.mockImplementation(async (request) =>
    request.seedPaperId
      ? result({
          direction: request.direction,
          state: 'unavailable',
          issue: 'reference-changed',
          records: [],
          seed: undefined,
          resolutionToken: undefined
        })
      : result({ direction: request.direction })
  )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await waitFor(() =>
    expect(
      screen.getAllByText('This reference changed. Reopen its details and try again.').length
    ).toBeGreaterThan(0)
  )
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  expect(screen.getByRole('checkbox', { name: 'Select Paper b' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Add selected to Inbox' })).toHaveProperty(
    'disabled',
    true
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  expect(transact).not.toHaveBeenCalled()
})
it('releases a pending list transaction after a hidden child invalidates the root and stops the remaining batch', async () => {
  let failChild!: (value: LiteratureRelatedResult) => void
  let finishSave!: (value: unknown) => void
  const child = new Promise<LiteratureRelatedResult>((resolve) => {
    failChild = resolve
  })
  const transaction = new Promise((resolve) => {
    finishSave = resolve
  })
  related.mockImplementation(async (request) =>
    request.seedPaperId ? child : result({ direction: request.direction })
  )
  transact.mockReturnValue(transaction)
  const onSavingChange = vi.fn()
  render(
    <LiteratureRelatedLookup
      item={item}
      initialDirection="references"
      onSaved={vi.fn()}
      onSavingChange={onSavingChange}
    />
  )
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper c' }))
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await waitFor(() =>
    expect(related.mock.calls.some(([request]) => request.seedPaperId)).toBe(true)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await waitFor(() => expect(transact).toHaveBeenCalledTimes(1))
  await act(async () =>
    failChild(
      result({
        state: 'unavailable',
        issue: 'reference-changed',
        records: [],
        seed: undefined,
        resolutionToken: undefined
      })
    )
  )
  await act(async () => finishSave({ kind: 'candidate', id: 'saved', state: 'pending' }))
  await waitFor(() => expect(onSavingChange).toHaveBeenLastCalledWith(false))
  expect(transact).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Citation graph' })).toHaveProperty('disabled', false)
  expect(screen.getByRole('button', { name: 'Add selected to Inbox' })).toHaveProperty(
    'disabled',
    true
  )
})

const epRecord = (source: string, id: string, title: string): LiteratureRelatedRecord => ({
  paperId: `europe-pmc:${source}:${id}`,
  item: literatureItemInputSchema.parse({
    itemType: 'document',
    title,
    url: `https://europepmc.org/article/${source}/${id}`
  })
})
const epResult = (request: LiteratureRelatedRequest): LiteratureRelatedResult => ({
  ...result({ direction: request.direction }),
  provider: 'europe-pmc',
  seed: request.seedPaperId
    ? epRecord('PMC', 'PMC2', 'EP neighbor')
    : epRecord('MED', '1', 'EP root'),
  records: [
    request.seedPaperId
      ? epRecord('MED', '3', 'EP descendant')
      : epRecord('PMC', 'PMC2', 'EP neighbor')
  ]
})
const ocRecord = (id: string, title: string): LiteratureRelatedRecord => ({
  paperId: `opencitations:br/${id}`,
  item: literatureItemInputSchema.parse({
    itemType: 'document',
    title,
    url: `https://w3id.org/oc/meta/br/${id}`
  })
})
const ocResult = (request: LiteratureRelatedRequest): LiteratureRelatedResult => ({
  ...result({ direction: request.direction }),
  provider: 'opencitations',
  ...(request.opencitationsMode ? { opencitationsMode: request.opencitationsMode } : {}),
  seed: request.seedPaperId ? ocRecord('2', 'OC neighbor') : ocRecord('1', 'OC root'),
  records: [request.seedPaperId ? ocRecord('3', 'OC descendant') : ocRecord('2', 'OC neighbor')]
})
const chooseSource = (name: string): void => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Citation source' }))
  fireEvent.click(screen.getByRole('option', { name }))
}

function renderIndexLookup(element: Parameters<typeof render>[0]): ReturnType<typeof render> {
  const view = render(element)
  chooseSource('OpenCitations · Index v2')
  return view
}

it.each([
  ['Europe PMC', 'europe-pmc'],
  ['OpenCitations · SKG-IF', 'opencitations']
] as const)(
  'shows the selected %s source while list and graph requests are pending',
  async (name, provider) => {
    const actualProvider = provider
    let finish!: (value: LiteratureRelatedResult) => void
    let finishGraph!: (value: LiteratureRelatedResult) => void
    related.mockImplementationOnce(() => new Promise(() => undefined))
    related.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    related.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishGraph = resolve
        })
    )
    related.mockImplementation(async (request) =>
      provider === 'europe-pmc'
        ? epResult(request)
        : actualProvider === 'opencitations'
          ? ocResult(request)
          : result({ direction: request.direction, provider: actualProvider })
    )
    renderIndexLookup(
      <LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />
    )
    expect(screen.getByText('Source: OpenCitations · Index v2')).toBeTruthy()
    await waitFor(() => expect(related).toHaveBeenCalledTimes(1))
    chooseSource(name)
    await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
    expect(screen.getByText(`Source: ${name}`)).toBeTruthy()
    expect(screen.queryByText('Automatic (Europe PMC first)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
    expect(
      screen.getAllByText(`Source: ${name}`).filter((element) => !element.closest('[hidden]'))
    ).toHaveLength(1)
    expect(screen.queryByText('Automatic (Europe PMC first)')).toBeNull()
    await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
    expect(related.mock.calls[1][0].provider).toBe(actualProvider)
    if (actualProvider === 'opencitations')
      expect(related.mock.calls[1][0].opencitationsMode).toBe('skg-if')
    await act(async () =>
      finish(
        provider === 'europe-pmc'
          ? epResult(related.mock.calls[1][0])
          : actualProvider === 'opencitations'
            ? ocResult(related.mock.calls[1][0])
            : result({ provider: actualProvider })
      )
    )
    expect(
      screen.queryByRole('button', {
        name: `Select ${provider === 'europe-pmc' ? 'EP' : 'OC'} neighbor`
      })
    ).toBeNull()
    await act(async () =>
      finishGraph(
        provider === 'europe-pmc'
          ? epResult(related.mock.calls[2][0])
          : ocResult(related.mock.calls[2][0])
      )
    )
    await screen.findByRole('button', {
      name:
        provider === 'europe-pmc'
          ? 'Select EP neighbor'
          : actualProvider === 'opencitations'
            ? 'Select OC neighbor'
            : 'Select Paper b'
    })
    expect(
      screen.getAllByText(`Source: ${name}`).filter((element) => !element.closest('[hidden]'))
    ).toHaveLength(1)
    expect(transact).not.toHaveBeenCalled()
  }
)

it('defaults to Europe PMC routing and pins the actual source across list, graph and unsaved centers', async () => {
  related.mockImplementation(async (request) => epResult(request))
  transact.mockResolvedValue({ kind: 'candidate', id: 'ep', state: 'pending' })
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('EP neighbor')
  expect(related.mock.calls[0][0].provider).toBe('europe-pmc')
  expect(screen.getByText('Source: Europe PMC')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Configure API key' })).toBeNull()
  expect(transact).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select EP neighbor' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact.mock.calls[0][0].candidate.source).toMatchObject({
    provider: 'europe-pmc',
    externalId: 'europe-pmc:PMC:PMC2',
    sourceUrl: 'https://europepmc.org/article/PMC/PMC2',
    rawMetadata: {
      rootItemId: 'local',
      rootMetadataRevision: 1,
      seedPaperId: 'europe-pmc:MED:1',
      direction: 'references'
    }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  const neighbor = await screen.findByRole('button', { name: 'Select EP neighbor' })
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  fireEvent.click(neighbor)
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await screen.findByRole('button', { name: 'Select EP descendant' })
  await waitFor(() => expect(related).toHaveBeenCalledTimes(5))
  expect(related.mock.calls.slice(1).every(([request]) => request.provider === 'europe-pmc')).toBe(
    true
  )
  expect(related.mock.calls[3][0].seedPaperId).toBe('europe-pmc:PMC:PMC2')
  expect(transact).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Selected paper' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await waitFor(() => expect(transact).toHaveBeenCalledTimes(2))
  expect(transact.mock.calls[1][0].candidate.source).toMatchObject({
    provider: 'europe-pmc',
    externalId: 'europe-pmc:PMC:PMC2',
    sourceUrl: 'https://europepmc.org/article/PMC/PMC2',
    rawMetadata: { origin: 'exploration-center', exploredPaperId: 'europe-pmc:PMC:PMC2' }
  })
})

it('keeps the default Europe PMC source after unavailable results across list and graph', async () => {
  related.mockImplementation(async (request) => ({
    ...epResult(request),
    state: 'unavailable',
    seed: undefined,
    records: [],
    issue: 'unavailable'
  }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByRole('alert')
  expect(screen.getByText('Source: Europe PMC')).toBeTruthy()
  expect(screen.queryByText('Automatic (Europe PMC first)')).toBeNull()
  fireEvent.click(screen.getByRole('combobox', { name: 'Citation source' }))
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    'Europe PMC',
    'OpenCitations · SKG-IF',
    'OpenCitations · Index v2'
  ])
  fireEvent.keyDown(screen.getByRole('option', { name: 'Europe PMC' }), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  expect(related.mock.calls.every(([request]) => request.provider === 'europe-pmc')).toBe(true)
  expect(transact).not.toHaveBeenCalled()
})

it.each([
  ['Europe PMC', 'europe-pmc', 'EP', epResult],
  ['OpenCitations · SKG-IF', 'opencitations', 'OC', ocResult]
] as const)(
  'switches %s with fresh list and graph caches, blocks switching during save and ignores the old source response',
  async (name, provider, prefix, providerResult) => {
    let finishOld!: (value: LiteratureRelatedResult) => void
    related.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    related.mockImplementation(async (request) =>
      request.provider === provider && request.opencitationsMode !== 'index'
        ? providerResult(request)
        : {
            ...ocResult(request),
            seed: ocRecord('101', 'Paper a'),
            records: [ocRecord('102', 'Paper b'), ocRecord('103', 'Paper c')]
          }
    )
    let finishSave!: (value: unknown) => void
    transact.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve
        })
    )
    renderIndexLookup(
      <LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />
    )
    await waitFor(() => expect(related).toHaveBeenCalledTimes(1))
    chooseSource(name)
    await screen.findByText(`${prefix} neighbor`)
    await act(async () => finishOld(result()))
    expect(screen.getByText(`Source: ${name}`)).toBeTruthy()
    expect(screen.queryByText('Paper b')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${prefix} neighbor` }))
    fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
    expect(screen.getByRole('combobox', { name: 'Citation source' })).toHaveProperty(
      'disabled',
      true
    )
    await act(async () => finishSave({ kind: 'candidate', id: 'saved', state: 'pending' }))
    await screen.findByText('In Inbox')
    fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
    fireEvent.click(await screen.findByRole('button', { name: `Select ${prefix} neighbor` }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Set as center' })).toHaveProperty(
        'disabled',
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
    await screen.findByRole('button', { name: `Select ${prefix} descendant` })
    chooseSource('OpenCitations · Index v2')
    await screen.findByRole('button', { name: 'Select Paper b' })
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.queryByRole('button', { name: `Select ${prefix} neighbor` })).toBeNull()
    expect(screen.queryByText('In Inbox')).toBeNull()
    expect(
      screen
        .getAllByText('Source: OpenCitations · Index v2')
        .filter((element) => !element.closest('[hidden]'))
    ).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    await screen.findByText('Paper b')
    expect(screen.queryByText(`${prefix} neighbor`)).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Select Paper b' })).toHaveProperty(
      'checked',
      false
    )
  }
)

it.each([
  ['Europe PMC', 'europe-pmc', undefined, 'EP', epResult],
  ['OpenCitations · SKG-IF', 'opencitations', 'skg-if', 'OC', ocResult],
  ['OpenCitations · Index v2', 'opencitations', 'index', 'OC', ocResult]
] as const)(
  'loads the graph while the first %s list request is still pending',
  async (name, provider, mode, prefix, providerResult) => {
    let finishList: ((response: LiteratureRelatedResult) => void) | undefined
    let listRequest: LiteratureRelatedRequest | undefined
    related.mockImplementation(async (request) => {
      if (request.provider === provider && request.opencitationsMode === mode) {
        if (!listRequest) {
          listRequest = request
          return new Promise((resolve) => {
            finishList = resolve
          })
        }
        return providerResult(request)
      }
      return epResult(request)
    })
    render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
    if (provider === 'opencitations') {
      await screen.findByText('EP neighbor')
      chooseSource(name)
    }
    await waitFor(() => expect(finishList).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
    await screen.findByRole('button', { name: `Select ${prefix} neighbor` })
    await waitFor(() =>
      expect(
        related.mock.calls.filter(
          ([request]) => request.provider === provider && request.opencitationsMode === mode
        )
      ).toHaveLength(3)
    )
    expect(
      screen.getAllByText(`Source: ${name}`).filter((element) => !element.closest('[hidden]'))
    ).toHaveLength(1)
    expect(transact).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.queryByRole('checkbox', { name: `Select ${prefix} neighbor` })).toBeNull()
    await act(async () => finishList!(providerResult(listRequest!)))
    await screen.findByRole('checkbox', { name: `Select ${prefix} neighbor` })
    expect(related.mock.calls.filter(([request]) => request.provider === provider)).toHaveLength(3)
  }
)

it('keeps a loaded graph usable when its pending list request rejects', async () => {
  let fail!: (error: Error) => void
  related.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject
      })
  )
  related.mockImplementation(async (request) => epResult(request))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await waitFor(() => expect(related).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  await screen.findByRole('button', { name: 'Select EP neighbor' })
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  await act(async () => fail(new Error('Transport rejected')))
  expect(screen.getByRole('button', { name: 'Select EP neighbor' })).toBeTruthy()
  expect(related).toHaveBeenCalledTimes(3)
  expect(related.mock.calls.map(([request]) => request.provider)).toEqual([
    'europe-pmc',
    'europe-pmc',
    'europe-pmc'
  ])
})

it.each([
  ['OpenCitations · SKG-IF', 'skg-if'],
  ['OpenCitations · Index v2', 'index']
] as const)(
  'stages %s provenance from both list selections and an unsaved graph center',
  async (name, mode) => {
    related.mockImplementation(async (request) =>
      request.provider === 'opencitations' ? ocResult(request) : epResult(request)
    )
    transact.mockResolvedValue({ kind: 'candidate', id: 'oc', state: 'pending' })
    render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
    await screen.findByText('EP neighbor')
    chooseSource(name)
    await screen.findByText('OC neighbor')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select OC neighbor' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
    await screen.findByText('In Inbox')
    expect(transact.mock.calls[0][0].candidate.source).toMatchObject({
      provider: 'opencitations',
      externalId: 'opencitations:br/2',
      sourceUrl: 'https://w3id.org/oc/meta/br/2',
      rawMetadata: { seedPaperId: 'opencitations:br/1', direction: 'references', lookupMode: mode }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Select OC neighbor' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Set as center' })).toHaveProperty(
        'disabled',
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
    await screen.findByRole('button', { name: 'Select OC descendant' })
    await waitFor(() => expect(related.mock.calls.at(-1)?.[0].direction).toBe('citations'))
    fireEvent.click(screen.getByRole('button', { name: 'Selected paper' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
    await waitFor(() => expect(transact).toHaveBeenCalledTimes(2))
    expect(transact.mock.calls[1][0].candidate.source).toMatchObject({
      provider: 'opencitations',
      externalId: 'opencitations:br/2',
      sourceUrl: 'https://w3id.org/oc/meta/br/2',
      rawMetadata: {
        origin: 'exploration-center',
        exploredPaperId: 'opencitations:br/2',
        lookupMode: mode
      }
    })
    expect(
      related.mock.calls
        .slice(1)
        .every(
          ([request]) => request.provider === 'opencitations' && request.opencitationsMode === mode
        )
    ).toBe(true)
  }
)

it.each([
  ['rate-limited', 'OpenCitations · SKG-IF is limiting requests. Try again later.'],
  ['authentication', 'OpenCitations · SKG-IF rejected the request. Try again later.']
] as const)('shows OpenCitations %s errors in list and graph', async (issue, message) => {
  related.mockImplementation(async (request) =>
    request.provider === 'opencitations'
      ? { ...ocResult(request), state: 'unavailable', records: [], issue }
      : epResult(request)
  )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('EP neighbor')
  chooseSource('OpenCitations · SKG-IF')
  await screen.findByText(message)
  expect(screen.queryByRole('button', { name: 'Configure API key' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  await waitFor(() => expect(related).toHaveBeenCalledTimes(4))
  expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')
  expect(within(screen.getByRole('region', { name: 'References' })).getByText(message)).toBeTruthy()
  const tabs = screen.getByRole('tablist', { name: 'Paper list' })
  fireEvent.mouseDown(within(tabs).getByRole('tab', { name: /^Cited by/ }), {
    button: 0,
    ctrlKey: false
  })
  expect(
    within(screen.getByRole('region', { name: 'Papers citing this paper' })).getByText(message)
  ).toBeTruthy()
})

const indexNotice =
  'OpenCitations Index merges records that share an identifier. Relationships and counts may differ from SKG-IF.'

it('switches from SKG-IF to Index with fresh list pages and graph centers while ignoring late SKG-IF pages', async () => {
  let finishOld!: (response: LiteratureRelatedResult) => void
  related.mockImplementation(async (request) => {
    if (request.provider !== 'opencitations') return epResult(request)
    if (request.opencitationsMode === 'skg-if' && request.offset === 20)
      return new Promise((resolve) => {
        finishOld = resolve
      })
    return { ...ocResult(request), nextOffset: 20 }
  })
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('EP neighbor')
  chooseSource('OpenCitations · SKG-IF')
  await screen.findByText('OC neighbor')
  expect(screen.queryByText(indexNotice)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Select OC neighbor' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Set as center' })).toHaveProperty('disabled', false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await screen.findByRole('button', { name: 'Select OC descendant' })
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(finishOld).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: 'Citation graph' }))
  await screen.findByRole('button', { name: 'Select OC descendant' })
  const before = related.mock.calls.length
  chooseSource('OpenCitations · Index v2')
  await screen.findByRole('button', { name: 'Select OC neighbor' })
  expect(screen.getByRole('button', { name: 'Citation graph' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(screen.getByText(indexNotice)).toBeTruthy()
  expect(related.mock.calls[before][0]).toMatchObject({
    provider: 'opencitations',
    opencitationsMode: 'index',
    offset: 0
  })
  expect(related.mock.calls[before][0].resolutionToken).toBeUndefined()
  expect(related.mock.calls[before][0].seedPaperId).toBeUndefined()
  await act(async () =>
    finishOld({
      ...ocResult({
        itemId: 'local',
        expectedMetadataRevision: 1,
        direction: 'references',
        offset: 20,
        opencitationsMode: 'skg-if'
      }),
      records: [ocRecord('9', 'Late SKG paper')]
    })
  )
  expect(screen.queryByText('Late SKG paper')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Select OC descendant' })).toBeNull()
  expect(screen.getByText(indexNotice)).toBeTruthy()
  expect(
    screen
      .getAllByText('Source: OpenCitations · Index v2')
      .filter((element) => !element.closest('[hidden]'))
  ).toHaveLength(1)
  expect(
    related.mock.calls.slice(before).every(([request]) => request.opencitationsMode === 'index')
  ).toBe(true)
  expect(related.mock.calls.slice(before).map(([request]) => request.direction)).toEqual([
    'references',
    'citations'
  ])
  fireEvent.click(screen.getByRole('button', { name: 'List' }))
  await screen.findByText('OC neighbor')
  expect(screen.queryByText('Late SKG paper')).toBeNull()
  expect(screen.getByRole('checkbox', { name: 'Select OC neighbor' })).toHaveProperty(
    'checked',
    false
  )
})

it.each([undefined, 'skg-if'] as const)(
  'rejects a %s mode response for an explicit Index selection',
  async (wrongMode) => {
    let wrong = true
    related.mockImplementation(async (request) =>
      request.provider === 'opencitations'
        ? { ...ocResult(request), opencitationsMode: wrong ? wrongMode : 'index' }
        : epResult(request)
    )
    render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
    await screen.findByText('EP neighbor')
    chooseSource('OpenCitations · Index v2')
    await screen.findByText('Citation discovery is temporarily unavailable. Try again.')
    expect(screen.queryByText('OC neighbor')).toBeNull()
    expect(screen.getByText('Source: OpenCitations · Index v2')).toBeTruthy()
    expect(transact).not.toHaveBeenCalled()
    wrong = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('OC neighbor')
    expect(related.mock.calls.at(-1)?.[0]).toMatchObject({
      provider: 'opencitations',
      opencitationsMode: 'index',
      offset: 0
    })
  }
)

it('keeps loaded papers readable and offers a source switch after a size limit', async () => {
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ state: 'unavailable', issue: 'source-limit', records: [] }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
  await screen.findByText(
    'This response exceeds the supported size. Choose another citation source.'
  )
  expect(screen.getByText('Paper b')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(screen.getByRole('combobox', { name: 'Citation source' })).toHaveProperty(
    'disabled',
    false
  )
})

it('honors the source cooldown and permits only an explicit retry after it expires', () => {
  vi.useFakeTimers()
  try {
    const onRetry = vi.fn()
    const view = render(
      <CitationLookupError
        result={result({ state: 'unavailable', issue: 'rate-limited', retryAt: Date.now() + 2000 })}
        sourceName="Europe PMC"
        onRetry={onRetry}
      />
    )
    const button = screen.getByRole('button', { name: 'Retry in 2s' })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(onRetry).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveProperty('disabled', false)
    expect(onRetry).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    view.unmount()
  } finally {
    vi.useRealTimers()
  }
})

it('cancels an unfinished lookup when its source session closes', async () => {
  const pending = Promise.withResolvers<LiteratureRelatedResult>()
  related.mockReturnValue(pending.promise)
  const view = render(
    <LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />
  )
  await waitFor(() => expect(related).toHaveBeenCalledTimes(1))
  const requestId = related.mock.calls[0][0].requestId
  expect(requestId).toEqual(expect.any(String))
  view.unmount()
  expect(window.api.literature.cancelRelated).toHaveBeenCalledWith({ requestId })
  await act(async () => pending.resolve(result()))
  expect(transact).not.toHaveBeenCalled()
})
