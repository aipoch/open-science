// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  change
}: {
  change: (filters: JournalAttributeFilter[]) => void
}): React.JSX.Element {
  const [filters, setFilters] = useState<JournalAttributeFilter[]>([])
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
      datasets={[dataset]}
      journalFilters={filters}
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
