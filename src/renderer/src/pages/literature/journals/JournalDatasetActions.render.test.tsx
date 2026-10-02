// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { JournalDatasetActions } from './JournalDatasetActions'
import type { JournalDataset } from '../../../../../shared/journal-attributes'

afterEach(cleanup)
const dataset: JournalDataset = {
  id: 'fictional-source',
  source: 'Fictional source',
  year: 2031,
  revision: 1,
  count: 1,
  fields: [],
  importedAt: 1
}
const openAction = async (name: string): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name }))
}

it('cancels rename without saving and persists the trimmed name only on confirmation', async () => {
  const renamed = {
    ...dataset,
    name: 'My rankings',
    source: 'Revised survey',
    year: 2032,
    revision: 2
  }
  const journals = vi.fn(async () => ({ datasets: [renamed] }))
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  const onRenamed = vi.fn()
  render(
    <JournalDatasetActions
      dataset={dataset}
      disabled={false}
      onRenamed={onRenamed}
      onDelete={vi.fn()}
      onOpenItem={vi.fn()}
    />
  )
  await openAction('Edit dataset')
  for (const [name, description] of [
    [
      'Name',
      'Display name for this dataset. Changing it does not change the source or metric year.'
    ],
    ['Source', 'Groups datasets by source. References use the latest metric year for each source.'],
    ['Metric year', 'Year the values describe; it can differ from the file release year.']
  ]) {
    const help = screen.getByRole('button', { name: `About ${name}` })
    fireEvent.focus(help)
    expect((await screen.findByRole('tooltip')).textContent).toBe(description)
    fireEvent.blur(help)
  }
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe(
    'Fictional source 2031'
  )
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(journals).not.toHaveBeenCalled()
  await openAction('Edit dataset')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } })
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  My rankings  ' } })
  fireEvent.change(screen.getByLabelText('Source'), { target: { value: ' Revised survey ' } })
  fireEvent.change(screen.getByLabelText('Metric year'), { target: { value: '2032' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(onRenamed).toHaveBeenCalledWith([renamed]))
  expect(journals).toHaveBeenCalledWith({
    action: 'rename',
    datasetId: dataset.id,
    expectedRevision: 1,
    name: 'My rankings',
    source: 'Revised survey',
    year: 2032
  })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps a failed rename draft and exposes alignment and deletion only through the menu', async () => {
  const journals = vi.fn().mockRejectedValue(new Error('Journal data changed. Reload the dataset.'))
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { journals } } })
  const onDelete = vi.fn()
  render(
    <JournalDatasetActions
      dataset={dataset}
      disabled={false}
      onRenamed={vi.fn()}
      onDelete={onDelete}
      onOpenItem={vi.fn()}
    />
  )
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  await openAction('Edit dataset')
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep this draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Journal data changed. Reload the dataset.')
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Keep this draft')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  journals.mockClear()
  await openAction('Journal alignment')
  expect(await screen.findByRole('button', { name: 'Check library' })).toBeTruthy()
  expect(journals).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await openAction('Delete')
  await waitFor(() => expect(onDelete).toHaveBeenCalledOnce())
})
