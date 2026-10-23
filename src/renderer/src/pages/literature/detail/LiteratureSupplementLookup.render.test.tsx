// @vitest-environment jsdom
import { FileTypeIcon } from '@/pages/workspace/file-type-icon'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type {
  LiteratureSupplementRequest,
  LiteratureSupplementResult
} from '@aipoch/literature-discovery/contracts'
import { LiteratureSupplementLookup } from './LiteratureSupplementLookup'
import { StrictMode } from 'react'

const { render } = createLiteratureTestRenderer({
  FileTypeIcon,
  get api() {
    return window.api
  }
})
const supplements =
  vi.fn<(request: LiteratureSupplementRequest) => Promise<LiteratureSupplementResult>>()
const item: LiteratureItemView = {
  id: 'paper',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Paper',
    identifiers: [{ scheme: 'doi', value: '10.1234/paper' }]
  })
}
const result = (
  provider: LiteratureSupplementResult['provider'],
  extra: Partial<LiteratureSupplementResult> = {}
): LiteratureSupplementResult => ({
  itemId: item.id,
  metadataRevision: 1,
  doi: '10.1234/paper',
  provider,
  state: 'complete',
  issues: [],
  records: [],
  ...extra
})
const record = {
  id: 'one',
  title: 'Independent data',
  doi: '10.1234/data',
  sourceUrl: 'https://doi.org/10.1234/data',
  evidence: 'source-declared' as const
}
const props = { item, onCompleteMetadata: vi.fn() }
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
  supplements.mockReset().mockImplementation(async ({ provider }) => result(provider))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { supplements } }
  })
})
afterEach(cleanup)

describe('supplement lookup lifecycle', () => {
  it('filters cached source results, combines selections and restores all without fetching', async () => {
    supplements.mockImplementation(async ({ provider }) =>
      result(provider, {
        records: [
          { ...record, id: provider, doi: `10.1234/${provider}`, title: `${provider} result` }
        ]
      })
    )
    render(<LiteratureSupplementLookup {...props} />)
    await screen.findByText('figshare result')
    const sources = within(screen.getByRole('region', { name: 'Search sources' }))
    expect(sources.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Europe PMC',
      'DataCite',
      'Figshare'
    ])
    fireEvent.click(sources.getByRole('button', { name: 'Europe PMC' }))
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByText('europe-pmc result')).toBeTruthy()
    fireEvent.click(sources.getByRole('button', { name: 'DataCite' }))
    expect(screen.getAllByRole('article')).toHaveLength(2)
    fireEvent.click(sources.getByRole('button', { name: 'Europe PMC' }))
    fireEvent.click(sources.getByRole('button', { name: 'DataCite' }))
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(supplements).toHaveBeenCalledTimes(3)
  })
  it('adds the selected ordinary file once and keeps the receipt even if refresh fails', async () => {
    const downloadId = 'd1b720c7-1000-4000-8000-000000000001'
    supplements.mockImplementation(async ({ provider }) =>
      result(provider, {
        records:
          provider === 'europe-pmc'
            ? [{ ...record, files: [{ name: 'supplement.docx', downloadId }] }]
            : []
      })
    )
    const pending = deferred<{ attachmentId: string; versionId: string }>()
    const attach = vi.fn(() => pending.promise)
    Object.assign(window.api.literature, {
      supplementAttachment: attach,
      supplementAttachmentProgress: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockRejectedValue(new Error('refresh'))
    })
    render(<LiteratureSupplementLookup {...props} />)
    const button = await screen.findByRole('button', { name: 'Add attachment' })
    expect(
      screen.getByText('supplement.docx').closest('li')?.querySelector('.lucide-file-pen-line')
    ).not.toBeNull()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.getByText('0 B · Waiting for server…')).toBeTruthy()
    expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
    expect(screen.queryByRole('button', { name: 'Downloading…' })).toBeNull()
    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach).toHaveBeenCalledWith({
      itemId: item.id,
      expectedMetadataRevision: 1,
      downloadId
    })
    await act(async () => pending.resolve({ attachmentId: 'a', versionId: 'v' }))
    expect(await screen.findByRole('button', { name: 'Attachment added' })).toHaveProperty(
      'disabled',
      true
    )
    expect(supplements).toHaveBeenCalledTimes(3)
  })
  it.each([true, false])(
    'shows real per-file download progress with known size: %s',
    async (known) => {
      const downloadId = 'd1b720c7-1000-4000-8000-000000000001'
      supplements.mockImplementation(async ({ provider }) =>
        result(provider, {
          records:
            provider === 'europe-pmc'
              ? [{ ...record, files: [{ name: 'data.docx', downloadId }] }]
              : []
        })
      )
      const pending = deferred<{ attachmentId: string; versionId: string }>()
      const readProgress = vi.fn().mockResolvedValue({
        phase: 'downloading',
        receivedBytes: 1024,
        totalBytes: known ? 2048 : undefined,
        bytesPerSecond: 512
      })
      Object.assign(window.api.literature, {
        supplementAttachment: vi.fn(() => pending.promise),
        supplementAttachmentProgress: readProgress,
        get: vi.fn().mockResolvedValue(item)
      })
      const view = render(<LiteratureSupplementLookup {...props} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Add attachment' }))
      await screen.findByText(/1\.0 KB/)
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
        known ? '50' : null
      )
      expect(screen.getByText(/512 B\/s/).textContent).toBe(
        known ? '1.0 KB / 2.0 KB · 512 B/s' : '1.0 KB · 512 B/s'
      )
      expect(readProgress).toHaveBeenCalledWith({
        itemId: item.id,
        expectedMetadataRevision: 1,
        downloadId
      })
      readProgress.mockResolvedValue({
        phase: 'saving',
        receivedBytes: 2048,
        totalBytes: 2048,
        bytesPerSecond: 0
      })
      await screen.findByText('Saving…')
      expect(screen.queryByRole('progressbar')).toBeNull()
      await act(async () => pending.resolve({ attachmentId: 'a', versionId: 'v' }))
      await screen.findByRole('button', { name: 'Attachment added' })
      view.unmount()
    }
  )
  it('admits each source once under Strict Mode', async () => {
    render(
      <StrictMode>
        <LiteratureSupplementLookup {...props} />
      </StrictMode>
    )
    await screen.findByText('No supplementary materials found in the searched sources.')
    expect(supplements).toHaveBeenCalledTimes(3)
  })

  it('invalidates pending results when the runtime API is replaced', async () => {
    const previous = deferred<LiteratureSupplementResult>()
    supplements.mockImplementation(() => previous.promise)
    const view = render(<LiteratureSupplementLookup {...props} />)
    await waitFor(() => expect(supplements).toHaveBeenCalledTimes(3))
    const replacement = vi.fn(async ({ provider }: LiteratureSupplementRequest) =>
      result(provider, { records: [{ ...record, title: 'New runtime data' }] })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { literature: { supplements: replacement } }
    })
    view.rerender(<LiteratureSupplementLookup {...props} />)
    await screen.findByText('New runtime data')
    await act(async () =>
      previous.resolve(result('figshare', { records: [{ ...record, title: 'Old runtime data' }] }))
    )
    expect(screen.queryByText('Old runtime data')).toBeNull()
    expect(replacement).toHaveBeenCalledTimes(3)
  })
  it('shows early results and retries only a failed source while preserving other cards', async () => {
    const delayed = deferred<LiteratureSupplementResult>()
    supplements.mockImplementation(async ({ provider }) =>
      provider === 'figshare'
        ? delayed.promise
        : result(provider, provider === 'datacite' ? { records: [record] } : {})
    )
    render(<LiteratureSupplementLookup {...props} />)
    expect(await screen.findByText('Independent data')).toBeTruthy()
    expect(
      within(screen.getByRole('region', { name: 'Figshare' })).getByText('Searching…')
    ).toBeTruthy()
    await act(async () =>
      delayed.resolve(result('figshare', { state: 'unavailable', issues: ['unavailable'] }))
    )
    const retry = await screen.findByRole('button', { name: 'Retry Figshare' })
    const second = deferred<LiteratureSupplementResult>()
    supplements.mockImplementation(async ({ provider }) =>
      provider === 'figshare' ? second.promise : result(provider)
    )
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(supplements.mock.calls.map(([r]) => r.provider)).toEqual([
      'figshare',
      'datacite',
      'europe-pmc',
      'figshare'
    ])
    expect(screen.getByText('Independent data')).toBeTruthy()
    await act(async () =>
      second.resolve(
        result('figshare', {
          records: [{ ...record, id: '42', files: [{ name: 'data.tsv', sizeBytes: 100 }] }]
        })
      )
    )
    expect(await screen.findByText('data.tsv')).toBeTruthy()
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Retry Figshare' })).toBeNull()
  })
  it('ignores late responses after switching reference revision and starts fresh on reopening', async () => {
    const old = deferred<LiteratureSupplementResult>()
    supplements.mockImplementation(() => old.promise)
    const view = render(<LiteratureSupplementLookup {...props} />)
    await waitFor(() => expect(supplements).toHaveBeenCalledTimes(3))
    supplements.mockImplementation(async ({ provider, expectedMetadataRevision }) =>
      result(provider, { metadataRevision: expectedMetadataRevision })
    )
    view.rerender(<LiteratureSupplementLookup {...props} item={{ ...item, metadataRevision: 2 }} />)
    await waitFor(() => expect(supplements).toHaveBeenCalledTimes(6))
    await act(async () =>
      old.resolve(result('figshare', { records: [{ ...record, title: 'Stale result' }] }))
    )
    expect(screen.queryByText('Stale result')).toBeNull()
    view.unmount()
    render(<LiteratureSupplementLookup {...props} />)
    await waitFor(() => expect(supplements).toHaveBeenCalledTimes(9))
  })
  it('rejects mismatched response identity and unsafe source links', async () => {
    supplements.mockImplementation(async ({ provider }) =>
      result(provider, {
        records: [{ ...record, sourceUrl: 'javascript:alert(1)' }],
        itemId: 'other'
      })
    )
    render(<LiteratureSupplementLookup {...props} />)
    expect(await screen.findByText('Supplementary material search failed.')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
  it('offers metadata completion without making requests for conflicting DOI identifiers', () => {
    render(
      <LiteratureSupplementLookup
        {...props}
        item={{
          ...item,
          item: {
            ...item.item,
            identifiers: [
              { scheme: 'doi', value: '10.1234/a', isPrimary: true },
              { scheme: 'doi', value: '10.1234/b', isPrimary: false }
            ]
          }
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Complete metadata' }))
    expect(props.onCompleteMetadata).toHaveBeenCalled()
    expect(supplements).not.toHaveBeenCalled()
  })
  it('keeps rate-limited retries disabled and never retries automatically', async () => {
    supplements.mockImplementation(async ({ provider }) =>
      result(provider, {
        state: 'unavailable',
        issues: ['rate-limited'],
        retryAt: Date.now() + 60_000
      })
    )
    render(<LiteratureSupplementLookup {...props} />)
    await screen.findByText('Supplementary material search failed.')
    for (const button of screen.getAllByRole('button', { name: /^Retry / }))
      expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(supplements).toHaveBeenCalledTimes(3)
  })
  it('distinguishes unavailable full text and absent file metadata from an empty successful lookup', async () => {
    supplements.mockImplementation(async ({ provider }) =>
      result(
        provider,
        provider === 'europe-pmc'
          ? { state: 'partial', issues: ['full-text-unavailable'] }
          : provider === 'datacite'
            ? { records: [record] }
            : {}
      )
    )
    render(<LiteratureSupplementLookup {...props} />)
    await screen.findByRole('button', { name: 'Retry Europe PMC' })
    expect(screen.queryByText('No readable article text is available from this source.')).toBeNull()
    const status = within(screen.getByRole('region', { name: 'Europe PMC' })).getByRole('status')
    fireEvent.focus(status)
    expect((await screen.findByRole('tooltip')).textContent).toContain(
      'No readable article text is available from this source.'
    )
    expect(screen.getByText('File list not provided. Open the source to view files.')).toBeTruthy()
    expect(screen.queryByText('License not provided')).toBeNull()
    expect(screen.getByRole('link', { name: 'Open source' }).getAttribute('rel')).toBe(
      'noopener noreferrer'
    )
    expect(
      screen.queryByText('No supplementary materials found in the searched sources.')
    ).toBeNull()
  })
})
