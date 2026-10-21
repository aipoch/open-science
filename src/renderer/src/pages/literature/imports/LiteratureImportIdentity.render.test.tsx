// @vitest-environment jsdom
import {
  LITERATURE_ITEM_TYPES,
  type LiteratureItemType
} from '@aipoch/literature-citations/contracts'
import type { LiteratureRecordImportResult } from '@aipoch/literature-library/contracts'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LiteratureMetadataEditor } from '../detail/LiteratureMetadataEditor'
import { LiteratureRecordImportDialog } from './LiteratureRecordImportDialog'

afterEach(cleanup)
const item = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Imported paper',
  identifiers: [
    { scheme: 'doi', value: '10.1234/one', isPrimary: true },
    { scheme: 'pmid', value: '12345', isPrimary: true }
  ]
})

it('blocks conflicting reuse and supplementation, exposes matches, and permits explicit separate import', () => {
  const onImport = vi.fn()
  const props = {
    recordImport: {
      fileName: 'references.nbib',
      content: '',
      preview: {
        format: 'nbib' as const,
        items: [item],
        errors: [],
        scannedEntries: 1,
        truncated: false,
        entries: [
          {
            index: 0,
            title: item.title,
            status: 'conflict' as const,
            warnings: ['uncertain-author-name' as const],
            item,
            conflict: {
              identifiers: item.identifiers,
              matches: [
                { itemId: 'a', title: 'Library paper' },
                { inputIndex: 1, title: 'Earlier paper' }
              ]
            }
          }
        ]
      }
    },
    isImportingRecords: false,
    destination: 'Library',
    itemDescription: () => '',
    itemTypeLabels: Object.fromEntries(LITERATURE_ITEM_TYPES.map((type) => [type, type])) as Record<
      LiteratureItemType,
      string
    >,
    onClose: vi.fn(),
    onDuplicatePolicyChange: vi.fn(),
    onImport,
    onPreviewSelection: vi.fn()
  }
  const { rerender } = render(<LiteratureRecordImportDialog {...props} duplicatePolicy="reuse" />)
  const submit = (): HTMLButtonElement =>
    screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement
  expect(submit().disabled).toBe(true)
  fireEvent.click(submit())
  expect(onImport).not.toHaveBeenCalled()
  expect(screen.getByText('Library reference: Library paper')).not.toBeNull()
  expect(screen.getByText('File reference 2: Earlier paper')).not.toBeNull()
  expect(screen.getByText('Check author names. Original text is kept in Extra.')).not.toBeNull()
  rerender(<LiteratureRecordImportDialog {...props} duplicatePolicy="fill-missing" />)
  expect(submit().disabled).toBe(true)
  rerender(<LiteratureRecordImportDialog {...props} duplicatePolicy="separate" />)
  expect(submit().disabled).toBe(false)
  fireEvent.click(submit())
  expect(onImport).toHaveBeenCalledOnce()
  expect(onImport).toHaveBeenCalledWith(undefined)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select reference 1: Imported paper' }))
  expect(submit().disabled).toBe(true)
  expect(screen.getByText('0 of 1 selected')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Check all' }))
  expect(submit().disabled).toBe(false)
})

it('selects a preferred DOI without clearing the preferred PMID', () => {
  const onSave = vi.fn()
  render(
    <LiteratureMetadataEditor
      item={{
        ...item,
        identifiers: [
          ...item.identifiers,
          { scheme: 'doi', value: '10.1234/two', isPrimary: false }
        ]
      }}
      saving={false}
      onCancel={vi.fn()}
      onSave={onSave}
    />
  )
  const dois = screen.getAllByRole('radio', { name: 'Preferred for DOI' }) as HTMLInputElement[]
  const pmid = screen.getByRole('radio', { name: 'Preferred for PMID' }) as HTMLInputElement
  fireEvent.click(dois[1])
  expect(dois[0].checked).toBe(false)
  expect(dois[1].checked).toBe(true)
  expect(pmid.checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      identifiers: [
        { scheme: 'doi', value: '10.1234/one', isPrimary: false },
        { scheme: 'pmid', value: '12345', isPrimary: true },
        { scheme: 'doi', value: '10.1234/two', isPrimary: true }
      ]
    })
  )
})

it.each(['existing', 'conflict'] as const)(
  'rechecks selected references after excluding a preceding %s identity source',
  async (status) => {
    const second = { ...item, title: 'Second paper' }
    const preview: LiteratureRecordImportResult = {
      format: 'nbib',
      items: [item, second],
      errors: [],
      scannedEntries: 2,
      truncated: false,
      entries: [
        { index: 0, title: item.title, item, status: 'ready', warnings: [] },
        {
          index: 1,
          title: second.title,
          item: second,
          status,
          warnings: [],
          ...(status === 'conflict'
            ? {
                conflict: {
                  identifiers: second.identifiers,
                  matches: [{ inputIndex: 0, title: item.title }]
                }
              }
            : {})
        }
      ]
    }
    const completions: Array<(result: LiteratureRecordImportResult) => void> = []
    const onPreviewSelection = vi.fn(
      () =>
        new Promise<LiteratureRecordImportResult>((resolve) => {
          completions.push(resolve)
        })
    )
    const onImport = vi.fn()
    render(
      <LiteratureRecordImportDialog
        recordImport={{ fileName: 'batch.nbib', content: 'source', preview }}
        isImportingRecords={false}
        destination="Library"
        itemDescription={() => ''}
        itemTypeLabels={
          Object.fromEntries(LITERATURE_ITEM_TYPES.map((type) => [type, type])) as Record<
            LiteratureItemType,
            string
          >
        }
        onClose={vi.fn()}
        duplicatePolicy="reuse"
        onDuplicatePolicyChange={vi.fn()}
        onImport={onImport}
        onPreviewSelection={onPreviewSelection}
      />
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select reference 1: Imported paper' }))
    const submit = screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.getByText('Loading…')).not.toBeNull()
    expect(screen.queryByText('New references')).toBeNull()
    expect(onPreviewSelection).toHaveBeenCalledWith('source', [1])
    fireEvent.click(screen.getByRole('button', { name: 'Check all' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select reference 1: Imported paper' }))
    expect(onPreviewSelection).toHaveBeenCalledTimes(2)
    await act(async () => completions[0]({ ...preview, entries: [] }))
    expect(submit.disabled).toBe(true)
    await act(async () =>
      completions[1]({
        ...preview,
        entries: [{ ...preview.entries[1], status: 'ready', conflict: undefined }]
      })
    )
    await waitFor(() => expect(submit.disabled).toBe(false))
    expect(screen.getByText('New references').parentElement?.textContent).toBe('1New references')
    expect(screen.getByText('Existing').parentElement?.textContent).toBe('0Existing')
    expect(screen.queryByText('File reference 1: Imported paper')).toBeNull()
    fireEvent.click(submit)
    expect(onImport).toHaveBeenCalledWith([1])
  }
)
