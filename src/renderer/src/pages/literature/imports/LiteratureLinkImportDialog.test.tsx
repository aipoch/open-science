// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { LiteratureLinkImportDialog } from './LiteratureLinkImportDialog'

const { lookupMetadata } = vi.hoisted(() => ({ lookupMetadata: vi.fn() }))
vi.mock('../renderer-host', () => ({
  useLiteratureHost: () => ({ api: { literature: { lookupMetadata } } })
}))
afterEach(cleanup)
beforeEach(() => {
  lookupMetadata.mockReset()
})
const item = literatureItemInputSchema.parse({
  itemType: 'preprint',
  title: 'A discovered paper',
  identifiers: [{ scheme: 'arxiv', value: '2401.12345', isPrimary: true }]
})
const enter = (value: string): void => {
  fireEvent.change(screen.getByLabelText('DOI, arXiv, PMID, PMCID or links'), { target: { value } })
}

it('focuses the input and only describes arXiv version handling for arXiv input', async () => {
  render(
    <LiteratureLinkImportDialog onBatchResolved={vi.fn()} onClose={vi.fn()} onResolved={vi.fn()} />
  )
  const input = screen.getByLabelText('DOI, arXiv, PMID, PMCID or links')
  await waitFor(() => expect(document.activeElement).toBe(input))
  const hint = 'Versioned arXiv links use the latest metadata.'
  expect(screen.queryByText(hint)).toBeNull()
  enter('https://arxiv.org/abs/2401.12345v2')
  const notice = screen.getByText(hint)
  expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(notice.id)
  enter('10.1234/paper')
  expect(screen.queryByText(hint)).toBeNull()
  expect(input.getAttribute('aria-describedby')).not.toContain('-version')
})

it('rejects unsupported URLs locally and permits correction', async () => {
  const onResolved = vi.fn()
  render(
    <LiteratureLinkImportDialog
      onBatchResolved={vi.fn()}
      onClose={vi.fn()}
      onResolved={onResolved}
    />
  )
  enter('https://example.com/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  expect(await screen.findByRole('alert')).not.toBeNull()
  expect(lookupMetadata).not.toHaveBeenCalled()
  lookupMetadata.mockResolvedValue(item)
  enter('https://arxiv.org/pdf/2401.12345v2.pdf')
  fireEvent.keyDown(screen.getByLabelText('DOI, arXiv, PMID, PMCID or links'), {
    key: 'Enter',
    ctrlKey: true
  })
  await waitFor(() => expect(onResolved).toHaveBeenCalledWith(item, 'arXiv'))
  expect(lookupMetadata).toHaveBeenCalledExactlyOnceWith('arxiv:2401.12345')
})

it('keeps input after a lookup failure and allows retry', async () => {
  lookupMetadata.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(item)
  const onResolved = vi.fn()
  render(
    <LiteratureLinkImportDialog
      onBatchResolved={vi.fn()}
      onClose={vi.fn()}
      onResolved={onResolved}
    />
  )
  enter('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  expect((await screen.findByRole('alert')).textContent).toContain('could not be retrieved')
  expect(
    (screen.getByLabelText('DOI, arXiv, PMID, PMCID or links') as HTMLInputElement).value
  ).toBe('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  await waitFor(() => expect(onResolved).toHaveBeenCalledWith(item, 'DOI'))
})

it('deduplicates submissions and ignores late results after cancellation', async () => {
  let finish!: (value: typeof item) => void
  lookupMetadata.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const onClose = vi.fn()
  const onResolved = vi.fn()
  render(
    <LiteratureLinkImportDialog
      onBatchResolved={vi.fn()}
      onClose={onClose}
      onResolved={onResolved}
    />
  )
  enter('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  fireEvent.keyDown(screen.getByLabelText('DOI, arXiv, PMID, PMCID or links'), {
    key: 'Enter',
    ctrlKey: true
  })
  expect(lookupMetadata).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Searching…' }).getAttribute('aria-busy')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  await act(async () => finish(item))
  expect(onResolved).not.toHaveBeenCalled()
})

it('ignores a lookup result after unmount', async () => {
  let finish!: (value: typeof item) => void
  lookupMetadata.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const onResolved = vi.fn()
  const { unmount } = render(
    <LiteratureLinkImportDialog
      onBatchResolved={vi.fn()}
      onClose={vi.fn()}
      onResolved={onResolved}
    />
  )
  enter('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  unmount()
  await act(async () => finish(item))
  expect(onResolved).not.toHaveBeenCalled()
})

it('does not dispatch another lookup after close even if the parent has not unmounted it', () => {
  lookupMetadata.mockResolvedValue(item)
  const onClose = vi.fn()
  render(
    <LiteratureLinkImportDialog onBatchResolved={vi.fn()} onClose={onClose} onResolved={vi.fn()} />
  )
  enter('10.1234/paper')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  expect(lookupMetadata).not.toHaveBeenCalled()
})

it.each([
  ['https://pubmed.ncbi.nlm.nih.gov/35486828/', 'pmid:35486828', 'PMID'],
  ['https://pmc.ncbi.nlm.nih.gov/articles/PMC12345/', 'pmcid:PMC12345', 'PMCID']
])('resolves %s through the existing review flow', async (input, reference, source) => {
  lookupMetadata.mockResolvedValue(item)
  const onResolved = vi.fn()
  render(
    <LiteratureLinkImportDialog
      onBatchResolved={vi.fn()}
      onClose={vi.fn()}
      onResolved={onResolved}
    />
  )
  enter(input)
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  await waitFor(() => expect(onResolved).toHaveBeenCalledWith(item, source))
  expect(lookupMetadata).toHaveBeenCalledWith(reference)
})

it('keeps partial failures, deduplicates identifiers, and forwards successful records for selection', async () => {
  lookupMetadata.mockResolvedValueOnce(item).mockRejectedValueOnce(new Error('Offline'))
  const onBatchResolved = vi.fn()
  const onResolved = vi.fn()
  render(
    <LiteratureLinkImportDialog
      onBatchResolved={onBatchResolved}
      onClose={vi.fn()}
      onResolved={onResolved}
    />
  )
  enter('arxiv:2401.12345\nhttps://arxiv.org/abs/2401.12345v2\ninvalid\nPMID:35486828')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  const review = await screen.findByRole('button', { name: 'Review references' })
  expect(lookupMetadata).toHaveBeenCalledTimes(2)
  const table = screen.getByRole('table', { name: 'Lookup results' })
  const rows = within(table).getAllByRole('row').slice(1)
  expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
    'arxiv:2401.12345',
    'invalid',
    'PMID:35486828'
  ])
  expect(rows.map((row) => within(row).getByRole('cell').textContent)).toEqual([
    item.title,
    'Lookup failed',
    'Lookup failed'
  ])
  expect(screen.getAllByText(/Lookup failed/u)).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Find reference' }).getAttribute('data-variant')).toBe(
    'outline'
  )
  expect(review.getAttribute('data-variant')).toBe('default')
  expect(screen.getByText('PMID:35486828')).not.toBeNull()
  expect(onResolved).not.toHaveBeenCalled()
  fireEvent.click(review)
  expect(onBatchResolved.mock.calls[0][0]).toEqual([item])
})

it('bounds the batch and keeps Enter available for multiline input', async () => {
  render(
    <LiteratureLinkImportDialog onBatchResolved={vi.fn()} onClose={vi.fn()} onResolved={vi.fn()} />
  )
  enter('10.1234/a')
  fireEvent.keyDown(screen.getByLabelText('DOI, arXiv, PMID, PMCID or links'), { key: 'Enter' })
  expect(lookupMetadata).not.toHaveBeenCalled()
  enter(Array.from({ length: 101 }, () => '10.1234/a').join('\n'))
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  expect(await screen.findByRole('alert')).not.toBeNull()
  expect(lookupMetadata).not.toHaveBeenCalled()
})

it('stops dispatching remaining batch lookups after cancellation', async () => {
  let finish!: (value: typeof item) => void
  lookupMetadata.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const onBatchResolved = vi.fn()
  render(
    <LiteratureLinkImportDialog
      onBatchResolved={onBatchResolved}
      onClose={vi.fn()}
      onResolved={vi.fn()}
    />
  )
  enter('10.1234/a\n10.1234/b')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await act(async () => finish(item))
  expect(lookupMetadata).toHaveBeenCalledTimes(1)
  expect(onBatchResolved).not.toHaveBeenCalled()
})

it('continues after an early provider failure and preserves native metadata without serialization', async () => {
  const rich = literatureItemInputSchema.parse({
    ...item,
    itemType: 'review',
    rights: 'CC BY 4.0',
    citationKey: 'existing-key',
    extra: 'Keep this note',
    typeFields: { volume: '12', custom: 'Keep this field' },
    identifiers: [
      { scheme: 'pmcid', value: 'PMC12345', isPrimary: true },
      { scheme: 'pmid', value: '35486828', isPrimary: false }
    ]
  })
  lookupMetadata
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(rich)
    .mockResolvedValueOnce(item)
  const onBatchResolved = vi.fn()
  render(
    <LiteratureLinkImportDialog
      onBatchResolved={onBatchResolved}
      onClose={vi.fn()}
      onResolved={vi.fn()}
    />
  )
  enter('10.1234/missing\nPMC12345\ninvalid\narxiv:2401.12345')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Review references' }))
  expect(lookupMetadata.mock.calls.map(([reference]) => reference)).toEqual([
    '10.1234/missing',
    'pmcid:PMC12345',
    'arxiv:2401.12345'
  ])
  expect(onBatchResolved).toHaveBeenCalledExactlyOnceWith([rich, item])
})

it('allows retry when every lookup fails and never offers an empty import', async () => {
  lookupMetadata.mockRejectedValue(new Error('Offline'))
  render(
    <LiteratureLinkImportDialog onBatchResolved={vi.fn()} onClose={vi.fn()} onResolved={vi.fn()} />
  )
  enter('10.1234/a\n10.1234/b')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Find reference' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  expect(screen.queryByRole('button', { name: 'Review references' })).toBeNull()
  expect(
    (screen.getByLabelText('DOI, arXiv, PMID, PMCID or links') as HTMLTextAreaElement).value
  ).toBe('10.1234/a\n10.1234/b')
  lookupMetadata.mockResolvedValue(item)
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  expect(await screen.findByRole('button', { name: 'Review references' })).not.toBeNull()
})

it('treats a successful single lookup as a terminal handoff even before the parent unmounts', async () => {
  lookupMetadata.mockResolvedValue(item)
  const onResolved = vi.fn()
  render(
    <LiteratureLinkImportDialog
      onBatchResolved={vi.fn()}
      onClose={vi.fn()}
      onResolved={onResolved}
    />
  )
  enter('10.1234/a')
  fireEvent.click(screen.getByRole('button', { name: 'Find reference' }))
  await waitFor(() => expect(onResolved).toHaveBeenCalledOnce())
  fireEvent.keyDown(screen.getByLabelText('DOI, arXiv, PMID, PMCID or links'), {
    key: 'Enter',
    ctrlKey: true
  })
  expect(lookupMetadata).toHaveBeenCalledTimes(1)
})
