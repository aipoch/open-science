// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiteratureFilters } from './LiteratureFilters'
import { useLiteratureYearFilter } from './useLiteratureYearFilter'
import type { JournalAttributeFilter, JournalDataset } from '../../../../shared/journal-attributes'
import type { LiteratureItemType } from '../../../../shared/literature'
vi.mock('../settings/ResourceTagControls', () => ({ TagFilter: () => <span /> }))
afterEach(cleanup)
const dataset: JournalDataset = {
  id: 'demo',
  source: 'Demo',
  year: 2030,
  revision: 1,
  count: 2,
  importedAt: 1,
  fields: [
    { id: 'score', label: 'Score', kind: 'number', visible: true, colors: {} },
    { id: 'group', label: 'Group', kind: 'singleSelect', visible: false, colors: {} }
  ]
}
function Harness({
  change,
  initialFilters = [],
  externalFilters,
  availableDatasets = [dataset]
}: {
  change: (filters: JournalAttributeFilter[]) => void
  initialFilters?: JournalAttributeFilter[]
  externalFilters?: JournalAttributeFilter[]
  availableDatasets?: JournalDataset[]
}): React.JSX.Element {
  const [filters, setFilters] = useState<JournalAttributeFilter[]>(initialFilters)
  const [itemType, setItemType] = useState<LiteratureItemType | 'all'>('all')
  const [hasPdf, setHasPdf] = useState<'all' | 'with' | 'without'>('all')
  const [tagId, setTagId] = useState('all')
  const yearFilter = useLiteratureYearFilter(() => {})
  return (
    <LiteratureFilters
      headingId="filters-heading"
      tagId={tagId}
      onTagChange={setTagId}
      itemType={itemType}
      onItemTypeChange={setItemType}
      itemTypeLabels={{ journalArticle: 'Journal article' } as Record<LiteratureItemType, string>}
      hasPdf={hasPdf}
      onHasPdfChange={setHasPdf}
      yearFilter={yearFilter}
      datasets={availableDatasets}
      journalFilters={externalFilters ?? filters}
      onJournalFiltersChange={(next) => {
        change(next)
        setFilters(next)
      }}
      onFilterChange={() => {}}
      onClear={() => {
        setFilters([])
        change([])
        yearFilter.clear()
        setItemType('all')
        setHasPdf('all')
        setTagId('all')
      }}
    />
  )
}
it('searches dynamic fields, restricts operators by type and commits the latest edit on close', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const change = vi.fn()
  const view = render(<Harness change={change} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Search fields' }), {
    target: { value: 'Score' }
  })
  expect(screen.queryByRole('button', { name: 'Group · Demo 2030' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Score · Demo 2030' }))
  fireEvent.click(screen.getByRole('combobox', { name: 'Journal attribute operator' }))
  expect(screen.queryByRole('option', { name: 'Contains' })).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'At least' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Journal attribute value' }), {
    target: { value: '4.5' }
  })
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([
      { datasetId: 'demo', fieldId: 'score', operator: 'gte', value: '4.5' }
    ])
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Journal attribute value' }), {
    target: { value: '8' }
  })
  view.unmount()
  expect(change).toHaveBeenLastCalledWith([
    { datasetId: 'demo', fieldId: 'score', operator: 'gte', value: '8' }
  ])
})

const lowerBound: JournalAttributeFilter = {
  datasetId: 'demo',
  fieldId: 'score',
  operator: 'gte',
  value: '4.5'
}
const upperBound: JournalAttributeFilter = {
  datasetId: 'demo',
  fieldId: 'score',
  operator: 'lte',
  value: '10'
}
it.each([false, true])(
  'does not restore an externally removed condition (dataset removed: %s)',
  async (removed) => {
    const change = vi.fn()
    const view = render(<Harness change={change} initialFilters={[lowerBound]} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Journal attribute value' }), {
      target: { value: 'invalid' }
    })
    view.rerender(
      <Harness
        change={change}
        initialFilters={[lowerBound]}
        externalFilters={[]}
        availableDatasets={removed ? [] : [dataset]}
      />
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
    view.unmount()
    expect(change).not.toHaveBeenCalled()
  }
)
it.each([false, true])(
  'removes another condition while retaining an invalid row (close: %s)',
  async (close) => {
    const change = vi.fn()
    const view = render(<Harness change={change} initialFilters={[lowerBound, upperBound]} />)
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Journal attribute value' })[0], {
      target: { value: 'invalid' }
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove condition' }).at(-1)!)
    if (close) view.unmount()
    await waitFor(() => expect(change).toHaveBeenLastCalledWith([lowerBound]))
  }
)

it('retains independent applied values for duplicate fields while another row changes', async () => {
  const group: JournalAttributeFilter = {
    datasetId: 'demo',
    fieldId: 'group',
    operator: 'equals',
    value: 'Gold'
  }
  const change = vi.fn()
  render(<Harness change={change} initialFilters={[lowerBound, upperBound, group]} />)
  const inputs = screen.getAllByRole('textbox', { name: 'Journal attribute value' })
  fireEvent.change(inputs[0], { target: { value: 'invalid' } })
  fireEvent.change(inputs[1], { target: { value: 'invalid' } })
  fireEvent.change(inputs[2], { target: { value: 'Silver' } })
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([lowerBound, upperBound, { ...group, value: 'Silver' }])
  )
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove condition' })[4])
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([upperBound, { ...group, value: 'Silver' }])
  )
  const remaining = screen.getAllByRole('textbox', { name: 'Journal attribute value' })
  fireEvent.change(remaining[0], { target: { value: '12' } })
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([
      { ...upperBound, value: '12' },
      { ...group, value: 'Silver' }
    ])
  )
  fireEvent.change(remaining[0], { target: { value: 'invalid again' } })
  fireEvent.change(remaining[1], { target: { value: 'Bronze' } })
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([
      { ...upperBound, value: '12' },
      { ...group, value: 'Bronze' }
    ])
  )
})

it('does not give a new invalid row the applied value of another row using the same field', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const change = vi.fn()
  const view = render(<Harness change={change} initialFilters={[lowerBound]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.click(screen.getByRole('button', { name: 'Score · Demo 2030' }))
  const inputs = screen.getAllByRole('textbox', { name: 'Journal attribute value' })
  fireEvent.change(inputs[1], { target: { value: 'invalid' } })
  expect(screen.getByRole('alert').textContent).toBe(
    'Enter a valid number. This condition has not been applied.'
  )
  fireEvent.change(inputs[0], { target: { value: '6' } })
  view.unmount()
  expect(change).toHaveBeenLastCalledWith([{ ...lowerBound, value: '6' }])
})

it('retains the applied value instead of an uncommitted valid draft', async () => {
  const group: JournalAttributeFilter = {
    datasetId: 'demo',
    fieldId: 'group',
    operator: 'equals',
    value: 'Gold'
  }
  const change = vi.fn()
  const view = render(<Harness change={change} initialFilters={[lowerBound, group]} />)
  const input = screen.getAllByRole('textbox', { name: 'Journal attribute value' })[0]
  fireEvent.change(input, { target: { value: '6' } })
  fireEvent.change(input, { target: { value: 'invalid' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove condition' }).at(-1)!)
  view.unmount()
  expect(change).toHaveBeenLastCalledWith([lowerBound])
})

it('does not restore cleared row history when a new condition uses the same field', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const change = vi.fn()
  const view = render(<Harness change={change} initialFilters={[lowerBound, upperBound]} />)
  fireEvent.change(screen.getAllByRole('textbox', { name: 'Journal attribute value' })[0], {
    target: { value: 'invalid' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(change).toHaveBeenLastCalledWith([])
  change.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.click(screen.getByRole('button', { name: 'Score · Demo 2030' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Journal attribute value' }), {
    target: { value: 'invalid' }
  })
  expect(screen.getByRole('alert').textContent).toBe(
    'Enter a valid number. This condition has not been applied.'
  )
  view.unmount()
  expect(change).not.toHaveBeenCalled()
})
it('offers hidden dynamic columns, missing values and clearing all conditions', async () => {
  const change = vi.fn()
  render(<Harness change={change} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.click(screen.getByRole('button', { name: 'Group · Demo 2030' }))
  fireEvent.click(screen.getByRole('combobox', { name: 'Journal attribute operator' }))
  expect(screen.queryByRole('option', { name: 'Greater than' })).toBeNull()
  fireEvent.click(screen.getByRole('option', { name: 'Is missing' }))
  expect(screen.queryByRole('textbox', { name: 'Journal attribute value' })).toBeNull()
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([
      { datasetId: 'demo', fieldId: 'group', operator: 'missing' }
    ])
  )
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(change).toHaveBeenLastCalledWith([])
  expect(screen.queryByRole('combobox', { name: 'Journal attribute operator' })).toBeNull()
})
it('allows removed fixed fields to be added again and explains the local scope', async () => {
  render(<Harness change={vi.fn()} />)
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove condition' })[2])
  expect(screen.queryByRole('textbox', { name: 'From year' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  expect(screen.getByText('Fixed fields')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Year' }))
  expect(screen.getByRole('textbox', { name: 'From year' })).toBeTruthy()
  fireEvent.focus(screen.getByRole('button', { name: 'About Filters' }))
  expect((await screen.findByRole('tooltip')).textContent).toContain(
    'Filters only change this view.'
  )
})

it.each([
  ['At least', 'gte', '50%'],
  ['Equals', 'equals', 'not a number'],
  ['Less than', 'lt', 'Infinity']
] as const)(
  'retains the applied %s filter when an invalid draft is entered or closed',
  async (label, operator, value) => {
    Element.prototype.scrollIntoView = vi.fn()
    const change = vi.fn()
    const view = render(<Harness change={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
    fireEvent.click(screen.getByRole('button', { name: 'Score · Demo 2030' }))
    fireEvent.click(screen.getByRole('combobox', { name: 'Journal attribute operator' }))
    fireEvent.click(screen.getByRole('option', { name: label }))
    const input = screen.getByRole('textbox', { name: 'Journal attribute value' })
    fireEvent.change(input, { target: { value: '4.5' } })
    await waitFor(() =>
      expect(change).toHaveBeenLastCalledWith([
        { datasetId: 'demo', fieldId: 'score', operator, value: '4.5' }
      ])
    )
    change.mockClear()
    fireEvent.change(input, { target: { value } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const error = screen.getByRole('alert')
    expect(error.textContent).toBe(
      'Enter a valid number. This condition keeps its last applied setting.'
    )
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450))
    })
    expect(change).not.toHaveBeenCalled()
    view.unmount()
    expect(change).not.toHaveBeenCalled()
  }
)

it('applies a corrected numeric draft and allows clearing an invalid condition', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const change = vi.fn()
  render(<Harness change={change} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.click(screen.getByRole('button', { name: 'Score · Demo 2030' }))
  const input = screen.getByRole('textbox', { name: 'Journal attribute value' })
  fireEvent.change(input, { target: { value: '50%' } })
  expect(screen.getByRole('alert')).toBeTruthy()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
  expect(change).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '5e1' } })
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([
      { datasetId: 'demo', fieldId: 'score', operator: 'equals', value: '5e1' }
    ])
  )
  expect(screen.queryByRole('alert')).toBeNull()
  expect(input.getAttribute('aria-invalid')).toBe('false')
  fireEvent.change(input, { target: { value: '50%' } })
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(change).toHaveBeenLastCalledWith([])
  expect(screen.queryByRole('alert')).toBeNull()
})

it('allows missing numeric values and text equality without numeric validation', async () => {
  Element.prototype.scrollIntoView = vi.fn()
  const change = vi.fn()
  render(<Harness change={change} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.click(screen.getByRole('button', { name: 'Score · Demo 2030' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Journal attribute value' }), {
    target: { value: 'invalid' }
  })
  fireEvent.click(screen.getByRole('combobox', { name: 'Journal attribute operator' }))
  fireEvent.click(screen.getByRole('option', { name: 'Is missing' }))
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([
      { datasetId: 'demo', fieldId: 'score', operator: 'missing' }
    ])
  )
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.click(screen.getByRole('button', { name: 'Group · Demo 2030' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Journal attribute value' }), {
    target: { value: '50%' }
  })
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith([
      { datasetId: 'demo', fieldId: 'score', operator: 'missing' },
      { datasetId: 'demo', fieldId: 'group', operator: 'equals', value: '50%' }
    ])
  )
  expect(screen.queryByRole('alert')).toBeNull()
})
