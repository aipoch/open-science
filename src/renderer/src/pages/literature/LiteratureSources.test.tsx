// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiteratureSources } from './LiteratureSources'
import type { LiteratureSourceRecordView } from '../../../../shared/literature'

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

  it('distinguishes loading failure from an empty result and retries', async () => {
    sources.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValueOnce([])
    render(<LiteratureSources itemId="item-1" />)
    await toggle('Metadata sources')
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.queryByText('No saved metadata sources for this reference.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No saved metadata sources for this reference.')).not.toBeNull()
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
