// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  literatureItemInputSchema,
  type LiteratureItemView,
  type LiteratureMetadataCompletionResult
} from '../../../../shared/literature'
import { LiteratureBatchLookupDialog } from './LiteratureBatchLookupDialog'

const first: LiteratureItemView = {
  id: 'first',
  metadataRevision: 3,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'First paper',
    identifiers: [{ scheme: 'doi', value: '10.1234/example' }]
  })
}
const second = { ...first, id: 'second', item: { ...first.item, title: 'Second paper' } }
const third = { ...first, id: 'third', item: { ...first.item, title: 'Third paper' } }
const candidate = {
  id: 'old-token',
  provider: 'pmc',
  source: 'PubMed Central',
  sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/',
  url: 'https://download.test/article.pdf'
}
const completeMetadata = vi.fn()
const fullText = vi.fn()
const get = vi.fn()
const onChanged = vi.fn()
const onClose = vi.fn()
const preview = (item: LiteratureItemView): LiteratureMetadataCompletionResult => ({
  mode: 'preview',
  item,
  provider: 'crossref',
  sourceUrl: 'https://crossref.org',
  filled: [{ field: 'journal', value: 'Journal of Testing' }],
  conflicts: [{ field: 'title', currentValue: item.item.title, value: 'Replacement title' }]
})
const flush = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500)
  })
}
const open = (mode: 'metadata' | 'full-text', items = [first, second]): void => {
  render(
    <LiteratureBatchLookupDialog
      mode={mode}
      itemIds={items.map(({ id }) => id)}
      initialItems={items}
      fieldLabel={(field) => field}
      onChanged={onChanged}
      onClose={onClose}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  get.mockImplementation(async (id: string) =>
    [first, second, third].find((item) => item.id === id)
  )
  completeMetadata.mockImplementation(async ({ itemId }) =>
    preview(itemId === first.id ? first : second)
  )
  fullText.mockImplementation(async ({ mode }) =>
    mode === 'search'
      ? { mode, candidates: [candidate], notices: [] }
      : mode === 'progress'
        ? { mode }
        : { mode, item: first }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { get, fullText, completeMetadata } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('previews before writing and applies only checked references without overwrites', async () => {
  open('metadata')
  await flush()
  expect(completeMetadata.mock.calls.every(([request]) => request.mode === 'preview')).toBe(true)
  expect(screen.getAllByText('Journal of Testing')).toHaveLength(2)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select reference: Second paper' }))
  fireEvent.click(screen.getByRole('button', { name: 'Apply metadata (1)' }))
  await flush()
  expect(completeMetadata).toHaveBeenLastCalledWith({
    mode: 'commit',
    itemId: first.id,
    expectedMetadataRevision: 3,
    overwriteFields: []
  })
  expect(completeMetadata.mock.calls.filter(([request]) => request.mode === 'commit')).toHaveLength(
    1
  )
  expect(onChanged).toHaveBeenCalledTimes(1)
})

it('finishes the current request after Stop and does not start later references', async () => {
  let resolve!: (value: ReturnType<typeof preview>) => void
  completeMetadata.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  open('metadata')
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  expect(screen.getByText('Stopping after the current reference…')).not.toBeNull()
  await act(async () => resolve(preview(first)))
  await flush()
  expect(get).toHaveBeenCalledTimes(1)
  expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2)
  expect(onChanged).not.toHaveBeenCalled()
})

it('skips attached PDFs and refreshes candidate tokens before confirmed downloads', async () => {
  const attached: LiteratureItemView = {
    ...second,
    attachments: [
      {
        id: 'attachment',
        kind: 'fullText',
        title: '',
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
        versions: [
          {
            id: 'version',
            versionNumber: 1,
            filename: 'paper.pdf',
            contentType: 'application/pdf',
            sizeBytes: 12,
            checksum: 'a'.repeat(64),
            createdAt: 1
          }
        ]
      }
    ]
  }
  get.mockImplementation(async (id: string) => (id === first.id ? first : attached))
  fullText.mockResolvedValueOnce({ mode: 'search', candidates: [candidate], notices: [] })
  open('full-text', [first, attached])
  await flush()
  expect(screen.getByText('PDF already attached')).not.toBeNull()
  expect(fullText).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('link', { name: 'Open source' }).getAttribute('href')).toBe(
    candidate.sourceUrl
  )
  fullText.mockImplementation(async ({ mode }) =>
    mode === 'search'
      ? { mode, candidates: [{ ...candidate, id: 'fresh-token' }], notices: [] }
      : mode === 'progress'
        ? { mode }
        : { mode, item: first }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add attachment (1)' }))
  await flush()
  expect(fullText).toHaveBeenCalledWith({
    mode: 'attach',
    itemId: first.id,
    candidateId: 'fresh-token'
  })
  expect(onChanged).toHaveBeenCalledTimes(1)
})

it('continues after failure and sends the preview revision so stale metadata cannot be overwritten', async () => {
  open('metadata')
  await flush()
  completeMetadata
    .mockRejectedValueOnce(new Error('Revision conflict'))
    .mockResolvedValueOnce({ ...preview(second), mode: 'commit' })
  fireEvent.click(screen.getByRole('button', { name: 'Apply metadata (2)' }))
  await flush()
  expect(screen.getByText('Metadata could not be completed.')).not.toBeNull()
  expect(completeMetadata).toHaveBeenCalledWith({
    mode: 'commit',
    itemId: first.id,
    expectedMetadataRevision: 3,
    overwriteFields: []
  })
  expect(completeMetadata).toHaveBeenLastCalledWith({
    mode: 'commit',
    itemId: second.id,
    expectedMetadataRevision: 3,
    overwriteFields: []
  })
  expect(screen.getByText('Completed 1 · Skipped 0 · Failed 1')).not.toBeNull()
})

it('does not silently download a replacement source after the confirmed URL disappears', async () => {
  open('full-text', [first])
  await flush()
  fullText.mockResolvedValue({
    mode: 'search',
    candidates: [{ ...candidate, id: 'new', url: 'https://different.test/other.pdf' }],
    notices: []
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add attachment (1)' }))
  await flush()
  expect(fullText.mock.calls.some(([request]) => request.mode === 'attach')).toBe(false)
  expect(
    screen.getByText('The selected source changed. Search again and review the results.')
  ).not.toBeNull()
})

it('respects a source cooldown across references without retrying its download endpoint', async () => {
  open('full-text')
  await flush()
  fullText.mockImplementation(async ({ mode }) =>
    mode === 'search'
      ? { mode, candidates: [candidate], notices: [] }
      : mode === 'progress'
        ? { mode }
        : { mode: 'attach-error', reason: 'rate-limited', retryAt: Date.now() + 60_000 }
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add attachment (2)' }))
  await flush()
  expect(fullText.mock.calls.filter(([request]) => request.mode === 'attach')).toHaveLength(1)
  expect(screen.getAllByText('Source rate limit reached. Search again later.')).toHaveLength(2)
  expect(onChanged).not.toHaveBeenCalled()
})
