// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  LITERATURE_ITEM_TYPES,
  literatureItemInputSchema,
  type LiteratureItemType
} from '../../../../shared/literature'
import { LiteratureRecordImportDialog } from './LiteratureRecordImportDialog'
import { LiteratureMetadataEditor } from './LiteratureMetadataEditor'

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
    onImport
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
