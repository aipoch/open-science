// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { JournalAttributes } from './JournalAttributes'
import {
  useJournalDatasets,
  useJournalSourceYears,
  setJournalSourceYear
} from './journals/journal-attribute-store'
import { literatureItemInputSchema } from '../../../../shared/literature'
import type { LiteratureChangedEvent } from '../../../../shared/literature'
import type { JournalRequest } from '../../../../shared/journal-attributes'

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('open-science:journal-source-years')
})
const item = literatureItemInputSchema.parse({
  title: 'Fictional paper',
  itemType: 'journalArticle',
  containerTitle: 'Imaginary Review'
})
it('does not resolve journal metadata for non-journal references', () => {
  const journals = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { journals } }
  })
  const book = literatureItemInputSchema.parse({
    title: 'Fictional book',
    itemType: 'book',
    containerTitle: 'Imaginary Review'
  })
  const { container } = render(<JournalAttributes item={book} detail />)
  expect(container.firstChild).toBeNull()
  expect(journals).not.toHaveBeenCalled()
})
it('batches visible references and refreshes all surfaces after dataset changes', async () => {
  let changed: (event: LiteratureChangedEvent) => void = () => {}
  let value = 'Gold'
  const journals = vi.fn(async (request: JournalRequest) =>
    request.action === 'resolve'
      ? {
          matches: request.identities.map(() => ({
            status: 'matched' as const,
            identity: {
              name: 'Imaginary Review',
              aliases: [],
              issns: [],
              externalIds: [{ namespace: 'jcr', value: 'fictional-417' }]
            },
            attributes: [
              {
                key: 'test:band',
                label: 'Editorial band',
                kind: 'singleSelect' as const,
                value,
                source: 'Fictional source',
                year: 2031,
                colors: { Gold: 'green' as const }
              }
            ]
          }))
        }
      : { datasets: [] }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals,
        onChanged: (listener: (event: LiteratureChangedEvent) => void) => {
          changed = listener
          return () => {}
        }
      }
    }
  })
  render(
    <>
      <JournalAttributes item={item} detail />
      <JournalAttributes item={{ ...item, containerTitle: 'Imaginary Annals' }} detail />
    </>
  )
  await waitFor(() => expect(screen.getAllByText('Gold')).toHaveLength(2))
  expect(screen.getAllByText('jcr:fictional-417')).toHaveLength(2)
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(1)
  expect(screen.queryByText('Current local journal data')).toBeNull()
  expect(screen.queryByText('Fictional source')).toBeNull()
  const sourceButtons = screen.getAllByRole('button', {
    name: 'Editorial band · Fictional source 2031'
  })
  expect(sourceButtons[0].querySelector('span')?.className).toContain('truncate')
  expect(sourceButtons[0].querySelector('svg')?.getAttribute('class')).toContain('shrink-0')
  fireEvent.focus(sourceButtons[0])
  expect(await screen.findByRole('tooltip')).toHaveProperty(
    'textContent',
    expect.stringContaining('Fictional source')
  )
  expect(screen.getByRole('tooltip').textContent).toContain('2031')
  fireEvent.blur(sourceButtons[0])
  await act(async () => changed({ revision: 1, itemIds: ['fictional-reference'] }))
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(1)
  value = 'Silver'
  await act(async () => changed({ revision: 2 }))
  await waitFor(() => expect(screen.getAllByText('Silver')).toHaveLength(2))
  expect(screen.queryByText('Gold')).toBeNull()
})
it('does not display results returned for a previous identity', async () => {
  const resolves: (() => void)[] = []
  const journals = vi.fn((request: JournalRequest) =>
    request.action === 'resolve'
      ? new Promise((resolve) =>
          resolves.push(() =>
            resolve({
              matches: [
                {
                  status: 'matched',
                  attributes: [
                    {
                      key: 'old',
                      label: 'Old value',
                      kind: 'text',
                      value: 'obsolete',
                      source: 'Fictional',
                      year: 2031,
                      colors: {}
                    }
                  ]
                }
              ]
            })
          )
        )
      : Promise.resolve({ datasets: [] })
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { journals, onChanged: () => () => {} } }
  })
  const view = render(<JournalAttributes item={item} detail />)
  await waitFor(() => expect(resolves).toHaveLength(1))
  view.rerender(
    <JournalAttributes item={{ ...item, containerTitle: 'Different journal' }} detail />
  )
  await act(async () => resolves[0]())
  expect(screen.queryByText('obsolete')).toBeNull()
  await waitFor(() => expect(resolves).toHaveLength(2))
  view.unmount()
  await act(async () => resolves[1]())
})

it('serializes batches and does not reuse a late response for an unmounted identity', async () => {
  const responses: ((result: { matches: [] }) => void)[] = []
  const journals = vi.fn((request: JournalRequest) =>
    request.action === 'resolve'
      ? new Promise((resolve) => responses.push(resolve))
      : Promise.resolve({ datasets: [] })
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { journals, onChanged: () => () => {} } }
  })
  const view = render(<JournalAttributes item={item} detail />)
  await waitFor(() => expect(responses).toHaveLength(1))
  view.rerender(
    <JournalAttributes item={{ ...item, containerTitle: 'Imaginary Second Review' }} detail />
  )
  await act(async () => {})
  expect(responses).toHaveLength(1)
  await act(async () => responses[0]({ matches: [] }))
  await waitFor(() => expect(responses).toHaveLength(2))
  view.rerender(<JournalAttributes item={item} detail />)
  await act(async () => responses[1]({ matches: [] }))
  await waitFor(() => expect(responses).toHaveLength(3))
  await act(async () => responses[2]({ matches: [] }))
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(3)
})

it('isolates identical identities by local reference ID and refreshes a cleared confirmation', async () => {
  let changed!: (event: LiteratureChangedEvent) => void
  let confirmed = true
  const journals = vi.fn(async (request: JournalRequest) =>
    request.action === 'resolve'
      ? {
          matches: request.identities.map((identity) => ({
            status: 'matched',
            attributes: [
              {
                key: 'synthetic:signal',
                label: 'Signal',
                kind: 'text',
                value: identity.itemId === 'first' && confirmed ? 'Confirmed' : 'Automatic',
                source: 'Synthetic',
                year: 2031,
                colors: {}
              }
            ]
          }))
        }
      : { datasets: [] }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals,
        onChanged: (callback: typeof changed) => {
          changed = callback
          return () => {}
        }
      }
    }
  })
  render(
    <>
      <JournalAttributes item={item} itemId="first" detail />
      <JournalAttributes item={item} itemId="second" detail />
      <JournalAttributes item={item} detail />
    </>
  )
  await screen.findByText('Confirmed')
  expect(screen.getAllByText('Automatic')).toHaveLength(2)
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(1)
  confirmed = false
  await act(async () => changed({ revision: 2, itemIds: ['first'] }))
  await waitFor(() => expect(screen.getAllByText('Automatic')).toHaveLength(3))
  expect(journals.mock.calls.filter(([request]) => request.action === 'list')).toHaveLength(1)
  expect(journals.mock.lastCall?.[0]).toEqual({
    action: 'resolve',
    identities: [expect.objectContaining({ itemId: 'first' })]
  })
})

it('distinguishes a failed load from empty attributes and retries only when requested', async () => {
  let fail = true
  const journals = vi.fn(async (request: JournalRequest) => {
    if (request.action !== 'resolve') return { datasets: [] }
    if (fail) throw new Error('Synthetic unavailable connection')
    return { matches: [{ status: 'missing', attributes: [] }] }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalAttributes item={item} detail />)
  const retry = await screen.findByRole('button', { name: 'Retry journal attributes' })
  await act(async () => {})
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(1)
  fail = false
  await act(async () => retry.click())
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Retry journal attributes' })).toBeNull()
  )
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(2)
})

it('renders only the value in a dedicated attribute column while keeping its details available', async () => {
  const journals = vi.fn(async () => ({
    matches: [
      {
        status: 'matched',
        attributes: [
          {
            key: 'unique:rating',
            label: 'Example rating',
            kind: 'number',
            value: '4.8',
            source: 'Example survey',
            year: 2033,
            colors: {}
          }
        ]
      }
    ]
  }))
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(
    <JournalAttributes
      item={{ ...item, containerTitle: 'Unique fixture journal' }}
      fieldKey="unique:rating"
    />
  )
  const button = await screen.findByRole('button', { name: 'Journal attributes' })
  expect(button.textContent).toBe('4.8')
  expect(screen.queryByText('Example rating')).toBeNull()
  fireEvent.click(button)
  expect(await screen.findByText('Example rating')).toBeTruthy()
})

it('retains page attributes, invalidates inactive entries and keeps unchanged dataset snapshots stable', async () => {
  let changed!: (event: LiteratureChangedEvent) => void
  const dataset = {
    id: 'cached',
    source: 'Cache fixture',
    year: 2031,
    revision: 1,
    count: 1,
    importedAt: 1,
    fields: []
  }
  const journals = vi.fn(async (request: JournalRequest) =>
    request.action === 'list'
      ? { datasets: [structuredClone(dataset)] }
      : {
          matches:
            request.action === 'resolve' ? request.identities.map(() => ({ attributes: [] })) : []
        }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals,
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        }
      }
    }
  })
  const renders = vi.fn()
  function Catalog(): null {
    renders(useJournalDatasets())
    return null
  }
  const page = (id: string): React.JSX.Element => (
    <>
      <Catalog />
      <JournalAttributes item={item} itemId={id} detail />
    </>
  )
  const view = render(page('first'))
  await waitFor(() => expect(renders.mock.lastCall?.[0]).toHaveLength(1))
  await act(async () => {})
  const snapshot = renders.mock.lastCall?.[0]
  view.rerender(page('second'))
  await act(async () => {})
  view.rerender(page('first'))
  await act(async () => {})
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(2)
  await act(async () => changed({ revision: 1, itemIds: ['second'] }))
  view.rerender(page('second'))
  await act(async () => {})
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(3)
  renders.mockClear()
  await act(async () => changed({ revision: 2 }))
  expect(renders).not.toHaveBeenCalled()
  view.rerender(page('first'))
  await act(async () => {})
  expect(renders.mock.lastCall?.[0]).toBe(snapshot)
  expect(journals.mock.calls.filter(([request]) => request.action === 'resolve')).toHaveLength(5)
})

it('discards an in-flight attribute response when the same reference changes again', async () => {
  let changed!: (event: LiteratureChangedEvent) => void
  const replies: ((result: { matches: { attributes: [] }[] }) => void)[] = []
  const journals = vi.fn((request: JournalRequest) =>
    request.action === 'resolve'
      ? new Promise((resolve) => replies.push(resolve))
      : Promise.resolve({ datasets: [] })
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals,
        onChanged: (listener: typeof changed) => {
          changed = listener
          return () => {}
        }
      }
    }
  })
  render(<JournalAttributes item={item} itemId="first" detail />)
  await waitFor(() => expect(replies).toHaveLength(1))
  await act(async () => changed({ revision: 1, itemIds: ['first'] }))
  await act(async () => replies[0]({ matches: [{ attributes: [] }] }))
  await waitFor(() => expect(replies).toHaveLength(2))
  await act(async () => replies[1]({ matches: [{ attributes: [] }] }))
  expect(journals.mock.calls.filter(([request]) => request.action === 'list')).toHaveLength(1)
})

it('clears old values immediately and ignores in-flight values after changing source year', async () => {
  const pending: Array<{
    request: Extract<JournalRequest, { action: 'resolve' }>
    finish: (value: unknown) => void
  }> = []
  const journals = vi.fn((request: JournalRequest) =>
    request.action === 'resolve'
      ? new Promise((finish) => pending.push({ request, finish }))
      : Promise.resolve({ datasets: [] })
  )
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  render(<JournalAttributes item={item} detail />)
  await waitFor(() => expect(pending).toHaveLength(1))
  act(() => setJournalSourceYear('Fictional source', 2031))
  await act(async () =>
    pending[0].finish({
      matches: [
        {
          attributes: [
            {
              key: 'old',
              label: 'Old metric',
              kind: 'number',
              value: '999',
              source: 'Fictional source',
              year: 2032
            }
          ]
        }
      ]
    })
  )
  await waitFor(() => expect(pending).toHaveLength(2))
  expect(screen.queryByText('999')).toBeNull()
  expect(pending[1].request.sourceYears).toEqual({ 'Fictional source': 2031 })
  await act(async () =>
    pending[1].finish({
      matches: [
        {
          attributes: [
            {
              key: 'new',
              label: 'New metric',
              kind: 'number',
              value: '12',
              source: 'Fictional source',
              year: 2031
            }
          ]
        }
      ]
    })
  )
  expect(await screen.findByText('12')).toBeTruthy()
  act(() => setJournalSourceYear('Fictional source', null))
  expect(screen.queryByText('12')).toBeNull()
  await waitFor(() => expect(pending).toHaveLength(3))
  expect(pending[2].request.sourceYears).toEqual({ 'Fictional source': null })
  await act(async () => pending[2].finish({ matches: [{ attributes: [] }] }))
})

it('synchronizes source choices from other windows without restoring removed overrides', async () => {
  function Choices(): React.JSX.Element {
    return <output data-testid="source-years">{JSON.stringify(useJournalSourceYears())}</output>
  }
  render(<Choices />)
  act(() => setJournalSourceYear('First source', 2031))
  expect(screen.getByTestId('source-years').textContent).toContain('2031')
  // Another window restores the default before its storage event arrives here.
  localStorage.setItem('open-science:journal-source-years', '{}')
  act(() => setJournalSourceYear('Second source', null))
  expect(JSON.parse(localStorage.getItem('open-science:journal-source-years')!)).toEqual({
    'Second source': null
  })
  localStorage.setItem('open-science:journal-source-years', '{"First source":2032}')
  const event = new Event('storage')
  Object.defineProperties(event, {
    key: { value: 'open-science:journal-source-years' },
    storageArea: { value: localStorage }
  })
  act(() => window.dispatchEvent(event))
  expect(screen.getByTestId('source-years').textContent).toBe('{"First source":2032}')
})

it('adds source labels only to expanded details and keeps compact cards unchanged', async () => {
  const attributes = Array.from({ length: 5 }, (_, index) => ({
    key: `display:${index}`,
    label: `Metric ${index + 1}`,
    kind: 'number' as const,
    value: String(index + 1),
    source: 'WOS 2025',
    year: 2025,
    colors: {}
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals: vi.fn(async (request: JournalRequest) =>
          request.action === 'resolve'
            ? { matches: [{ status: 'matched', attributes }] }
            : { datasets: [] }
        ),
        onChanged: () => () => {}
      }
    }
  })
  const view = render(<JournalAttributes item={item} />)
  await screen.findByText('+2')
  expect(screen.getByText('Metric 1')).toBeTruthy()
  expect(screen.getByText('Metric 3')).toBeTruthy()
  expect(screen.queryByText('Metric 4')).toBeNull()
  expect(view.container.textContent).not.toContain('WOS')
  const trigger = screen.getByRole('button', { name: 'Journal attributes' })
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText('Metric 5')).toBeTruthy()
  const info = screen.getByRole('button', { name: 'Current local journal data' })
  const matches = vi.spyOn(info, 'matches').mockReturnValue(false)
  fireEvent.blur(info)
  fireEvent.focus(info)
  expect(screen.queryByRole('tooltip')).toBeNull()
  matches.mockRestore()
  fireEvent.keyDown(info, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(<JournalAttributes item={item} detail />)
  expect(screen.queryByText('+2')).toBeNull()
  for (let index = 1; index <= 5; index++) {
    expect(screen.getByRole('button', { name: `Metric ${index} · WOS 2025` })).toBeTruthy()
  }
  expect(view.container.textContent).not.toContain('WOS 2025 2025')
})

it('keeps only the most recently opened journal attribute popover', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        journals: vi.fn(async (request: JournalRequest) =>
          request.action === 'resolve'
            ? {
                matches: request.identities.map(() => ({
                  status: 'matched',
                  attributes: ['JIF', 'JCR'].map((label) => ({
                    key: label,
                    label,
                    kind: 'text',
                    value: label === 'JIF' ? '4.8' : 'Q1',
                    source: 'WOS',
                    year: 2025,
                    colors: {}
                  }))
                }))
              }
            : { datasets: [] }
        ),
        onChanged: () => () => {}
      }
    }
  })
  render(
    <>
      <JournalAttributes item={item} fieldKey="JIF" />
      <JournalAttributes item={item} fieldKey="JCR" />
      <JournalAttributes item={{ ...item, containerTitle: 'Another journal' }} fieldKey="JIF" />
    </>
  )
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Journal attributes' })).toHaveLength(3)
  )
  const triggers = screen.getAllByRole('button', { name: 'Journal attributes' })
  for (const trigger of triggers) {
    fireEvent.click(trigger)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(triggers.filter((button) => button.getAttribute('aria-expanded') === 'true')).toEqual([
      trigger
    ])
  }
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(triggers[2]))
})
