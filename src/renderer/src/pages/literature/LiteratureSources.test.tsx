// @vitest-environment jsdom
import { createLiteratureTestRenderer } from '../../../../../test/renderer/literature'
import type { LiteratureSourceRecordView } from '@aipoch/literature-library/contracts'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiteratureSources } from './LiteratureSources'

const { render } = createLiteratureTestRenderer({
  get api() {
    return window.api
  },
  onRecovered: () => () => {}
})

const record: LiteratureSourceRecordView = {
  id: 'source-1',
  provider: 'Crossref',
  externalId: '10.1234/example',
  sourceUrl: 'https://example.test/metadata',
  rawMetadata: { title: 'Reviewed title' },
  savedAt: 1700000000000
}
const sources = vi.fn()
const toggle = async (label: string, open = true): Promise<void> => {
  const details = screen.getByText(label).closest('details')!
  await act(async () => {
    details.open = open
    fireEvent(details, new Event('toggle'))
  })
}

afterEach(cleanup)
beforeEach(() => {
  sources.mockReset().mockResolvedValue([record])
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { sources } } })
})

describe('LiteratureSources', () => {
  it('loads saved evidence only when opened and expands the stored JSON without fetching again', async () => {
    render(<LiteratureSources itemId="item-1" />)
    expect(sources).not.toHaveBeenCalled()
    await toggle('Metadata sources')
    expect(await screen.findByText('Crossref')).not.toBeNull()
    expect(screen.getByRole('link').getAttribute('href')).toBe(record.sourceUrl)
    expect(screen.queryByText(/Reviewed title/)).toBeNull()
    await toggle('Stored metadata')
    expect(screen.getByLabelText('Stored metadata').textContent).toContain('Reviewed title')
    expect(sources).toHaveBeenCalledExactlyOnceWith('item-1')
    expect(screen.getByText(/Source record saved:/)).not.toBeNull()
  })

  it('distinguishes acquisition time from save time and ignores malformed legacy values', async () => {
    sources.mockResolvedValue([{ ...record, rawMetadata: { retrievedAt: 1600000000000 } }])
    const view = render(<LiteratureSources itemId="item-1" />)
    await toggle('Metadata sources')
    expect(await screen.findByText(/Fetched:/)).toBeTruthy()
    expect(screen.getByText(/Source record saved:/)).toBeTruthy()
    view.unmount()
    sources.mockResolvedValue([{ ...record, rawMetadata: { retrievedAt: 'unknown' } }])
    render(<LiteratureSources itemId="item-2" />)
    await toggle('Metadata sources')
    await screen.findByText('Crossref')
    expect(screen.queryByText(/Fetched:/)).toBeNull()
  })

  it('distinguishes loading failure from an empty result and retries', async () => {
    sources.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce([])
    render(<LiteratureSources itemId="item-1" />)
    await toggle('Metadata sources')
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.queryByText('No sources saved')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No sources saved')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(sources).toHaveBeenCalledTimes(2)
  })

  it('ignores a response after the selected reference has changed', async () => {
    let resolveFirst!: (records: LiteratureSourceRecordView[]) => void
    sources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    const view = render(<LiteratureSources key="first" itemId="first" />)
    await toggle('Metadata sources')
    view.rerender(<LiteratureSources key="second" itemId="second" />)
    sources.mockResolvedValueOnce([{ ...record, id: 'second-source', provider: 'PubMed' }])
    await toggle('Metadata sources')
    expect(await screen.findByText('PubMed')).not.toBeNull()
    await act(async () => resolveFirst([record]))
    expect(screen.queryByText('Crossref')).toBeNull()
    expect(screen.getByText('PubMed')).not.toBeNull()
  })

  it('shows unsafe stored URLs as text instead of executable links', async () => {
    sources.mockResolvedValue([
      {
        ...record,
        sourceUrl: 'javascript:alert(1)',
        rawMetadata: { title: '<script>bad</script>' }
      }
    ])
    render(<LiteratureSources itemId="item-1" />)
    await toggle('Metadata sources')
    await waitFor(() => expect(screen.getByText('javascript:alert(1)')).not.toBeNull())
    expect(screen.queryByRole('link')).toBeNull()
    await toggle('Stored metadata')
    expect(screen.getByLabelText('Stored metadata').querySelector('script')).toBeNull()
    expect(screen.getByLabelText('Stored metadata').textContent).toContain('<script>bad</script>')
  })
})

it('refreshes saved sources while the disclosure stays open', async () => {
  const listeners = new Set<() => void>()
  Object.assign(window.api.literature, {
    onChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  })
  render(<LiteratureSources itemId="item-1" />)
  await toggle('Metadata sources')
  expect(await screen.findByText('Crossref')).not.toBeNull()
  sources.mockResolvedValue([record, { ...record, id: 'source-2', provider: 'PubMed' }])
  await act(async () => {
    for (const listener of listeners) listener()
  })
  expect(screen.queryByText('PubMed')).not.toBeNull()
})

it('summarizes legacy and current citation evidence and retains identifiers when roots are unavailable', async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce({ item: { title: 'Original paper' } })
    .mockRejectedValueOnce(new Error('unavailable'))
  Object.assign(window.api.literature, { get })
  sources.mockResolvedValue([
    {
      ...record,
      provider: 'europe-pmc',
      rawMetadata: {
        rootItemId: 'root-a',
        seedPaperId: 'europe-pmc:MED:1',
        direction: 'references'
      }
    },
    {
      ...record,
      id: 'second',
      provider: 'opencitations',
      rawMetadata: {
        citationContexts: [
          null,
          {
            rootItemId: 'root-b',
            seedPaperId: 'opencitations:br/2',
            directions: ['citations'],
            lookupMode: 'index',
            rootMetadataRevision: 2
          },
          {
            rootItemId: 'root-b',
            seedPaperId: 'opencitations:br/2',
            directions: ['references'],
            lookupMode: 'skg-if',
            rootMetadataRevision: 1
          }
        ]
      }
    }
  ])
  render(<LiteratureSources itemId="item-1" />)
  await toggle('Metadata sources')
  expect(await screen.findByText('Exploration started from Original paper')).not.toBeNull()
  expect(screen.getAllByText('Exploration started from root-b')).toHaveLength(2)
  expect(screen.getByText('Metadata revision 2')).toBeTruthy()
  expect(screen.getByText('Metadata revision 1')).toBeTruthy()
  expect(screen.getByText('OpenCitations · Index v2')).toBeTruthy()
  expect(screen.getByText('OpenCitations · SKG-IF')).toBeTruthy()
  expect(screen.getByText('References · europe-pmc:MED:1')).not.toBeNull()
  expect(screen.getByText('Cited by · opencitations:br/2')).not.toBeNull()
  expect(get).toHaveBeenCalledTimes(2)
})
