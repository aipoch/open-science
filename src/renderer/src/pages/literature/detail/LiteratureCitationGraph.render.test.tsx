// @vitest-environment jsdom
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { FileTypeIcon } from '@/pages/workspace/file-type-icon'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type {
  LiteratureRelatedRecord,
  LiteratureRelatedRequest,
  LiteratureRelatedResult
} from '@aipoch/literature-discovery/contracts'
import { LiteratureCitationGraph } from './LiteratureCitationGraph'
import { useCitationGraphController } from './useCitationGraphController'
import { LiteratureCitationStatus } from './LiteratureCitationStatus'

const { render } = createLiteratureTestRenderer({
  FileTypeIcon,
  get api() {
    return window.api
  }
})
const related = vi.fn<(request: LiteratureRelatedRequest) => Promise<LiteratureRelatedResult>>()
const transact = vi.fn()
const paperId = (letter: string): string => `europe-pmc:MED:${letter.charCodeAt(0)}`
const record = (letter: string): LiteratureRelatedRecord => ({
  paperId: paperId(letter),
  item: literatureItemInputSchema.parse({ itemType: 'document', title: `Paper ${letter}` })
})
const item: LiteratureItemView = {
  id: 'local',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Center' })
}
const token = '00000000-0000-4000-8000-000000000000'
const result = (
  request: LiteratureRelatedRequest,
  extra: Partial<LiteratureRelatedResult> = {}
): LiteratureRelatedResult => ({
  itemId: request.itemId,
  metadataRevision: request.expectedMetadataRevision,
  direction: request.direction,
  state: 'ready',
  provider: 'europe-pmc',
  seed: record('a'),
  records: [record(request.direction === 'references' ? 'b' : 'c')],
  resolutionToken: token,
  ...extra
})
const deferred = <T,>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve: (value) => resolve(value)
  }
}
beforeEach(() => {
  related.mockReset().mockImplementation(async (request) => result(request))
  transact.mockReset().mockResolvedValue({ kind: 'candidate', id: 'candidate', state: 'pending' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: { related, transact, cancelRelated: vi.fn().mockResolvedValue(undefined) }
    }
  })
})
afterEach(cleanup)
const showPaperList = (): void => {
  const toggle = document.querySelector<HTMLButtonElement>(
    '[data-current-frame="true"] [data-citation-paper-list-toggle]'
  )
  if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
}

it('shows only returned directed relationships and stages an explicit keyboard-selected node', async () => {
  const onSaved = vi.fn()
  render(<LiteratureCitationGraph item={item} onSaved={onSaved} />)
  const svg = await screen.findByRole('group', { name: 'Citation graph' })
  await screen.findByRole('button', { name: 'Select Paper c' })
  expect(related.mock.calls[1][0]).toMatchObject({ direction: 'citations', resolutionToken: token })
  expect(
    [...svg.querySelectorAll('[data-source][data-target]')].map((line) => [
      line.getAttribute('data-source'),
      line.getAttribute('data-target')
    ])
  ).toEqual([
    [paperId('a'), paperId('b')],
    [paperId('c'), paperId('a')]
  ])
  expect(transact).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Select Paper c' }), { key: 'Enter' })
  expect(
    within(screen.getByRole('region', { name: 'Selected paper' })).getByText('Paper c')
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await screen.findByText('In Inbox')
  expect(onSaved).toHaveBeenCalledTimes(1)
  expect(transact).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'stage-candidate',
      candidate: expect.objectContaining({
        source: expect.objectContaining({
          externalId: paperId('c'),
          rawMetadata: expect.objectContaining({ directions: ['citations'] })
        })
      })
    })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Fit graph' }))
  expect(
    within(screen.getByRole('region', { name: 'Selected paper' })).getByText('Paper c')
  ).toBeTruthy()
})

it('preserves a neighbor whose DOI is an unverified local alias of the center', async () => {
  const doi = (value: string): LiteratureRelatedRecord['item']['identifiers'][number] => ({
    scheme: 'doi' as const,
    value: `10.1234/${value}`,
    isPrimary: false
  })
  const seed = record('a')
  seed.item.identifiers = [doi('a')]
  const neighbor = record('b')
  neighbor.item.identifiers = [doi('b')]
  related.mockImplementation(async (request) =>
    result(request, { seed, records: request.direction === 'references' ? [neighbor] : [] })
  )
  render(
    <LiteratureCitationGraph
      item={{ ...item, item: { ...item.item, identifiers: [doi('a'), doi('b')] } }}
      onSaved={vi.fn()}
    />
  )
  await screen.findByRole('button', { name: 'Select Paper b' })
  expect(
    screen
      .getByRole('group', { name: 'Citation graph' })
      .querySelector(`[data-source="${paperId('a')}"][data-target="${paperId('b')}"]`)
  ).toBeTruthy()
})

it('keeps one active direction visible and switches to the cached other direction', async () => {
  render(<LiteratureCitationGraph item={item} directionMode="single" onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper b' })
  expect(screen.queryByRole('button', { name: 'Select Paper c' })).toBeNull()
  expect(screen.getByRole('tab', { name: 'References' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: 'Cited by' }).getAttribute('aria-selected')).toBe('false')
  expect(screen.getByRole('tab', { name: 'References' }).className).toContain('bg-primary/10')
  expect(screen.getByRole('tab', { name: 'Cited by' }).className).not.toContain('bg-primary/10')
  const calls = related.mock.calls.length
  fireEvent.click(screen.getByRole('tab', { name: 'Cited by' }))
  await screen.findByRole('button', { name: 'Select Paper c' })
  expect(screen.queryByRole('button', { name: 'Select Paper b' })).toBeNull()
  expect(related).toHaveBeenCalledTimes(calls)
  expect(screen.getByRole('tab', { name: 'Cited by' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: 'Cited by' }).className).toContain('bg-primary/10')
  expect(screen.getByRole('tab', { name: 'References' }).className).not.toContain('bg-primary/10')
})
function showCategory(direction: 'references' | 'citations'): void {
  const tabs = screen.getByRole('tablist', { name: 'Paper list' })
  fireEvent.mouseDown(
    within(tabs).getByRole('tab', {
      name: direction === 'references' ? /^References/ : /^Cited by/
    }),
    { button: 0, ctrlKey: false }
  )
}

it('defaults to all directions and filters merged papers without moving or requerying them', async () => {
  related.mockImplementation(async (request) =>
    result(request, {
      records: request.direction === 'references' ? [record('b')] : [record('b'), record('c')]
    })
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')
  expect(
    within(screen.getByRole('tablist', { name: 'Relationship regions' })).getAllByRole('tab')
  ).toHaveLength(3)
  const paper = (): HTMLElement => screen.getByRole('button', { name: 'Select Paper b' })
  const position = (): (string | null)[] => {
    const mark = paper().querySelector('[data-node-mark]')!
    return [mark.getAttribute('data-x'), mark.getAttribute('data-y')]
  }
  const originalPosition = position()
  expect(paper().querySelector('[data-node-mark]')?.getAttribute('data-node-kind')).toBe('both')
  expect(paper().querySelector('[data-node-kind="diamond"]')).toBeTruthy()
  expect(
    within(screen.getByRole('region', { name: 'References' })).getByText('Loaded: 1')
  ).toBeTruthy()
  showCategory('citations')
  expect(
    within(screen.getByRole('region', { name: 'Papers citing this paper' })).getByText('Loaded: 2')
  ).toBeTruthy()
  fireEvent.click(paper())
  fireEvent.click(screen.getByRole('tab', { name: 'References' }))
  expect(paper().getAttribute('aria-pressed')).toBe('true')
  expect(paper().getAttribute('data-relation')).toBe('both')
  expect(position()).toEqual(originalPosition)
  expect(screen.queryByRole('button', { name: 'Select Paper c' })).toBeNull()
  expect(document.querySelectorAll('[data-source][data-target]')).toHaveLength(1)
  showPaperList()
  expect(
    within(screen.getByRole('region', { name: 'References' })).getByText('Loaded: 1')
  ).toBeTruthy()
  expect(screen.queryByRole('region', { name: 'Papers citing this paper' })).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: 'Cited by' }))
  expect(paper().getAttribute('aria-pressed')).toBe('true')
  expect(position()).toEqual(originalPosition)
  expect(document.querySelectorAll('[data-source][data-target]')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper c' }))
  fireEvent.click(screen.getByRole('tab', { name: 'All' }))
  expect(screen.getByRole('button', { name: 'Select Paper c' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('tab', { name: 'References' }))
  expect(
    screen.getByRole('button', { name: 'Center paper: Center' }).getAttribute('aria-pressed')
  ).toBe('true')
  expect(related).toHaveBeenCalledTimes(2)
  expect(transact).not.toHaveBeenCalled()
})
it('labels both pagination controls and loads the chosen direction in the all view', async () => {
  related.mockImplementation(async (request) =>
    result(
      request,
      request.offset
        ? { records: [record(request.direction === 'references' ? 'd' : 'e')] }
        : { nextOffset: 20 }
    )
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  const references = screen.getByRole('region', { name: 'References' })
  expect(within(references).getByRole('heading', { name: 'References' })).toBeTruthy()
  fireEvent.click(within(references).getByRole('button', { name: 'Load more' }))
  await screen.findByRole('button', { name: 'Select Paper d' })
  expect(within(references).getByText('Loaded: 2')).toBeTruthy()
  expect(screen.queryByRole('region', { name: 'Papers citing this paper' })).toBeNull()
  expect(related.mock.calls.at(-1)?.[0]).toMatchObject({ direction: 'references', offset: 20 })
  showCategory('citations')
  const citations = screen.getByRole('region', { name: 'Papers citing this paper' })
  expect(within(citations).getByRole('heading', { name: 'Cited by' })).toBeTruthy()
  fireEvent.click(within(citations).getByRole('button', { name: 'Load more' }))
  await screen.findByRole('button', { name: 'Select Paper e' })
  expect(within(citations).getByText('Loaded: 2')).toBeTruthy()
  expect(related.mock.calls.at(-1)?.[0]).toMatchObject({ direction: 'citations', offset: 20 })
  expect(transact).not.toHaveBeenCalled()
})
it('waits for the second initial direction before freezing the full graph camera', async () => {
  const pending = deferred<LiteratureRelatedResult>()
  related.mockImplementation(async (request) =>
    request.direction === 'citations' ? pending.promise : result(request)
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper b' })
  await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  const firstView = svg.getAttribute('viewBox')
  await act(async () =>
    pending.resolve(
      result(related.mock.calls[1][0], {
        records: Array.from({ length: 12 }, (_, index) => record(String.fromCharCode(99 + index)))
      })
    )
  )
  await screen.findByRole('button', { name: 'Select Paper n' })
  const fullView = svg.getAttribute('viewBox')
  expect(fullView).not.toBe(firstView)
  const [x, y, width, height] = fullView!.split(' ').map(Number)
  for (const mark of svg.querySelectorAll('[data-node-mark]')) {
    expect(Number(mark.getAttribute('data-x'))).toBeGreaterThan(x)
    expect(Number(mark.getAttribute('data-x'))).toBeLessThan(x + width)
    expect(Number(mark.getAttribute('data-y'))).toBeGreaterThan(y)
    expect(Number(mark.getAttribute('data-y'))).toBeLessThan(y + height)
  }
  fireEvent.click(screen.getByRole('tab', { name: 'References' }))
  expect(svg.getAttribute('viewBox')).toBe(fullView)
  fireEvent.click(screen.getByRole('tab', { name: 'All' }))
  expect(svg.getAttribute('viewBox')).toBe(fullView)
  expect(related).toHaveBeenCalledTimes(2)
})
it('shares the fitted camera across filters and preserves it through paging and history', async () => {
  related.mockImplementation(async (request) =>
    result(request, {
      records: request.direction === 'references' ? [] : [record(request.offset ? 'd' : 'c')],
      nextOffset: request.direction === 'citations' && !request.offset ? 20 : undefined
    })
  )
  render(<LiteratureCitationGraph item={item} directionMode="single" onSaved={vi.fn()} />)
  await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  const canvas = screen.getByRole('region', { name: 'Citation graph' })
  const snapshot = (): (string | null)[] =>
    ['viewBox', 'data-zoom', 'data-pan-x', 'data-pan-y'].map((key) => svg.getAttribute(key))
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  fireEvent.wheel(canvas, { deltaX: 35, deltaY: 45 })
  const emptyView = snapshot()
  fireEvent.click(screen.getByRole('tab', { name: 'Cited by' }))
  const cited = await screen.findByRole('button', { name: 'Select Paper c' })
  expect(snapshot()).toEqual(emptyView)
  const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number)
  const mark = cited.querySelector('[data-node-mark]')!
  expect(Number(mark.getAttribute('data-x'))).toBeGreaterThan(x)
  expect(Number(mark.getAttribute('data-x'))).toBeLessThan(x + width)
  expect(Number(mark.getAttribute('data-y'))).toBeGreaterThan(y)
  expect(Number(mark.getAttribute('data-y'))).toBeLessThan(y + height)
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  fireEvent.wheel(canvas, { deltaX: 70, deltaY: 80 })
  const citedView = snapshot()
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('button', { name: 'Select Paper d' })
  expect(snapshot()).toEqual(citedView)
  fireEvent.click(screen.getByRole('tab', { name: 'References' }))
  expect(snapshot()).toEqual(citedView)
  fireEvent.click(screen.getByRole('tab', { name: 'Cited by' }))
  expect(snapshot()).toEqual(citedView)
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper c' }))
  await screen.findByRole('heading', { name: 'Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await waitFor(() => expect(related).toHaveBeenCalledTimes(5))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(snapshot()).toEqual(citedView)
  expect(screen.getByRole('button', { name: 'Select Paper d' })).toBeTruthy()
  expect(related).toHaveBeenCalledTimes(5)
})
it('preserves the successful direction when the other fails and retries it in place', async () => {
  related.mockImplementation(async (request) =>
    request.direction === 'citations'
      ? result(request, { state: 'unavailable', issue: 'unavailable', records: [] })
      : result(request)
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  showCategory('citations')
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Select Paper b' })).toBeTruthy()
  related.mockImplementation(async (request) => result(request))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: 'Select Paper c' })
  expect(screen.getByRole('button', { name: 'Select Paper b' })).toBeTruthy()
  expect(related).toHaveBeenCalledTimes(3)
})
it('keeps prior pages on failure and retries the exact provider cursor', async () => {
  related.mockImplementation(async (request) =>
    request.offset === 37
      ? result(request, { state: 'unavailable', issue: 'timeout', records: [] })
      : result(request, request.direction === 'references' ? { nextOffset: 37 } : {})
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Select Paper b' })).toBeTruthy()
  const pending = deferred<LiteratureRelatedResult>()
  related.mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(screen.queryByText('Searching…')).toBeNull()
  expect(screen.getByRole('button', { name: 'Select Paper b' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Loading…' })).toHaveProperty('disabled', true)
  await act(async () =>
    pending.resolve(result(related.mock.calls.at(-1)![0], { records: [record('d')] }))
  )
  await screen.findByRole('button', { name: 'Select Paper d' })
  expect(related.mock.calls.at(-1)?.[0]).toMatchObject({ offset: 37, direction: 'references' })
})
it('retains omitted relationships across successful pages and counts only successful retry results', async () => {
  let fail = true
  related.mockImplementation(async (request) =>
    result(
      request,
      request.direction === 'citations'
        ? {}
        : request.offset === 40
          ? fail
            ? { state: 'unavailable', records: [], issue: 'timeout', omitted: 17 }
            : { records: [record('e')], omitted: 3 }
          : {
              records: [record(request.offset === 20 ? 'd' : 'b')],
              omitted: request.offset === 20 ? 0 : 2,
              nextOffset: request.offset! + 20
            }
    )
  )
  let controller!: ReturnType<typeof useCitationGraphController>
  const controllerProps = {
    item,
    onSaved: vi.fn(),
    schedule: (request: LiteratureRelatedRequest) => related(request),
    invalidatedSession: { current: false },
    onReferenceChanged: vi.fn(),
    onRootResolved: vi.fn(),
    onExplore: vi.fn()
  }
  function Harness(): React.JSX.Element {
    controller = useCitationGraphController(controllerProps)
    return (
      <LiteratureCitationStatus
        model={controller}
        direction="references"
        sourceName="Europe PMC"
        renderRecords={() => null}
        onRestart={vi.fn()}
      />
    )
  }
  render(<Harness />)
  await waitFor(() => expect(controller.states.citations.pages).toBe(1))
  const omittedMessage =
    'Some relationships could not be matched to a record in Europe PMC and are not shown.'
  expect(screen.getByText(omittedMessage)).toBeTruthy()
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(controller.states.references.pages).toBe(2))
  expect(screen.getByText(omittedMessage)).toBeTruthy()
  expect(controller.states.references.omitted).toBe(2)
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('alert')
  expect(screen.getByText(omittedMessage)).toBeTruthy()
  expect(controller.states.references.omitted).toBe(2)
  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(controller.states.references.pages).toBe(3))
  expect(controller.states.references.omitted).toBe(5)
  expect(screen.getByText(omittedMessage)).toBeTruthy()
  expect(related.mock.calls.slice(-2).map(([request]) => request.offset)).toEqual([40, 40])
})
it('invalidates late results when the center changes and when the view closes', async () => {
  const pending = deferred<LiteratureRelatedResult>()
  related.mockImplementation((request) =>
    request.itemId === 'local'
      ? pending.promise
      : Promise.resolve(result(request, { records: [record('d')] }))
  )
  const { rerender, unmount } = render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await waitFor(() => expect(related).toHaveBeenCalledTimes(1))
  rerender(
    <LiteratureCitationGraph
      item={{ ...item, id: 'next', item: { ...item.item, title: 'Next center' } }}
      onSaved={vi.fn()}
    />
  )
  await screen.findByRole('button', { name: 'Select Paper d' })
  await act(async () =>
    pending.resolve(
      result(
        { itemId: 'local', expectedMetadataRevision: 1, direction: 'references', offset: 0 },
        { records: [record('e')] }
      )
    )
  )
  expect(screen.queryByRole('button', { name: 'Select Paper e' })).toBeNull()
  expect(related.mock.calls.filter(([request]) => request.itemId === 'local')).toHaveLength(1)
  const closed = deferred<LiteratureRelatedResult>()
  related.mockReturnValue(closed.promise)
  unmount()
  const next = render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await waitFor(() => expect(related.mock.calls.at(-1)?.[0].itemId).toBe('local'))
  const before = related.mock.calls.length
  next.unmount()
  await act(async () =>
    closed.resolve(
      result({ itemId: 'local', expectedMetadataRevision: 1, direction: 'references', offset: 0 })
    )
  )
  expect(related).toHaveBeenCalledTimes(before)
})
it('reports empty and omitted results without inventing neighbors', async () => {
  related.mockImplementation(async (request) => result(request, { records: [], omitted: 1 }))
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  for (const direction of ['references', 'citations'] as const) {
    showCategory(direction)
    await screen.findByText(
      'Europe PMC did not provide relationships for this page; the paper may still have references or citations.'
    )
  }
  expect(screen.getAllByRole('button', { name: 'Center paper: Center' })).toHaveLength(1)
  expect(
    screen
      .getByRole('group', { name: 'Citation graph' })
      .querySelectorAll('[data-source][data-target]')
  ).toHaveLength(0)
})
const directionPageLimitMessage =
  'Loaded 5 pages for this direction (up to 100 relationships). Explore the other direction or another paper.'

it.each(['references', 'citations'] as const)(
  'stops only %s after five pages while the other direction can retry and finish',
  async (fullDirection) => {
    const otherDirection = fullDirection === 'references' ? 'citations' : 'references'
    let failOther = true
    related.mockImplementation(async (request) =>
      result(
        request,
        request.direction === otherDirection && request.offset === 20 && failOther
          ? { state: 'unavailable', issue: 'timeout', records: [] }
          : {
              records: Array.from({ length: 20 }, (_, index) => ({
                ...record('b'),
                paperId: `europe-pmc:MED:${(request.direction === 'references' ? 1001 : 2001) + request.offset! + index}`
              })),
              nextOffset:
                request.direction === fullDirection || request.offset === 0
                  ? request.offset! + 20
                  : undefined
            }
      )
    )
    render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
    await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
    const fullTitle = fullDirection === 'references' ? 'References' : 'Papers citing this paper'
    const otherTitle = otherDirection === 'references' ? 'References' : 'Papers citing this paper'
    showCategory(fullDirection)
    let full = screen.getByRole('region', { name: fullTitle })
    for (let page = 2; page <= 5; page++) {
      const more = within(full).getByRole('button', { name: 'Load more' })
      await waitFor(() => expect(more).toHaveProperty('disabled', false))
      fireEvent.click(more)
      await waitFor(() => expect(related).toHaveBeenCalledTimes(page + 1))
    }
    await within(full).findByText(directionPageLimitMessage)
    expect(within(full).queryByText('No more results')).toBeNull()
    expect(within(full).queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(
      screen.getByRole('group', { name: 'Citation graph' }).querySelectorAll('[data-node-mark]')
    ).toHaveLength(121)
    expect(related).toHaveBeenCalledTimes(6)
    showCategory(otherDirection)
    let other = screen.getByRole('region', { name: otherTitle })
    expect(within(other).getByRole('button', { name: 'Load more' })).toHaveProperty(
      'disabled',
      false
    )
    fireEvent.click(within(other).getByRole('button', { name: 'Load more' }))
    await within(other).findByRole('alert')
    showCategory(fullDirection)
    full = screen.getByRole('region', { name: fullTitle })
    expect(within(full).getByText(directionPageLimitMessage)).toBeTruthy()
    showCategory(otherDirection)
    other = screen.getByRole('region', { name: otherTitle })
    failOther = false
    fireEvent.click(within(other).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(related).toHaveBeenCalledTimes(8))
    expect(
      related.mock.calls
        .slice(-2)
        .map(([request]) => ({ direction: request.direction, offset: request.offset }))
    ).toEqual([
      { direction: otherDirection, offset: 20 },
      { direction: otherDirection, offset: 20 }
    ])
    await waitFor(() =>
      expect(
        screen.getByRole('group', { name: 'Citation graph' }).querySelectorAll('[data-node-mark]')
      ).toHaveLength(141)
    )
    expect(
      within(screen.getByRole('region', { name: otherTitle })).queryByRole('button', {
        name: 'Load more'
      })
    ).toBeNull()
    expect(
      within(screen.getByRole('region', { name: otherTitle })).getByText('Loaded: 40')
    ).toBeTruthy()
    expect(screen.queryByText(directionPageLimitMessage)).toBeNull()
    showCategory(fullDirection)
    expect(screen.getAllByText(directionPageLimitMessage)).toHaveLength(1)
  }
)

it('does not show a capacity warning when the fifth short page naturally ends', async () => {
  related.mockImplementation(async (request) =>
    result(request, {
      records: [record(request.direction === 'references' ? 'b' : 'c')],
      nextOffset:
        request.direction === 'references' && request.offset! < 80
          ? request.offset! + 20
          : undefined
    })
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
  for (let page = 2; page <= 5; page++) {
    const more = await screen.findByRole('button', { name: 'Load more' })
    await waitFor(() => expect(more).toHaveProperty('disabled', false))
    fireEvent.click(more)
    await waitFor(() => expect(related).toHaveBeenCalledTimes(page + 1))
  }
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull())
  expect(screen.getByText('No more results')).toBeTruthy()
  expect(screen.queryByText(directionPageLimitMessage)).toBeNull()
  expect(
    screen.getByRole('group', { name: 'Citation graph' }).querySelectorAll('[data-node-mark]')
  ).toHaveLength(3)
})

it('admits only one pending page before React can disable the controls', async () => {
  const pending = deferred<LiteratureRelatedResult>()
  related.mockImplementation((request) =>
    request.offset === 20 ? pending.promise : Promise.resolve(result(request, { nextOffset: 20 }))
  )
  let controller!: ReturnType<typeof useCitationGraphController>
  const controllerProps = {
    item,
    onSaved: vi.fn(),
    schedule: (request: LiteratureRelatedRequest) => related(request),
    invalidatedSession: { current: false },
    onReferenceChanged: vi.fn(),
    onRootResolved: vi.fn(),
    onExplore: vi.fn()
  }
  function Harness(): null {
    controller = useCitationGraphController(controllerProps)
    return null
  }
  render(<Harness />)
  await waitFor(() => expect(controller.states.citations.pages).toBe(1))
  await act(async () => {
    const first = controller.load('references', 20)
    const duplicate = controller.load('references', 20)
    try {
      expect(related.mock.calls.filter(([request]) => request.offset === 20)).toHaveLength(1)
    } finally {
      pending.resolve(
        result({ ...related.mock.calls.at(-1)![0], offset: 20 }, { records: [record('d')] })
      )
      await Promise.all([first, duplicate])
    }
  })
  expect(controller.states.references.pages).toBe(2)
  expect(controller.entries.filter(({ record }) => record.paperId === paperId('d'))).toHaveLength(1)
})

it('guards direct paging after five successful pages without counting failed attempts', async () => {
  let fail = true
  related.mockImplementation(async (request) =>
    result(
      request,
      request.direction === 'references' && request.offset === 60 && fail
        ? { state: 'unavailable', records: [], issue: 'timeout' }
        : { nextOffset: request.offset! + 20 }
    )
  )
  let controller!: ReturnType<typeof useCitationGraphController>
  const controllerProps = {
    item,
    onSaved: vi.fn(),
    schedule: (request: LiteratureRelatedRequest) => related(request),
    invalidatedSession: { current: false },
    onReferenceChanged: vi.fn(),
    onRootResolved: vi.fn(),
    onExplore: vi.fn()
  }
  function Harness(): null {
    controller = useCitationGraphController(controllerProps)
    return null
  }
  render(<Harness />)
  await waitFor(() => expect(controller.states.citations.pages).toBe(1))
  for (const offset of [20, 40, 60]) await act(() => controller.load('references', offset))
  expect(controller.states.references.pages).toBe(3)
  expect(controller.states.references.nextOffset).toBe(60)
  fail = false
  await act(() => controller.load('references', 60))
  await act(() => controller.load('references', 80))
  expect(controller.states.references.pages).toBe(5)
  const calls = related.mock.calls.length
  await act(() => controller.load('references', 100))
  await act(() => controller.load('references', 0))
  expect(related).toHaveBeenCalledTimes(calls)
  await act(() => controller.load('citations', 20))
  expect(controller.states.citations.pages).toBe(2)
  expect(related).toHaveBeenCalledTimes(calls + 1)
})

it('blocks staging and further paging after expiration until the graph is searched again', async () => {
  related.mockImplementation(async (request) =>
    result(request, request.direction === 'references' ? { nextOffset: 20 } : {})
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  related.mockImplementation(async (request) =>
    result(request, { state: 'unavailable', records: [], issue: 'expired' })
  )
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByText('These results expired. Search again.')
  fireEvent.click(screen.getByRole('button', { name: 'View details' }))
  expect(screen.getByRole('button', { name: 'Add to Inbox' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Select Paper b' })).toBeTruthy()
  related.mockImplementation(async (request) => result(request, { records: [record('d')] }))
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Reload from starting paper' }))
  await screen.findByRole('button', { name: 'Select Paper d' })
  expect(screen.queryByRole('button', { name: 'Select Paper b' })).toBeNull()
  expect(related.mock.calls.at(-2)?.[0]).toMatchObject({
    direction: 'references',
    offset: 0,
    resolutionToken: undefined
  })
})
it('rejects a response for the wrong metadata revision and retains the other direction', async () => {
  related.mockImplementation(async (request) =>
    result(request, request.direction === 'references' ? { metadataRevision: 2 } : {})
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Select Paper b' })).toBeNull()
})
it('keeps a failed staging action retryable and never writes automatically', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  transact.mockRejectedValueOnce(new Error('Unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await screen.findByText('Could not add this reference. Try again.')
  expect(screen.getByRole('button', { name: 'Add to Inbox' })).toHaveProperty('disabled', false)
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact).toHaveBeenCalledTimes(2)
})

it('rejects a ready response resolving to a different center without attaching its edges', async () => {
  related.mockImplementation(async (request) =>
    result(
      request,
      request.direction === 'citations' ? { seed: record('d'), records: [record('e')] } : {}
    )
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  showCategory('citations')
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Select Paper b' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Select Paper e' })).toBeNull()
  expect(
    screen
      .getByRole('group', { name: 'Citation graph' })
      .querySelectorAll('[data-source][data-target]')
  ).toHaveLength(1)
})
it('stages the merged scholarly identifiers when provider IDs describe the same paper', async () => {
  const first = record('b')
  first.item.identifiers = [{ scheme: 'pmid', value: '123', isPrimary: true }]
  const alias = record('c')
  alias.item.identifiers = [
    { scheme: 'pmid', value: '123', isPrimary: true },
    { scheme: 'doi', value: '10.1234/test', isPrimary: true }
  ]
  related.mockImplementation(async (request) =>
    result(request, { records: [request.direction === 'references' ? first : alias] })
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await waitFor(() =>
    expect(
      screen
        .getByRole('group', { name: 'Citation graph' })
        .querySelectorAll('[data-source][data-target]')
    ).toHaveLength(2)
  )
  expect(screen.queryByRole('button', { name: 'Select Paper c' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact.mock.calls[0][0].candidate.item.identifiers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scheme: 'pmid', value: '123' }),
      expect.objectContaining({ scheme: 'doi', value: '10.1234/test' })
    ])
  )
})

const receiptAliasA: LiteratureRelatedRecord = {
  paperId: 'europe-pmc:MED:1',
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Alias A',
    identifiers: [{ scheme: 'pmid', value: '1', isPrimary: true }]
  })
}
const receiptAliasB: LiteratureRelatedRecord = {
  paperId: 'europe-pmc:PMC:PMC123',
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Alias B',
    identifiers: [{ scheme: 'doi', value: '10.1234/shared', isPrimary: true }]
  })
}
const mockReceiptAliasPages = (): void => {
  related.mockImplementation(async (request) =>
    result(request, {
      seed: { ...record('a'), paperId: 'europe-pmc:MED:999' },
      records:
        request.direction === 'citations'
          ? []
          : request.offset === 20
            ? [
                {
                  ...receiptAliasA,
                  item: {
                    ...receiptAliasA.item,
                    identifiers: [
                      ...receiptAliasA.item.identifiers,
                      ...receiptAliasB.item.identifiers
                    ]
                  }
                }
              ]
            : [receiptAliasA, receiptAliasB],
      nextOffset: request.direction === 'references' && request.offset === 0 ? 20 : undefined
    })
  )
}

it('keeps a saved paper in Inbox when a later page merges its native alias into another node', async () => {
  mockReceiptAliasPages()
  const onSaved = vi.fn()
  render(<LiteratureCitationGraph item={item} onSaved={onSaved} />)
  const save = await screen.findByRole('button', { name: 'Select Alias B' })
  await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
  fireEvent.click(save)
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await screen.findByText('In Inbox')
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Alias B' })).toBeNull())
  expect(screen.getByRole('button', { name: 'Select Alias A' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('button', { name: 'View details' }))
  expect(screen.getByText('In Inbox')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Add to Inbox' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  expect(transact).toHaveBeenCalledTimes(1)
  expect(onSaved).toHaveBeenCalledTimes(1)
})

it.each(['none', 'canonical', 'alias'] as const)(
  'preserves successful receipts and rejects repeat saves after alias merging (%s failure)',
  async (failedIdentity) => {
    mockReceiptAliasPages()
    let controller!: ReturnType<typeof useCitationGraphController>
    const controllerProps = {
      item,
      onSaved: vi.fn(),
      schedule: (request: LiteratureRelatedRequest) => related(request),
      invalidatedSession: { current: false },
      onReferenceChanged: vi.fn(),
      onRootResolved: vi.fn(),
      onExplore: vi.fn()
    }
    function Harness(): null {
      controller = useCitationGraphController(controllerProps)
      return null
    }
    render(<Harness />)
    await waitFor(() => expect(controller.states.citations.pages).toBe(1))
    if (failedIdentity === 'canonical') {
      transact.mockRejectedValueOnce(new Error('staging failed'))
      await act(() => controller.setSelected(receiptAliasA.paperId))
      await act(() => controller.save())
    }
    const savedIdentity = failedIdentity === 'alias' ? receiptAliasA : receiptAliasB
    await act(() => controller.setSelected(savedIdentity.paperId))
    await act(() => controller.save())
    if (failedIdentity === 'alias') {
      transact.mockRejectedValueOnce(new Error('staging failed'))
      await act(() => controller.setSelected(receiptAliasB.paperId))
      await act(() => controller.save())
    }
    await act(() => controller.load('references', 20))
    expect(controller.selectedNode).toMatchObject({
      id: receiptAliasA.paperId,
      paperIds: [receiptAliasA.paperId, receiptAliasB.paperId]
    })
    const calls = transact.mock.calls.length
    await act(() => controller.save())
    expect(transact).toHaveBeenCalledTimes(calls)
    expect(controller.selectedReceipt).toEqual({
      kind: 'candidate',
      id: 'candidate',
      state: 'pending'
    })
    expect(controllerProps.onSaved).toHaveBeenCalledTimes(1)
  }
)

const childToken = '11111111-1111-4111-8111-111111111111'
const explorationResult = (request: LiteratureRelatedRequest): LiteratureRelatedResult =>
  request.seedPaperId
    ? result(request, {
        seed: record(String.fromCharCode(Number(request.seedPaperId.split(':').at(-1)))),
        records: [record(request.direction === 'references' ? 'd' : 'e')],
        resolutionToken: childToken
      })
    : result(request, request.direction === 'references' ? { nextOffset: 20 } : {})
it('explores an unsaved paper, restores the parent snapshot and reuses the child without writes', async () => {
  related.mockImplementation(async (request) => explorationResult(request))
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  const rootSvg = screen.getByRole('group', { name: 'Citation graph' })
  const outer = document.querySelector<HTMLElement>('[data-citation-inspector]')!
  const canvas = rootSvg.closest<HTMLElement>('[data-citation-canvas]')!
  attachCapture(canvas)
  dispatchPointer(canvas, 'pointerdown')
  dispatchPointer(canvas, 'pointermove', { clientX: -91, clientY: -73 })
  dispatchPointer(canvas, 'pointerup')
  outer.scrollTop = 99
  fireEvent.scroll(outer)
  const zoom = rootSvg.getAttribute('data-zoom')
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await screen.findByRole('button', { name: 'Select Paper e' })
  expect(screen.getByText('Temporary center')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Center paper: Paper b' })).toBeTruthy()
  expect(related.mock.calls.slice(2).map(([request]) => request)).toEqual([
    expect.objectContaining({
      itemId: 'local',
      expectedMetadataRevision: 1,
      seedPaperId: paperId('b'),
      resolutionToken: token,
      direction: 'references',
      offset: 0
    }),
    expect.objectContaining({
      itemId: 'local',
      expectedMetadataRevision: 1,
      seedPaperId: paperId('b'),
      resolutionToken: childToken,
      direction: 'citations',
      offset: 0
    })
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper d' }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByRole('button', { name: 'Select Paper b' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(screen.getByRole('group', { name: 'Citation graph' }).getAttribute('data-zoom')).toBe(zoom)
  expect(rootSvg.getAttribute('data-pan-y')).toBe('-73')
  expect(rootSvg.getAttribute('data-pan-x')).toBe('-91')
  expect(outer.scrollTop).toBe(99)
  showPaperList()
  expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Selected paper' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  expect(screen.getByRole('button', { name: 'Select Paper d' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(related).toHaveBeenCalledTimes(4)
  expect(transact).not.toHaveBeenCalled()
})
it('uses the actual temporary center in explicit save provenance without inventing a self citation', async () => {
  related.mockImplementation(async (request) => explorationResult(request))
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await screen.findByRole('button', { name: 'Select Paper e' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper d' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact.mock.calls[0][0].candidate.source.rawMetadata).toEqual({
    rootItemId: 'local',
    rootMetadataRevision: 1,
    seedPaperId: paperId('b'),
    directions: ['references']
  })
  fireEvent.click(screen.getByRole('button', { name: 'Center paper: Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await waitFor(() => expect(transact).toHaveBeenCalledTimes(2))
  expect(transact.mock.calls[1][0].candidate.source.rawMetadata).toEqual({
    rootItemId: 'local',
    rootMetadataRevision: 1,
    exploredPaperId: paperId('b'),
    origin: 'exploration-center'
  })
})
it('keeps a minted child token from a partial failure and retries without reusing its parent token', async () => {
  related.mockImplementation(async (request) =>
    request.seedPaperId
      ? result(request, {
          state: 'unavailable',
          issue: 'timeout',
          seed: record('b'),
          records: [],
          resolutionToken: childToken
        })
      : explorationResult(request)
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await waitFor(() => expect(related).toHaveBeenCalledTimes(4))
  for (const direction of ['citations', 'references'] as const) {
    showCategory(direction)
    expect(screen.getByRole('alert')).toBeTruthy()
  }
  expect(related.mock.calls[3][0]).toMatchObject({
    seedPaperId: paperId('b'),
    resolutionToken: childToken
  })
  related.mockImplementation(async (request) => explorationResult(request))
  fireEvent.click(
    within(screen.getByRole('region', { name: 'References' })).getByRole('button', {
      name: 'Retry'
    })
  )
  await screen.findByRole('button', { name: 'Select Paper d' })
  expect(related.mock.calls.at(-1)?.[0]).toMatchObject({
    seedPaperId: paperId('b'),
    resolutionToken: childToken
  })
})
it('isolates a late child response after returning to the original paper', async () => {
  const pending = deferred<LiteratureRelatedResult>()
  related.mockImplementation((request) =>
    request.seedPaperId && request.direction === 'references'
      ? pending.promise
      : Promise.resolve(explorationResult(request))
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await act(async () => pending.resolve(explorationResult(related.mock.calls[2][0])))
  expect(screen.queryByRole('button', { name: 'Select Paper d' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Select Paper b' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(transact).not.toHaveBeenCalled()
})
it('invalidates all cached centers when a hidden child reports the root reference changed', async () => {
  const pending = deferred<LiteratureRelatedResult>()
  related.mockImplementation((request) =>
    request.seedPaperId ? pending.promise : Promise.resolve(explorationResult(request))
  )
  const view = render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await act(async () =>
    pending.resolve(
      result(related.mock.calls[2][0], {
        state: 'unavailable',
        issue: 'reference-changed',
        records: [],
        seed: undefined,
        resolutionToken: undefined
      })
    )
  )
  expect(screen.getByRole('button', { name: 'Add to Inbox' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Set as center' })).toHaveProperty('disabled', true)
  expect(related).toHaveBeenCalledTimes(3)
  view.rerender(
    <LiteratureCitationGraph item={{ ...item, metadataRevision: 2 }} onSaved={vi.fn()} />
  )
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  expect(screen.getByRole('button', { name: 'Set as center' })).toHaveProperty('disabled', false)
  expect(related.mock.calls.at(-1)?.[0]).toMatchObject({
    expectedMetadataRevision: 2
  })
})
it('restarts from the original paper after a child capability expires', async () => {
  related.mockImplementation(async (request) =>
    request.seedPaperId
      ? result(request, { state: 'unavailable', issue: 'expired', records: [], seed: record('b') })
      : explorationResult(request)
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await screen.findByText('These results expired. Search again.')
  fireEvent.click(screen.getByRole('button', { name: 'Reload from starting paper' }))
  await screen.findByRole('button', { name: 'Select Paper c' })
  expect(screen.queryByText('Temporary center')).toBeNull()
  expect(related.mock.calls.at(-2)?.[0]).toMatchObject({
    itemId: 'local',
    resolutionToken: undefined
  })
  expect(related.mock.calls.at(-2)?.[0]).not.toHaveProperty('seedPaperId')
})
it('discards old child requests when the root metadata revision changes', async () => {
  const pending = deferred<LiteratureRelatedResult>()
  related.mockImplementation((request) =>
    request.seedPaperId ? pending.promise : Promise.resolve(explorationResult(request))
  )
  const view = render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  view.rerender(
    <LiteratureCitationGraph item={{ ...item, metadataRevision: 2 }} onSaved={vi.fn()} />
  )
  await screen.findByRole('button', { name: 'Select Paper c' })
  await act(async () => pending.resolve(explorationResult(related.mock.calls[2][0])))
  expect(screen.queryByRole('button', { name: 'Select Paper d' })).toBeNull()
  expect(related.mock.calls.filter(([request]) => request.seedPaperId)).toHaveLength(1)
})
it('bounds cached centers while retaining the original paper without refetching it', async () => {
  const chain = (number: number): LiteratureRelatedRecord => ({
    paperId: `europe-pmc:MED:${number + 1}`,
    item: literatureItemInputSchema.parse({ itemType: 'document', title: `Chain ${number}` })
  })
  related.mockImplementation(async (request) => {
    const number = request.seedPaperId ? Number(request.seedPaperId.split(':').at(-1)) - 1 : 0
    return result(request, { seed: chain(number), records: [chain(number + 1)] })
  })
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  for (let next = 1; next <= 9; next++) {
    fireEvent.click(await screen.findByRole('button', { name: `Select Chain ${next}` }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Set as center' })).toHaveProperty(
        'disabled',
        false
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
    await screen.findByRole('button', { name: `Select Chain ${next + 1}` })
  }
  expect(document.querySelectorAll('[data-current-frame]')).toHaveLength(8)
  const count = related.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Original paper' }))
  expect(screen.getByRole('button', { name: 'Select Chain 1' })).toBeTruthy()
  expect(related).toHaveBeenCalledTimes(count)
  expect(transact).not.toHaveBeenCalled()
})
it('freezes the initial camera and existing coordinates while paging, then fits only on request', async () => {
  const paper = (number: number): LiteratureRelatedRecord => ({
    paperId: `europe-pmc:MED:${number + 1}`,
    item: literatureItemInputSchema.parse({ itemType: 'document', title: `Layout ${number}` })
  })
  related.mockImplementation(async (request) =>
    result(
      request,
      request.direction === 'citations'
        ? { records: [] }
        : request.offset
          ? { records: Array.from({ length: 20 }, (_, index) => paper(index + 21)) }
          : { records: Array.from({ length: 20 }, (_, index) => paper(index + 1)), nextOffset: 20 }
    )
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Layout 20' })
  showPaperList()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Load more' })).toHaveProperty('disabled', false)
  )
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  const originalCamera = svg.getAttribute('viewBox')
  const originalCircle = screen
    .getByRole('button', { name: 'Select Layout 1' })
    .querySelector('[data-node-mark]')!
  const position = [originalCircle.getAttribute('data-x'), originalCircle.getAttribute('data-y')]
  fireEvent.click(screen.getByRole('button', { name: 'Select Layout 1' }))
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('button', { name: 'Select Layout 21' })
  expect(svg.getAttribute('viewBox')).toBe(originalCamera)
  expect([originalCircle.getAttribute('data-x'), originalCircle.getAttribute('data-y')]).toEqual(
    position
  )
  expect(screen.getByRole('button', { name: 'Select Layout 1' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(
    screen.getByText(
      'New papers are outside the current view. Fit the graph to see all loaded papers.'
    )
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Fit graph' }))
  expect(svg.getAttribute('viewBox')).not.toBe(originalCamera)
  expect(
    screen.queryByText(
      'New papers are outside the current view. Fit the graph to see all loaded papers.'
    )
  ).toBeNull()
  const canvas = svg.closest<HTMLElement>('[data-citation-canvas]')!
  attachCapture(canvas)
  dispatchPointer(canvas, 'pointerdown')
  dispatchPointer(canvas, 'pointermove', { clientX: 10000 })
  dispatchPointer(canvas, 'pointerup')
  expect(
    screen.queryByText(
      'New papers are outside the current view. Fit the graph to see all loaded papers.'
    )
  ).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Fit graph' }))
  expect(
    screen.queryByText(
      'New papers are outside the current view. Fit the graph to see all loaded papers.'
    )
  ).toBeNull()
  expect(screen.getByRole('button', { name: 'Select Layout 1' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
})

it('renders radial relationship regions with arrowheads matching edge emphasis', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  const center = screen
    .getByRole('button', { name: 'Center paper: Center' })
    .querySelector('[data-node-mark]')!
  const references = screen.getByRole('button', { name: 'Select Paper b' })
  const citations = screen.getByRole('button', { name: 'Select Paper c' })
  for (const paper of [references, citations]) {
    const mark = paper.querySelector('[data-node-mark]')!
    expect(
      Math.hypot(
        Number(mark.getAttribute('data-x')) - Number(center.getAttribute('data-x')),
        Number(mark.getAttribute('data-y')) - Number(center.getAttribute('data-y'))
      )
    ).toBeGreaterThan(0)
  }
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  const paths = [...svg.querySelectorAll<SVGPathElement>('[data-source][data-target]')]
  expect(paths.every((path) => path.dataset.edgeEmphasis === 'center')).toBe(true)
  expect(paths.every((path) => Number(path.dataset.edgeBend) !== 0)).toBe(true)
  expect(paths.every((path) => Number(path.getAttribute('opacity')) > 0)).toBe(true)
  for (const path of paths) {
    const coordinates = path
      .getAttribute('d')!
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number)
    const source = svg.querySelector(`[data-paper-id="${path.dataset.source}"] [data-node-mark]`)!
    const target = svg.querySelector(`[data-paper-id="${path.dataset.target}"] [data-node-mark]`)!
    const distance = (point: Element, x: number, y: number): number =>
      Math.hypot(x - Number(point.getAttribute('data-x')), y - Number(point.getAttribute('data-y')))
    expect(distance(source, coordinates[0], coordinates[1])).toBeLessThan(
      distance(source, coordinates.at(-2)!, coordinates.at(-1)!)
    )
    expect(distance(target, coordinates.at(-2)!, coordinates.at(-1)!)).toBeLessThan(
      distance(target, coordinates[0], coordinates[1])
    )
    const direction = path.dataset.direction
    expect(path.getAttribute('marker-end')).toContain(`-${direction}`)
    const markerId = path.getAttribute('marker-end')!.slice(5, -1)
    expect(svg.querySelector<SVGPathElement>(`[id="${markerId}"] path`)?.getAttribute('fill')).toBe(
      path.style.stroke
    )
  }
  expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true')
  fireEvent.click(references)
  const selectedReference = paths.find((path) => path.dataset.target === paperId('b'))!
  expect(selectedReference.dataset.edgeEmphasis).toBe('related')
  const selectedMarker = selectedReference.getAttribute('marker-end')!.slice(5, -1)
  expect(
    svg.querySelector<SVGPathElement>(`[id="${selectedMarker}"] path`)?.getAttribute('fill')
  ).toBe(selectedReference.style.stroke)
  expect(Number(selectedReference.getAttribute('opacity'))).toBeGreaterThan(
    Number(paths.find((path) => path.dataset.target === paperId('a'))!.getAttribute('opacity'))
  )
  expect(references.querySelector('[data-node-mark]')?.getAttribute('data-node-kind')).toBe(
    'circle'
  )
  expect(
    within(screen.getByRole('region', { name: 'Selected paper' })).queryByText('References')
  ).toBeNull()
  const legendId = references.getAttribute('aria-describedby')!.split(/\s+/)[0]
  expect(document.getElementById(legendId)?.textContent).toContain('Papers this paper references')
  const arrowMeaning = screen.getByText('A → B means A cites B.')
  expect(svg.getAttribute('aria-describedby')).toBe(arrowMeaning.id)
  expect(arrowMeaning.classList.contains('sr-only')).toBe(false)
})
it('renders mutual citations as one selectable paper with two differently curved true edges', async () => {
  related.mockImplementation(async (request) => result(request, { records: [record('b')] }))
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Select Paper b' }).getAttribute('data-relation')
    ).toBe('both')
  )
  expect(screen.getAllByRole('button', { name: 'Select Paper b' })).toHaveLength(1)
  expect(
    screen
      .getByRole('button', { name: 'Select Paper b' })
      .querySelector('[data-node-mark]')
      ?.getAttribute('data-node-kind')
  ).toBe('both')
  expect(
    screen
      .getByRole('button', { name: 'Select Paper b' })
      .querySelector('[data-node-kind="diamond"]')
  ).toBeTruthy()
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  const paths = [...svg.querySelectorAll<SVGPathElement>('[data-source][data-target]')]
  expect(paths).toHaveLength(2)
  expect(new Set(paths.map((path) => path.dataset.direction))).toEqual(
    new Set(['references', 'citations'])
  )
  const controls = paths.map((path) =>
    path
      .getAttribute('d')!
      .match(/-?\d+(?:\.\d+)?/g)!
      .map(Number)
      .slice(2, 4)
  )
  expect(controls[0]).not.toEqual(controls[1])
  expect(paths.every((path) => path.dataset.edgeBend === '28')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  expect(
    within(screen.getByRole('region', { name: 'Selected paper' })).getByRole('heading', {
      name: 'Paper b'
    })
  ).toBeTruthy()
  const mutualNode = screen.getByRole('button', { name: 'Select Paper b' })
  expect(mutualNode.querySelector('[data-node-mark]')?.getAttribute('data-node-kind')).toBe('both')
  expect(mutualNode.querySelector('[data-node-kind="diamond"]')).toBeTruthy()
  for (const filter of ['References', 'Cited by']) {
    fireEvent.click(screen.getByRole('tab', { name: filter }))
    const filteredMutual = screen.getByRole('button', { name: 'Select Paper b' })
    expect(filteredMutual.querySelector('[data-node-mark]')?.getAttribute('data-node-kind')).toBe(
      'both'
    )
    expect(filteredMutual.querySelector('[data-node-kind="diamond"]')).toBeTruthy()
  }
  expect(transact).not.toHaveBeenCalled()
})

it('shows loaded counts beside pagination without presenting source totals', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  expect(
    within(screen.getByRole('region', { name: 'References' })).getByText('Loaded: 1')
  ).toBeTruthy()
  showCategory('citations')
  const citing = within(screen.getByRole('region', { name: 'Papers citing this paper' }))
  expect(citing.getByText('Loaded: 1')).toBeTruthy()
  expect(citing.getByText('Loaded results only; source coverage may be incomplete.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'About this citation graph' })).toBeNull()
})

it('keeps full author and missing-year descriptions while the visible pill preserves a compact label', async () => {
  const known = record('b')
  known.item.creators = [
    { nameMode: 'organization', creatorType: 'author', literalName: '张三丰李研究团队' }
  ]
  known.item.issuedYear = 2002
  known.item.containerTitle = 'Journal of Graph Studies'
  known.item.typeFields = { volume: '4', issue: '2', pages: '12–18' }
  known.item.identifiers = [{ scheme: 'pmid', value: '12345', isPrimary: true }]
  known.item.url = 'https://example.org/paper'
  const missing = record('c')
  missing.item.creators = [
    {
      nameMode: 'organization',
      creatorType: 'author',
      literalName: 'Wissenschaftlicher Forschungsverbund'
    }
  ]
  related.mockImplementation(async (request) =>
    result(request, { records: [request.direction === 'references' ? known : missing] })
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  const knownNode = await screen.findByRole('button', { name: 'Select Paper b' })
  const missingNode = await screen.findByRole('button', { name: 'Select Paper c' })
  expect(knownNode.querySelector('title')?.textContent).toContain('张三丰李研究团队')
  expect(knownNode.querySelector('title')?.textContent).toContain('2002')
  expect(missingNode.querySelector('title')?.textContent).toContain('No year')
  const metadataId = missingNode.getAttribute('aria-describedby')!.split(/\s+/)[1]
  expect(document.getElementById(metadataId)?.textContent).toContain(
    'Wissenschaftlicher Forschungsverbund'
  )
  expect(document.getElementById(metadataId)?.textContent).toContain('No year')
  expect(
    [...knownNode.querySelectorAll('text')].some((text) => text.textContent?.endsWith(' 2002'))
  ).toBe(true)
  expect(
    [...missingNode.querySelectorAll('text')].some((text) => text.textContent?.endsWith(' —'))
  ).toBe(true)
  fireEvent.click(knownNode)
  const details = screen.getByRole('region', { name: 'Selected paper' })
  expect(within(details).getByText('张三丰李研究团队')).toBeTruthy()
  expect(within(details).getByText('Journal of Graph Studies. 2002;4(2):12–18')).toBeTruthy()
  expect(within(details).getByRole('link', { name: 'PMID: 12345' }).getAttribute('href')).toContain(
    '12345'
  )
  const explore = within(details).getByRole('button', { name: 'Set as center' })
  const save = within(details).getByRole('button', { name: 'Add to Inbox' })
  expect(explore.parentElement).toBe(save.parentElement)
  expect(transact).not.toHaveBeenCalled()
})

const dispatchPointer = (
  target: Element,
  type: string,
  extra: Partial<{
    pointerId: number
    isPrimary: boolean
    button: number
    clientX: number
    clientY: number
  }> = {}
): void => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 0,
    clientY: 0,
    ...extra
  })
  fireEvent(target, event)
}
const attachCapture = (
  element: HTMLElement
): { capture: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } => {
  let captured: number | undefined
  const capture = vi.fn((pointerId: number) => {
    captured = pointerId
  })
  const release = vi.fn(() => {
    captured = undefined
  })
  Object.defineProperties(element, {
    setPointerCapture: { value: capture },
    hasPointerCapture: { value: (pointerId: number) => captured === pointerId },
    releasePointerCapture: { value: release }
  })
  return { capture, release }
}
it('updates the fixed inspector on selection without requests, writes or focus jumps', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  const root = screen.getByRole('button', { name: 'Center paper: Center' })
  act(() => root.focus())
  const inspector = document.querySelector<HTMLElement>('[data-citation-inspector]')!
  inspector.scrollTop = 200
  fireEvent.scroll(inspector)
  const calls = related.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  expect(
    within(screen.getByRole('region', { name: 'Selected paper' })).getByRole('heading', {
      name: 'Paper b'
    })
  ).toBeTruthy()
  expect(inspector.scrollTop).toBe(0)
  expect(document.activeElement).toBe(root)
  expect(related).toHaveBeenCalledTimes(calls)
  expect(transact).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Set as center' })).toBeTruthy()
})
it('restores real cached centers from breadcrumb buttons without querying or saving', async () => {
  related.mockImplementation(async (request) => explorationResult(request))
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await screen.findByRole('button', { name: 'Select Paper e' })
  const path = screen.getByRole('navigation', { name: 'Exploration path' })
  expect(within(path).getByRole('button', { name: 'Paper b' }).getAttribute('aria-current')).toBe(
    'page'
  )
  const count = related.mock.calls.length
  fireEvent.click(within(path).getByRole('button', { name: 'Center' }))
  expect(screen.getByRole('button', { name: 'Select Paper b' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(within(path).getByRole('button', { name: 'Center' }).getAttribute('aria-current')).toBe(
    'page'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  expect(screen.getByRole('button', { name: 'Select Paper e' })).toBeTruthy()
  expect(related).toHaveBeenCalledTimes(count)
  expect(transact).not.toHaveBeenCalled()
})
it.each(['pointerup', 'pointercancel', 'lostpointercapture'])(
  'pans only the background and stops after %s',
  async (ending) => {
    render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
    await screen.findByRole('button', { name: 'Select Paper c' })
    const viewport = screen.getByRole('region', { name: 'Citation graph' })
    const svg = screen.getByRole('group', { name: 'Citation graph' })
    const { capture, release } = attachCapture(viewport)
    dispatchPointer(screen.getByRole('button', { name: 'Select Paper b' }), 'pointerdown')
    expect(capture).not.toHaveBeenCalled()
    dispatchPointer(viewport, 'pointerdown', { isPrimary: false })
    expect(capture).not.toHaveBeenCalled()
    dispatchPointer(viewport, 'pointerdown', { button: 2 })
    expect(capture).not.toHaveBeenCalled()
    dispatchPointer(viewport, 'pointerdown', { clientX: 10, clientY: 20 })
    dispatchPointer(viewport, 'pointermove', { clientX: 50, clientY: 70 })
    expect(svg.getAttribute('data-pan-x')).toBe('40')
    expect(svg.getAttribute('data-pan-y')).toBe('50')
    dispatchPointer(viewport, ending)
    expect(release).toHaveBeenCalledTimes(1)
    dispatchPointer(viewport, 'pointermove', { clientX: 90, clientY: 90 })
    expect(svg.getAttribute('data-pan-x')).toBe('40')
    const paper = screen.getByRole('button', { name: 'Select Paper b' })
    if (ending === 'pointerup') {
      fireEvent.click(paper)
      expect(
        screen.getByRole('button', { name: 'Center paper: Center' }).getAttribute('aria-pressed')
      ).toBe('true')
    }
    dispatchPointer(paper, 'pointerdown', { pointerId: 2 })
    dispatchPointer(paper, 'pointerup', { pointerId: 2 })
    fireEvent.click(paper)
    expect(paper.getAttribute('aria-pressed')).toBe('true')
    fireEvent.wheel(viewport, { deltaX: 5, deltaY: 10 })
    expect(Number(svg.getAttribute('data-zoom'))).toBeCloseTo(Math.exp(-0.02))
    expect(Number(svg.getAttribute('data-pan-x'))).toBeCloseTo(40 * Math.exp(-0.02))
    expect(Number(svg.getAttribute('data-pan-y'))).toBeCloseTo(50 * Math.exp(-0.02))
    expect(related).toHaveBeenCalledTimes(2)
    expect(transact).not.toHaveBeenCalled()
  }
)
it('releases pointer capture when hidden or unmounted and restores the frame pan', async () => {
  const view = render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  const viewport = screen.getByRole('region', { name: 'Citation graph' })
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  const { release } = attachCapture(viewport)
  dispatchPointer(viewport, 'pointerdown')
  dispatchPointer(viewport, 'pointermove', { clientX: 40, clientY: 25 })
  view.rerender(<LiteratureCitationGraph item={item} onSaved={vi.fn()} visible={false} />)
  expect(release).toHaveBeenCalledTimes(1)
  dispatchPointer(viewport, 'pointermove', { clientX: 90, clientY: 90 })
  expect(svg.getAttribute('data-pan-x')).toBe('40')
  view.rerender(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  expect(svg.getAttribute('data-pan-y')).toBe('25')
  dispatchPointer(viewport, 'pointerdown', { pointerId: 2 })
  view.unmount()
  expect(release).toHaveBeenCalledTimes(2)
})
it('keeps node shape semantics stable across paging and zoom and offers a direct keyboard inspector path', async () => {
  const shape = (number: number): LiteratureRelatedRecord => ({
    paperId: `europe-pmc:MED:${number + 1}`,
    item: literatureItemInputSchema.parse({ itemType: 'document', title: `Shape ${number}` })
  })
  related.mockImplementation(async (request) =>
    result(
      request,
      request.direction === 'citations'
        ? {}
        : request.offset
          ? { records: Array.from({ length: 20 }, (_, index) => shape(index + 6)) }
          : { records: Array.from({ length: 5 }, (_, index) => shape(index + 1)), nextOffset: 20 }
    )
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  let svg = screen.getByRole('group', { name: 'Citation graph' })
  expect(
    [...svg.querySelectorAll('[data-node-mark]')].every((node) =>
      ['circle', 'polygon'].includes(node.tagName.toLowerCase())
    )
  ).toBe(true)
  const center = screen.getByRole('button', { name: 'Center paper: Center' })
  act(() => center.focus())
  fireEvent.keyDown(center, { key: 'ArrowRight' })
  const first = screen.getByRole('button', { name: 'Select Shape 1' })
  expect(document.activeElement).toBe(first)
  expect(first.getAttribute('tabindex')).toBe('0')
  expect(
    [...svg.querySelectorAll('g[role="button"]')].filter(
      (node) => node.getAttribute('tabindex') === '0'
    )
  ).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'View selected paper' }))
  expect(document.activeElement?.hasAttribute('data-citation-inspector-title')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('button', { name: 'Select Shape 25' })
  svg = screen.getByRole('group', { name: 'Citation graph' })
  expect(svg.querySelectorAll('[data-node-mark]')).toHaveLength(27)
  expect(
    [...svg.querySelectorAll('[data-node-mark]')].every((node) =>
      ['circle', 'polygon'].includes(node.tagName.toLowerCase())
    )
  ).toBe(true)
  expect(
    screen
      .getByRole('button', { name: 'Select Shape 1' })
      .querySelector('[data-node-mark]')
      ?.getAttribute('r')
  ).toBeCloseTo(15.4, 5)
})
it('keeps the selected alias in the inspector when a new record bridges two existing papers', async () => {
  const left = record('b')
  left.item.identifiers = [{ scheme: 'doi', value: '10.1234/bridge', isPrimary: true }]
  const right = record('c')
  right.item.identifiers = [{ scheme: 'pmid', value: '123', isPrimary: true }]
  const bridge = record('d')
  bridge.item.identifiers = [
    { scheme: 'doi', value: 'https://doi.org/10.1234/BRIDGE', isPrimary: true },
    { scheme: 'pmid', value: 'PMID:123', isPrimary: true }
  ]
  related.mockImplementation(async (request) =>
    result(
      request,
      request.direction === 'citations'
        ? { records: [] }
        : request.offset
          ? { records: [bridge] }
          : { records: [left, right], nextOffset: 20 }
    )
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper c' }))
  showPaperList()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Load more' })).toHaveProperty('disabled', false)
  )
  const inspector = document.querySelector<HTMLElement>('[data-citation-inspector]')!
  inspector.scrollTop = 150
  fireEvent.scroll(inspector)
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Select Paper c' })).toBeNull())
  expect(screen.getByRole('button', { name: 'Select Paper b' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(
    within(screen.getByRole('region', { name: 'Selected paper' })).getByRole('heading', {
      name: 'Paper b'
    })
  ).toBeTruthy()
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  expect(svg.querySelectorAll('g[role="button"][tabindex="0"]')).toHaveLength(1)
  expect(
    screen.getByRole('button', { name: 'Center paper: Center' }).getAttribute('aria-pressed')
  ).toBe('false')
  expect(inspector.scrollTop).toBe(150)
  expect(transact).not.toHaveBeenCalled()
})

it('keeps primary inspector actions outside its independently scrolling paper body', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  const body = document.querySelector<HTMLElement>('[data-citation-inspector]')!
  const details = screen.getByRole('region', { name: 'Selected paper' })
  const center = within(details).getByRole('button', { name: 'Set as center' })
  const save = within(details).getByRole('button', { name: 'Add to Inbox' })
  expect(body.contains(center)).toBe(false)
  expect(body.contains(save)).toBe(false)
  const actions = center.closest('[data-citation-inspector-actions]')!
  expect(actions).toBeTruthy()
  const primaryActions = actions.querySelector('[data-citation-inspector-primary-actions]')!
  expect(primaryActions.contains(center)).toBe(true)
  expect(primaryActions.contains(save)).toBe(true)
  body.scrollTop = 400
  fireEvent.scroll(body)
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper c' }))
  expect(body.scrollTop).toBe(0)
  expect(within(details).getByRole('heading', { name: 'Paper c' })).toBeTruthy()
  expect(within(details).getByRole('button', { name: 'Set as center' })).toBeTruthy()
  expect(related).toHaveBeenCalledTimes(2)
  expect(transact).not.toHaveBeenCalled()
})
it('shows and dismisses complete titles from the expanded hit area and keyboard focus', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  const paper = await screen.findByRole('button', { name: 'Select Paper c' })
  const hit = document.querySelector(`[data-node-hit="${paperId('c')}"]`)!
  expect(document.querySelector('[data-citation-hover-title]')).toBeNull()
  fireEvent.mouseEnter(hit)
  expect(document.querySelector('[data-citation-hover-title]')?.textContent).toBe('Paper c')
  fireEvent.mouseLeave(hit)
  await waitFor(() => expect(document.querySelector('[data-citation-hover-title]')).toBeNull())
  fireEvent.focus(paper)
  expect(document.querySelector('[data-citation-hover-title]')?.textContent).toBe('Paper c')
  fireEvent.blur(paper)
  await waitFor(() => expect(document.querySelector('[data-citation-hover-title]')).toBeNull())
})

it('resolves overlapping hit rectangles to the true nearest mark and focuses that canvas node', async () => {
  related.mockImplementation(async (request) =>
    result(request, {
      records: request.direction === 'references' ? [record('b'), record('c')] : []
    })
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  const scene = svg.querySelector('[data-citation-scene]')!
  Object.defineProperty(scene, 'getScreenCTM', {
    value: () => ({ a: 0.1, b: 0, c: 0, d: 0.1, e: 0, f: 0 })
  })
  const covered = svg.querySelector(`[data-node-hit="${paperId('c')}"]`)!
  const expected = screen.getByRole('button', { name: 'Select Paper b' })
  const expectedMark = expected.querySelector('[data-node-mark]')!
  fireEvent.mouseMove(covered, {
    clientX: Number(expectedMark.getAttribute('data-x')) * 0.1,
    clientY: Number(expectedMark.getAttribute('data-y')) * 0.1
  })
  expect(screen.getByRole('tooltip').textContent).toBe('Paper b')
  fireEvent.click(covered, {
    clientX: Number(expectedMark.getAttribute('data-x')) * 0.1,
    clientY: Number(expectedMark.getAttribute('data-y')) * 0.1
  })
  expect(expected.getAttribute('aria-pressed')).toBe('true')
  expect(document.activeElement).toBe(expected)
  expect(expected.querySelector('rect')).toBeNull()
  const hitLayer = covered.parentElement!
  expect(hitLayer.compareDocumentPosition(expected) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.keyDown(expected, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Select Paper c' }))
  expect(screen.getByRole('button', { name: 'Select Paper c' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(related).toHaveBeenCalledTimes(2)
  expect(transact).not.toHaveBeenCalled()
})

it('preserves the graph snapshot when equivalent metadata is refreshed at the same revision', async () => {
  related.mockImplementation(async (request) => explorationResult(request))
  const onSaved = vi.fn()
  const view = render(<LiteratureCitationGraph item={item} onSaved={onSaved} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await screen.findByText('In Inbox')
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  const svg = screen.getByRole('group', { name: 'Citation graph' })
  fireEvent.wheel(svg.parentElement!, { deltaY: 73, deltaX: 91 })
  const inspector = document.querySelector<HTMLElement>('[data-citation-inspector]')!
  inspector.scrollTop = 99
  fireEvent.scroll(inspector)
  const snapshot = (): unknown => {
    const current = screen.getByRole('group', { name: 'Citation graph' })
    return {
      queries: related.mock.calls.length,
      selected: [...current.querySelectorAll('[aria-pressed="true"]')].map((node) =>
        node.getAttribute('data-paper-id')
      ),
      zoom: current.getAttribute('data-zoom'),
      panX: current.getAttribute('data-pan-x'),
      panY: current.getAttribute('data-pan-y'),
      scroll: document.querySelector<HTMLElement>('[data-citation-inspector]')!.scrollTop,
      receipt: Boolean(screen.queryByText('In Inbox'))
    }
  }
  const before = snapshot()
  await act(async () =>
    view.rerender(
      <LiteratureCitationGraph item={{ ...item, item: { ...item.item } }} onSaved={onSaved} />
    )
  )
  expect(snapshot()).toEqual(before)
  expect(transact).toHaveBeenCalledTimes(1)
  expect(onSaved).toHaveBeenCalledTimes(1)
})

it('holds the owner save guard through an equivalent metadata refresh until the transaction settles', async () => {
  const pending = deferred<{ kind: 'candidate'; id: string; state: 'pending' }>()
  transact.mockReturnValue(pending.promise)
  const onSaved = vi.fn()
  const onSavingChange = vi.fn()
  const view = render(
    <LiteratureCitationGraph item={item} onSaved={onSaved} onSavingChange={onSavingChange} />
  )
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  expect(onSavingChange.mock.calls).toEqual([[true]])
  expect(transact).toHaveBeenCalledTimes(1)
  await act(async () =>
    view.rerender(
      <LiteratureCitationGraph
        item={{ ...item, item: { ...item.item } }}
        onSaved={onSaved}
        onSavingChange={onSavingChange}
      />
    )
  )
  expect(related).toHaveBeenCalledTimes(2)
  expect(onSavingChange.mock.calls).toEqual([[true]])
  expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Set as center' })).toHaveProperty('disabled', true)
  expect(onSaved).not.toHaveBeenCalled()
  await act(async () => pending.resolve({ kind: 'candidate', id: 'saved', state: 'pending' }))
  expect(screen.getByText('In Inbox')).toBeTruthy()
  expect(onSavingChange.mock.calls).toEqual([[true], [false]])
  expect(onSaved).toHaveBeenCalledTimes(1)
  expect(transact).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Set as center' })).toHaveProperty('disabled', false)
})

it('does not let an old save completion release a new revision owner or publish its receipt', async () => {
  const oldSave = deferred<{ kind: 'candidate'; id: string; state: 'pending' }>()
  const newSave = deferred<{ kind: 'candidate'; id: string; state: 'pending' }>()
  transact.mockReturnValueOnce(oldSave.promise).mockReturnValueOnce(newSave.promise)
  const onSaved = vi.fn()
  const onSavingChange = vi.fn()
  const view = render(
    <LiteratureCitationGraph item={item} onSaved={onSaved} onSavingChange={onSavingChange} />
  )
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  view.rerender(
    <LiteratureCitationGraph
      item={{ ...item, metadataRevision: 2 }}
      onSaved={onSaved}
      onSavingChange={onSavingChange}
    />
  )
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  expect(transact).toHaveBeenCalledTimes(2)
  expect(onSavingChange.mock.calls).toEqual([[true], [false], [true]])
  await act(async () => oldSave.resolve({ kind: 'candidate', id: 'old', state: 'pending' }))
  expect(onSavingChange.mock.calls).toEqual([[true], [false], [true]])
  expect(onSaved).not.toHaveBeenCalled()
  expect(screen.queryByText('In Inbox')).toBeNull()
  expect(screen.getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true)
  await act(async () => newSave.resolve({ kind: 'candidate', id: 'new', state: 'pending' }))
  expect(onSavingChange.mock.calls).toEqual([[true], [false], [true], [false]])
  expect(onSaved).toHaveBeenCalledTimes(1)
  expect(screen.getByText('In Inbox')).toBeTruthy()
})

it('does not publish a save receipt if the owner leaves while releasing its save lock', async () => {
  const pending = deferred<{ kind: 'candidate'; id: string; state: 'pending' }>()
  transact.mockReturnValue(pending.promise)
  const onSaved = vi.fn()
  let exitOnRelease = false
  const onSavingChange = (saving: boolean): void => {
    if (!saving && exitOnRelease) {
      exitOnRelease = false
      view.unmount()
    }
  }
  const view = render(
    <LiteratureCitationGraph item={item} onSaved={onSaved} onSavingChange={onSavingChange} />
  )
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  exitOnRelease = true
  await act(async () => pending.resolve({ kind: 'candidate', id: 'saved', state: 'pending' }))
  expect(screen.queryByRole('group', { name: 'Citation graph' })).toBeNull()
  expect(onSaved).not.toHaveBeenCalled()
  expect(transact).toHaveBeenCalledTimes(1)
})

it('completes ready root pagination while a hidden child first page remains pending', async () => {
  const pending = deferred<LiteratureRelatedResult>()
  const childCompleted = vi.fn()
  void pending.promise.then(childCompleted)
  related.mockImplementation((request) => {
    if (request.seedPaperId && request.direction === 'references') return pending.promise
    return Promise.resolve(
      request.offset === 20
        ? result(request, { records: [record('f')] })
        : explorationResult(request)
    )
  })
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Set as center' }))
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  try {
    showPaperList()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load more' })))
    expect(related.mock.calls.at(-1)?.[0]).toMatchObject({
      direction: 'references',
      offset: 20,
      resolutionToken: token
    })
    expect(related.mock.calls.at(-1)?.[0].seedPaperId).toBeUndefined()
    expect(screen.getByRole('button', { name: 'Select Paper f' })).toBeTruthy()
    expect(childCompleted).not.toHaveBeenCalled()
    expect(transact).not.toHaveBeenCalled()
  } finally {
    await act(async () => pending.resolve(explorationResult(related.mock.calls[2][0])))
  }
})

it('rejects a foreign provider on the first page before a graph seed is established', async () => {
  related.mockImplementation(async (request) =>
    result(request, {
      provider: 'opencitations',
      seed: { ...record('a'), paperId: 'opencitations:br/1' },
      records: [
        {
          paperId: 'opencitations:br/2',
          item: literatureItemInputSchema.parse({
            itemType: 'document',
            title: 'Foreign OC neighbor',
            url: 'https://w3id.org/oc/meta/br/2'
          })
        }
      ]
    })
  )
  render(<LiteratureCitationGraph item={item} provider="europe-pmc" onSaved={vi.fn()} />)
  await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('button', { name: 'Select Foreign OC neighbor' })).toBeNull()
  for (const direction of ['references', 'citations'] as const) {
    showCategory(direction)
    await screen.findByText('Citation discovery is temporarily unavailable. Try again.')
  }
  expect(screen.getByText('Source: Europe PMC')).toBeTruthy()
  expect(related.mock.calls.every(([request]) => request.provider === 'europe-pmc')).toBe(true)
  expect(transact).not.toHaveBeenCalled()
})

it.each([
  ['Europe PMC', 'europe-pmc'],
  ['OpenCitations · SKG-IF', 'opencitations']
] as const)(
  'keeps a %s graph pinned during pagination failures and rejects a response from another source',
  async (name, provider) => {
    const ep = (id: string): LiteratureRelatedRecord => ({
      paperId: provider === 'europe-pmc' ? `europe-pmc:MED:${id}` : `opencitations:br/${id}`,
      item: literatureItemInputSchema.parse({
        itemType: 'document',
        title: `${name} ${id}`,
        url:
          provider === 'europe-pmc'
            ? `https://europepmc.org/article/MED/${id}`
            : `https://w3id.org/oc/meta/br/${id}`
      })
    })
    let wrongSource = true
    related.mockImplementation(async (request) =>
      result(
        request,
        request.offset === 20 && wrongSource
          ? {
              provider: provider === 'europe-pmc' ? 'opencitations' : 'europe-pmc',
              seed:
                provider === 'europe-pmc'
                  ? { ...record('a'), paperId: 'opencitations:br/99' }
                  : record('a'),
              records:
                provider === 'europe-pmc'
                  ? [{ ...record('d'), paperId: 'opencitations:br/100' }]
                  : [record('d')]
            }
          : {
              provider,
              seed: ep('1'),
              records: [
                ep(request.offset === 20 ? '4' : request.direction === 'references' ? '2' : '3')
              ],
              nextOffset:
                request.offset === 0 && request.direction === 'references' ? 20 : undefined
            }
      )
    )
    render(<LiteratureCitationGraph item={item} provider={provider} onSaved={vi.fn()} />)
    await screen.findByRole('button', { name: `Select ${name} 3` })
    showPaperList()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Citation discovery is temporarily unavailable. Try again.')
    expect(screen.queryByRole('button', { name: 'Select Paper d' })).toBeNull()
    expect(screen.getByRole('button', { name: `Select ${name} 2` })).toBeTruthy()
    expect(screen.getByText(`Source: ${name}`)).toBeTruthy()
    wrongSource = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('button', { name: `Select ${name} 4` })
    expect(related.mock.calls.every(([request]) => request.provider === provider)).toBe(true)
    expect(related.mock.calls.at(-1)?.[0]).toMatchObject({
      provider,
      offset: 20,
      resolutionToken: token
    })
    expect(transact).not.toHaveBeenCalled()
  }
)

it('names OpenCitations omitted and empty relationships without suggesting another source', async () => {
  related.mockImplementation(async (request) =>
    result(request, {
      provider: 'opencitations',
      seed: { ...record('a'), paperId: 'opencitations:br/1' },
      records: [],
      omitted: 1
    })
  )
  render(<LiteratureCitationGraph item={item} provider="opencitations" onSaved={vi.fn()} />)
  for (const direction of ['references', 'citations'] as const) {
    showCategory(direction)
    await screen.findByText(
      'OpenCitations · SKG-IF did not provide relationships for this page; the paper may still have references or citations.'
    )
    expect(
      screen.getByText(
        'Some relationships could not be matched to a record in OpenCitations · SKG-IF and are not shown.'
      )
    ).toBeTruthy()
  }
  expect(screen.getByText('Source: OpenCitations · SKG-IF')).toBeTruthy()
  expect(screen.queryByText('Source: Europe PMC')).toBeNull()
})

it('rejects a different OpenCitations mode during Index graph paging and retries the same cursor', async () => {
  let wrongMode = true
  related.mockImplementation(async (request) =>
    result(request, {
      provider: 'opencitations',
      opencitationsMode: request.offset === 20 && wrongMode ? 'skg-if' : 'index',
      seed: { ...record('a'), paperId: 'opencitations:br/1' },
      records: [
        {
          ...record('b'),
          paperId: `opencitations:br/${request.offset === 20 ? '4' : request.direction === 'references' ? '2' : '3'}`,
          item: literatureItemInputSchema.parse({
            itemType: 'document',
            title: request.offset === 20 ? 'Index next page' : 'Index first page'
          })
        }
      ],
      nextOffset: request.offset === 0 && request.direction === 'references' ? 20 : undefined
    })
  )
  render(<LiteratureCitationGraph item={item} provider="opencitations-index" onSaved={vi.fn()} />)
  await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
  showPaperList()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByText('Citation discovery is temporarily unavailable. Try again.')
  expect(screen.queryByRole('button', { name: 'Select Index next page' })).toBeNull()
  expect(screen.getByText('Source: OpenCitations · Index v2')).toBeTruthy()
  wrongMode = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: 'Select Index next page' })
  expect(
    related.mock.calls
      .slice(-2)
      .map(([request]) => ({ mode: request.opencitationsMode, offset: request.offset }))
  ).toEqual([
    { mode: 'index', offset: 20 },
    { mode: 'index', offset: 20 }
  ])
  expect(transact).not.toHaveBeenCalled()
})

it('defaults an independent graph to Europe PMC and keeps failures on that source', async () => {
  related.mockImplementation(async (request) =>
    result(request, {
      provider: 'europe-pmc',
      state: 'unavailable',
      issue: 'unavailable',
      seed: undefined,
      records: [],
      resolutionToken: undefined
    })
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await waitFor(() => expect(related).toHaveBeenCalledTimes(2))
  expect(screen.getByText('Source: Europe PMC')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0])
  await waitFor(() => expect(related).toHaveBeenCalledTimes(3))
  expect(related.mock.calls.every(([request]) => request.provider === 'europe-pmc')).toBe(true)
})

it('shows loaded papers beside the graph, retries within their group and restores list position', async () => {
  let pages = 0
  related.mockImplementation(async (request) =>
    result(
      request,
      request.direction === 'citations'
        ? { records: [] }
        : !request.offset
          ? { records: [record('b')], nextOffset: 20 }
          : ++pages === 1
            ? { state: 'unavailable', records: [], issue: 'response-invalid' }
            : { records: [record('c')] }
    )
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  const list = await screen.findByRole('region', { name: 'Paper list' })
  await within(list).findByRole('button', { name: 'Paper b' })
  expect(document.querySelector('[data-citation-canvas] [data-citation-status]')).toBeNull()
  let references = within(list).getByRole('region', { name: 'References' })
  fireEvent.click(within(references).getByRole('button', { name: 'Load more' }))
  await within(references).findByRole('alert')
  expect(within(references).getByRole('button', { name: 'Paper b' })).toBeTruthy()
  showCategory('citations')
  expect(screen.queryByRole('alert')).toBeNull()
  showCategory('references')
  references = within(list).getByRole('region', { name: 'References' })
  fireEvent.click(within(references).getByRole('button', { name: 'Retry' }))
  await within(list).findByRole('button', { name: 'Paper c' })
  expect(related.mock.calls.filter(([request]) => request.offset === 20)).toHaveLength(2)
  const scroll = document.querySelector<HTMLElement>('[data-citation-inspector]')!
  scroll.scrollTop = 220
  fireEvent.scroll(scroll)
  fireEvent.click(within(list).getByRole('button', { name: 'Paper c' }))
  expect(scroll.scrollTop).toBe(220)
  expect(within(list).getByRole('button', { name: 'Set as center' })).toBeTruthy()
  expect(within(list).getByRole('button', { name: 'Add to Inbox' })).toBeTruthy()
  fireEvent.click(within(list).getByRole('button', { name: 'View details' }))
  expect(screen.queryByRole('region', { name: 'Paper list' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Select Paper c' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
  expect(scroll.scrollTop).toBe(220)
  expect(related).toHaveBeenCalledTimes(4)
  expect(transact).not.toHaveBeenCalled()
})

it('discloses the paper list separately and returns to selected details without querying or saving', async () => {
  const reference = record('b')
  reference.item.containerTitle = 'Selected journal'
  related.mockImplementation(async (request) =>
    result(request, request.direction === 'references' ? { records: [reference] } : {})
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Select Paper b' }))
  const details = screen.getByRole('region', { name: 'Selected paper' })
  const listToggle = within(details).getByRole('button', { name: 'Back to list' })
  expect(listToggle.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(listToggle)
  expect(listToggle.getAttribute('aria-expanded')).toBe('true')
  expect(within(details).getByRole('button', { name: /Paper b.*Selected journal/ })).toBeTruthy()
  expect(within(details).getByRole('button', { name: 'Add to Inbox' })).toBeTruthy()
  showCategory('citations')
  const list = within(details).getByRole('region', { name: 'Paper list' })
  fireEvent.click(within(list).getByRole('button', { name: 'Paper c' }))
  expect(listToggle.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(within(list).getByRole('button', { name: 'View details' }))
  expect(listToggle.getAttribute('aria-expanded')).toBe('false')
  expect(within(details).getByRole('heading', { name: 'Paper c' })).toBe(document.activeElement)
  expect(screen.getByRole('button', { name: 'Select Paper c' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  expect(related).toHaveBeenCalledTimes(2)
  expect(transact).not.toHaveBeenCalled()
})

it('keeps narrow details recoverable, opens them on selection and preserves camera on collapse', async () => {
  const originalWidth = window.innerWidth
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
  try {
    render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
    await screen.findByRole('button', { name: 'Select Paper c' })
    const toggle = screen.getByRole('button', { name: 'Expand sidebar panel' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Add to Inbox' })).toBeNull()
    const node = screen.getByRole('button', { name: 'Select Paper b' })
    act(() => node.focus())
    fireEvent.click(node)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(node)
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    const svg = screen.getByRole('group', { name: 'Citation graph' })
    const camera = svg.getAttribute('viewBox')
    const action = screen.getByRole('button', { name: 'Add to Inbox' })
    act(() => action.focus())
    fireEvent.keyDown(action, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute('aria-label')).toBe('Expand sidebar panel')
    expect(svg.getAttribute('viewBox')).toBe(camera)
    fireEvent.click(screen.getByRole('button', { name: 'View selected paper' }))
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.hasAttribute('data-citation-inspector-title')).toBe(true)
    expect(screen.getByRole('button', { name: 'Add to Inbox' })).toBeTruthy()
    expect(transact).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  }
})

it('restores the outer inspector scroll on selection, explicit viewing and collapse', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Select Paper b' }))
  const pane = screen.getByRole('region', { name: 'Selected paper' })
  const body = pane.querySelector<HTMLElement>('[data-citation-inspector]')!
  pane.scrollTop = 80
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper c' }))
  expect(pane.scrollTop).toBe(0)
  expect(within(pane).getByRole('heading', { name: 'Paper c' })).toBeTruthy()

  pane.scrollTop = 90
  body.scrollTop = 30
  fireEvent.click(screen.getByRole('button', { name: 'View selected paper' }))
  expect(pane.scrollTop).toBe(0)
  expect(body.scrollTop).toBe(0)
  expect(document.activeElement).toBe(within(pane).getByRole('heading', { name: 'Paper c' }))

  pane.scrollTop = 100
  const action = screen.getByRole('button', { name: 'Add to Inbox' })
  act(() => action.focus())
  fireEvent.keyDown(action, { key: 'Escape' })
  const toggle = screen.getByRole('button', { name: 'Expand sidebar panel' })
  expect(pane.scrollTop).toBe(0)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(toggle)
  fireEvent.click(toggle)
  expect(pane.scrollTop).toBe(0)
  expect(screen.getByRole('button', { name: 'Add to Inbox' })).toBeTruthy()
  expect(transact).not.toHaveBeenCalled()
})

it('rescues focus to the details disclosure when resizing hides its focused action', async () => {
  let resized: (() => void) | undefined
  const originalMatchMedia = window.matchMedia
  const media = {
    matches: true,
    addEventListener: (_event: string, callback: () => void) => {
      resized = callback
    },
    removeEventListener: vi.fn()
  }
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => media })
  try {
    render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select Paper b' }))
    const action = screen.getByRole('button', { name: 'Add to Inbox' })
    act(() => action.focus())
    act(() => {
      media.matches = false
      resized?.()
    })
    const toggle = screen.getByRole('button', { name: 'Expand sidebar panel' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    expect(screen.queryByRole('button', { name: 'Add to Inbox' })).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Add to Inbox' })).toBeTruthy()
  } finally {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia })
  }
})

it('lets a second Escape leave the collapsed inspector without opening a focus-restoration tooltip', async () => {
  const leave = vi.fn()
  render(
    <div onKeyDown={leave}>
      <LiteratureCitationGraph item={item} onSaved={vi.fn()} />
    </div>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Select Paper b' }))
  const action = screen.getByRole('button', { name: 'Add to Inbox' })
  act(() => action.focus())
  fireEvent.keyDown(action, { key: 'Escape' })
  const toggle = screen.getByRole('button', { name: 'Expand sidebar panel' })
  expect(document.activeElement).toBe(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.getAttribute('title')).toBe('Expand sidebar panel')
  // A Radix Tooltip trigger would create an Escape-consuming layer on this restored focus.
  expect(toggle.hasAttribute('data-state')).toBe(false)
  expect(leave).not.toHaveBeenCalled()
  fireEvent.keyDown(toggle, { key: 'Escape' })
  expect(leave).toHaveBeenCalledTimes(1)
  const plot = screen.getByRole('group', { name: 'Citation graph' }).parentElement!
  const canvas = screen.getByRole('region', { name: 'Citation graph' })
  expect(plot.hasAttribute('data-citation-plot')).toBe(true)
  expect(canvas.contains(plot)).toBe(true)
  expect(plot.contains(canvas.querySelector('[data-citation-toolbar]'))).toBe(false)
  expect(plot.contains(canvas.querySelector('[data-citation-regions]'))).toBe(false)
})

it('keeps category scroll independent while retaining both graph directions and cached results', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  const body = document.querySelector<HTMLElement>('[data-citation-inspector]')!
  const tabs = screen.getByRole('tablist', { name: 'Paper list' })
  expect(body.contains(tabs)).toBe(false)
  body.scrollTop = 180
  fireEvent.scroll(body)
  showCategory('citations')
  expect(body.scrollTop).toBe(0)
  expect(screen.queryByRole('region', { name: 'References' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Paper c' })).toBeTruthy()
  body.scrollTop = 90
  fireEvent.scroll(body)
  showCategory('references')
  expect(body.scrollTop).toBe(180)
  expect(screen.getByRole('button', { name: 'Paper b' })).toBeTruthy()
  showCategory('citations')
  expect(body.scrollTop).toBe(90)
  expect(screen.getByRole('button', { name: 'Select Paper b' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Select Paper c' })).toBeTruthy()
  expect(related).toHaveBeenCalledTimes(2)
  expect(transact).not.toHaveBeenCalled()
})

it('resolves visible details once and ignores a previous paper returning late', async () => {
  const first = record('b')
  const second = record('c')
  first.item.identifiers = [{ scheme: 'pmid', value: '100', isPrimary: true }]
  second.item.identifiers = [{ scheme: 'pmid', value: '101', isPrimary: true }]
  const late = deferred<typeof first.item>()
  const lookup = vi
    .fn()
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce({ ...second.item, abstract: 'Verified abstract' })
  Object.assign(window.api.literature, { lookupMetadata: lookup })
  related.mockImplementation(async (request) =>
    result(request, { records: [request.direction === 'references' ? first : second] })
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  const list = within(await screen.findByRole('region', { name: 'Paper list' }))
  fireEvent.click(await list.findByRole('button', { name: 'Paper b' }))
  expect(lookup).not.toHaveBeenCalled()
  fireEvent.click(list.getByRole('button', { name: 'View details' }))
  expect(lookup).toHaveBeenCalledExactlyOnceWith('pmid:100', expect.any(String))
  const requestId = lookup.mock.calls[0][1]
  fireEvent.click(screen.getByRole('button', { name: 'Select Paper c' }))
  await screen.findByText('Verified abstract')
  expect(window.api.literature.cancelRelated).toHaveBeenCalledWith({ requestId })
  await act(async () => late.resolve({ ...first.item, abstract: 'Late abstract' }))
  expect(screen.queryByText('Late abstract')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
  fireEvent.click(screen.getByRole('button', { name: 'Selected paper' }))
  await screen.findByText('Verified abstract')
  expect(lookup.mock.calls.map(([key]) => key)).toEqual(['pmid:100', 'pmid:101'])
  expect(transact).not.toHaveBeenCalled()
})

const temporaryMetadataError = {
  code: 'literature-metadata-temporarily-unavailable',
  message: 'The metadata provider is temporarily unavailable.'
}

it.each([
  ['mismatched metadata', '', false],
  ['existing abstract', 'Abstract from the citation', true]
] as const)('keeps %s out of the retry flow', async (_, abstract, unavailable) => {
  const ref = record('b')
  ref.item.identifiers = [{ scheme: 'pmid', value: '100', isPrimary: true }]
  ref.item.abstract = abstract
  related.mockImplementation(async (request) => result(request, { records: [ref] }))
  const lookup = vi.fn()
  if (unavailable) lookup.mockRejectedValue(temporaryMetadataError)
  else lookup.mockResolvedValue({ ...ref.item, identifiers: [], abstract: 'Unrelated abstract' })
  Object.assign(window.api.literature, { lookupMetadata: lookup })
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Select Paper b' }))
  await waitFor(() => expect(lookup).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
  expect(screen.getByText(abstract || 'No abstract available.')).toBeTruthy()
  expect(screen.queryByText('Unrelated abstract')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('retries a missing abstract after a temporary provider failure', async () => {
  const ref = record('b')
  ref.item.identifiers = [{ scheme: 'pmid', value: '100', isPrimary: true }]
  related.mockImplementation(async (request) => result(request, { records: [ref] }))
  const lookup = vi
    .fn()
    .mockRejectedValueOnce(temporaryMetadataError)
    .mockResolvedValueOnce({ ...ref.item, abstract: 'Correct abstract' })
  Object.assign(window.api.literature, { lookupMetadata: lookup })
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Select Paper b' }))
  await screen.findByText('The provider is temporarily unavailable. Please try again later.')
  expect(screen.queryByText('Unrelated abstract')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Paper b' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Correct abstract')
  fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Inbox' }))
  await waitFor(() => expect(transact).toHaveBeenCalledTimes(1))
  expect(transact.mock.calls[0][0].candidate).toMatchObject({
    item: { title: 'Paper b', abstract: 'Correct abstract' },
    source: { rawMetadata: { metadataLookup: 'pmid:100' } }
  })
})

it('stages the selected row and recenters directly from its actions', async () => {
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  const list = within(await screen.findByRole('region', { name: 'Paper list' }))
  fireEvent.click(await list.findByRole('button', { name: 'Paper b' }))
  fireEvent.click(list.getByRole('button', { name: 'Add to Inbox' }))
  await list.findByText('In Inbox')
  expect(transact).toHaveBeenCalledTimes(1)
  const saved = list.getByRole('button', { name: 'Add to Inbox' })
  expect(saved.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(saved)
  expect(transact).toHaveBeenCalledTimes(1)
  fireEvent.click(list.getByRole('button', { name: 'Set as center' }))
  await screen.findByText('Temporary center')
  expect(related.mock.calls.some(([request]) => request.seedPaperId === paperId('b'))).toBe(true)
})

it('stages a cross-tab selection once per paper and retries only failed papers', async () => {
  related.mockImplementation(async (request) =>
    result(request, {
      records: request.direction === 'references' ? [record('b')] : [record('b'), record('c')]
    })
  )
  transact
    .mockResolvedValueOnce({ kind: 'candidate', id: 'b', state: 'pending' })
    .mockRejectedValueOnce(new Error('transient'))
  const onSaved = vi.fn()
  render(<LiteratureCitationGraph item={item} onSaved={onSaved} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select multiple' }))
  const check = (letter: string): HTMLElement =>
    screen.getByRole('checkbox', { name: 'Select Paper ' + letter })
  fireEvent.click(check('b'))
  showCategory('citations')
  expect(check('b')).toHaveProperty('checked', true)
  fireEvent.click(check('c'))
  expect(screen.getByText('Selected: 2')).toBeTruthy()
  const add = screen.getByRole('button', { name: 'Add to Inbox' })
  fireEvent.click(add)
  await screen.findByText('Could not add this reference. Try again.')
  expect(check('b')).toHaveProperty('disabled', true)
  expect(check('b')).toHaveProperty('checked', false)
  expect(check('c')).toHaveProperty('checked', true)
  showCategory('references')
  expect(screen.getByText('Processed: 1 · Failed: 1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Selected: 0')
  expect(transact.mock.calls.map(([request]) => request.candidate.source.externalId)).toEqual([
    paperId('b'),
    paperId('c'),
    paperId('c')
  ])
  expect(onSaved).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('checkbox')).toBeNull()
})

it('keeps conflicting cross-tab papers readable and excludes both from staging', async () => {
  const first = record('b')
  const second = record('c')
  for (const entry of [first, second])
    entry.item.identifiers = [
      { scheme: 'pmid', value: '100', isPrimary: true },
      { scheme: 'doi', value: '10.1234/' + entry.paperId.split(':').pop(), isPrimary: false }
    ]
  related.mockImplementation(async (request) =>
    result(request, { records: [request.direction === 'references' ? first : second] })
  )
  render(<LiteratureCitationGraph item={item} onSaved={vi.fn()} />)
  await screen.findByRole('button', { name: 'Select Paper c' })
  fireEvent.click(screen.getByRole('button', { name: 'Select multiple' }))
  expect(screen.getByRole('checkbox', { name: 'Select Paper b' })).toHaveProperty('disabled', true)
  showCategory('citations')
  expect(screen.getByRole('checkbox', { name: 'Select Paper c' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Add to Inbox' })).toHaveProperty('disabled', true)
  expect(transact).not.toHaveBeenCalled()
})
