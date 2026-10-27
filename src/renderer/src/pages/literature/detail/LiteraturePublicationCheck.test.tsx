// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type {
  LiteratureChangedEvent,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import type {
  LiteraturePublicationCheckRequest,
  LiteraturePublicationCheckResult,
  LiteraturePublicationCheckSnapshot
} from '@aipoch/literature-discovery/contracts'
import { LiteraturePublicationCheck } from './LiteraturePublicationCheck'

const publicationCheck =
  vi.fn<(request: LiteraturePublicationCheckRequest) => Promise<LiteraturePublicationCheckResult>>()
let changed: ((event?: LiteratureChangedEvent) => void) | undefined
let recovered: (() => void) | undefined
const onChanged = vi.fn((listener: typeof changed) => {
  changed = listener
  return () => {
    changed = undefined
  }
})
const { render } = createLiteratureTestRenderer({
  get api() {
    return window.api
  },
  onRecovered: (listener) => {
    recovered = listener
    return () => {
      recovered = undefined
    }
  }
})
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
const snapshot: LiteraturePublicationCheckSnapshot = {
  doi: '10.1234/paper',
  checkedAt: 1700000000000,
  notices: [{ doi: '10.1234/notice', type: 'retraction', source: 'publisher', date: '2024-01-02' }]
}
const result = (
  extra: Partial<LiteraturePublicationCheckResult> = {}
): LiteraturePublicationCheckResult => ({
  itemId: item.id,
  metadataRevision: item.metadataRevision,
  ...extra
})
const deferred = <T,>(): { promise: Promise<T>; resolve(value: T): void } => {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve: (value) => resolve(value)
  }
}
const checkButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Check retractions and corrections' })

beforeEach(() => {
  changed = undefined
  recovered = undefined
  publicationCheck.mockReset().mockResolvedValue(result())
  onChanged.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { publicationCheck, onChanged } }
  })
})
afterEach(cleanup)

describe('single reference publication checks', () => {
  it('only reads saved results on opening, including StrictMode remounts', async () => {
    render(
      <StrictMode>
        <LiteraturePublicationCheck item={item} />
      </StrictMode>
    )
    await screen.findByText('No saved publication check. Run a check to look for related notices.')
    expect(publicationCheck.mock.calls.length).toBeGreaterThan(0)
    expect(publicationCheck.mock.calls.every(([request]) => request.mode === 'get')).toBe(true)
    expect(publicationCheck).toHaveBeenCalledWith({
      mode: 'get',
      itemId: item.id,
      expectedMetadataRevision: 1
    })
    expect(screen.queryByText('No related notices found.')).toBeNull()
    expect(checkButton().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('disables the check for absent or ambiguous DOI without sending a request', () => {
    const view = render(
      <LiteraturePublicationCheck item={{ ...item, item: { ...item.item, identifiers: [] } }} />
    )
    expect(checkButton()).toHaveProperty('disabled', true)
    expect(screen.getByText('Add one valid DOI to check this reference.')).toBeTruthy()
    view.rerender(
      <LiteraturePublicationCheck
        item={{
          ...item,
          item: {
            ...item.item,
            identifiers: [
              { scheme: 'doi', value: '10.1234/one', isPrimary: true },
              { scheme: 'doi', value: '10.1234/two', isPrimary: false }
            ]
          }
        }}
      />
    )
    expect(checkButton()).toHaveProperty('disabled', true)
    expect(publicationCheck).not.toHaveBeenCalled()
  })

  it('restores every saved notice with plain text, original type, source, date and DOI link', async () => {
    publicationCheck.mockResolvedValue(
      result({
        snapshot: {
          ...snapshot,
          notices: [
            snapshot.notices[0]!,
            { doi: '10.1234/notice', type: 'Erratum', source: 'crossref' },
            { doi: '10.1234/concern', type: 'expression_of_concern', source: 'retraction-watch' },
            { doi: '10.1234/reinstate', type: 'Reinstatement', source: 'publisher' },
            { doi: '10.1234/unknown', type: '<b>new-type</b>', source: 'crossref' },
            { doi: '10.1234/partial', type: 'partial_retraction', source: 'publisher' },
            { doi: '10.1234/withdraw', type: 'withdrawal', source: 'crossref' }
          ]
        }
      })
    )
    const view = render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('Expression of concern')
    expect(screen.getAllByRole('listitem')).toHaveLength(7)
    expect(screen.getByText('Retraction notice')).toBeTruthy()
    expect(screen.getByText('Partial retraction notice')).toBeTruthy()
    expect(screen.getByText('Withdrawal notice')).toBeTruthy()
    expect(screen.getByText('Correction notice')).toBeTruthy()
    expect(screen.getByText('Reinstatement notice')).toBeTruthy()
    expect(screen.getByText('Publication update')).toBeTruthy()
    expect(screen.getByText('<b>new-type</b>')).toBeTruthy()
    expect(view.container.querySelector('b')).toBeNull()
    expect(screen.getByText('Retraction Watch via Crossref')).toBeTruthy()
    expect(screen.getAllByText(/^Publisher via Crossref/)).toHaveLength(3)
    expect(screen.getByText('2024-01-02').getAttribute('datetime')).toBe('2024-01-02')
    const links = screen.getAllByRole('link')
    expect(links[0]?.getAttribute('href')).toBe('https://doi.org/10.1234%2Fnotice')
    expect(links[0]?.getAttribute('target')).toBe('_blank')
    expect(screen.getByText(/Last checked:/)).toBeTruthy()
    expect(publicationCheck.mock.calls.every(([request]) => request.mode === 'get')).toBe(true)
  })

  it('shows a positive empty result with its coverage limitation only after a completed check', async () => {
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('No saved publication check. Run a check to look for related notices.')
    publicationCheck.mockResolvedValue(result({ snapshot: { ...snapshot, notices: [] } }))
    fireEvent.click(checkButton())
    await screen.findByText('No related notices found.')
    expect(
      screen.getByText(
        'Checking sends only this DOI to Crossref. Coverage is incomplete; no notices does not establish that a reference is reliable.'
      )
    ).toBeTruthy()
    expect(publicationCheck).toHaveBeenLastCalledWith({
      mode: 'check',
      itemId: item.id,
      expectedMetadataRevision: 1
    })
  })

  it('locks immediately against repeated clicks until the request settles', async () => {
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('No saved publication check. Run a check to look for related notices.')
    const pending = deferred<LiteraturePublicationCheckResult>()
    publicationCheck.mockReturnValue(pending.promise)
    act(() => {
      fireEvent.click(checkButton())
      fireEvent.click(checkButton())
    })
    expect(
      publicationCheck.mock.calls.filter(([request]) => request.mode === 'check')
    ).toHaveLength(1)
    expect(checkButton()).toHaveProperty('disabled', true)
    expect(screen.getByRole('status').textContent).toBe('Checking Crossref…')
    await act(async () => pending.resolve(result({ snapshot })))
    expect(checkButton()).toHaveProperty('disabled', false)
  })

  it.each(['item', 'revision', 'doi'] as const)(
    'ignores old responses when the %s changes',
    async (change) => {
      const pending = deferred<LiteraturePublicationCheckResult>()
      publicationCheck.mockReturnValueOnce(pending.promise)
      const view = render(<LiteraturePublicationCheck item={item} />)
      await waitFor(() => expect(publicationCheck).toHaveBeenCalledTimes(1))
      const next =
        change === 'item'
          ? { ...item, id: 'other' }
          : change === 'revision'
            ? { ...item, metadataRevision: 2 }
            : {
                ...item,
                item: {
                  ...item.item,
                  identifiers: [{ scheme: 'doi' as const, value: '10.1234/new', isPrimary: true }]
                }
              }
      publicationCheck.mockResolvedValue({
        itemId: next.id,
        metadataRevision: next.metadataRevision
      })
      view.rerender(<LiteraturePublicationCheck item={next} />)
      await screen.findByText(
        'No saved publication check. Run a check to look for related notices.'
      )
      await act(async () => pending.resolve(result({ snapshot })))
      expect(screen.queryByText('Retraction notice')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    }
  )

  it('keeps the saved snapshot when checking fails and retries the explicit check', async () => {
    publicationCheck.mockResolvedValue(result({ snapshot }))
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('Retraction notice')
    publicationCheck.mockRejectedValueOnce(new Error('network detail must not leak'))
    fireEvent.click(checkButton())
    await screen.findByRole('alert')
    expect(screen.getByText('Retraction notice')).toBeTruthy()
    expect(screen.queryByText('network detail must not leak')).toBeNull()
    publicationCheck.mockResolvedValue(result({ snapshot: { ...snapshot, notices: [] } }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('No related notices found.')
    expect(publicationCheck).toHaveBeenLastCalledWith({
      mode: 'check',
      itemId: item.id,
      expectedMetadataRevision: 1
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a snapshot supplied alongside a recoverable issue', async () => {
    publicationCheck.mockResolvedValue(result({ snapshot, issue: 'rate-limited' }))
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('Crossref is receiving too many requests. Try again later.')
    expect(screen.getByText('Retraction notice')).toBeTruthy()
  })

  it('does not turn a failed saved-result read into an unchecked or empty success and retries get', async () => {
    publicationCheck.mockRejectedValueOnce(new Error('offline'))
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByRole('alert')
    expect(screen.queryByText('No related notices found.')).toBeNull()
    expect(
      screen.queryByText('No saved publication check. Run a check to look for related notices.')
    ).toBeNull()
    publicationCheck.mockResolvedValue(result({ snapshot }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Retraction notice')
    expect(publicationCheck.mock.calls.every(([request]) => request.mode === 'get')).toBe(true)
  })

  it.each([
    result({ itemId: 'wrong', snapshot }),
    result({ metadataRevision: 2, snapshot }),
    result({ snapshot: { ...snapshot, doi: '10.1234/wrong' } })
  ])('rejects mismatched result identity %#', async (response) => {
    publicationCheck.mockResolvedValue(response)
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('The publication check returned an invalid response. Try again.')
    expect(screen.queryByText('Retraction notice')).toBeNull()
  })

  it('invalidates a pending request on library changes and recovery without starting an external check', async () => {
    publicationCheck.mockResolvedValue(result({ snapshot }))
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('Retraction notice')
    const pending = deferred<LiteraturePublicationCheckResult>()
    publicationCheck.mockReturnValueOnce(pending.promise)
    fireEvent.click(checkButton())
    publicationCheck.mockResolvedValue(result({ issue: 'reference-unavailable' }))
    await act(async () => changed?.({ revision: 2, itemIds: [item.id] }))
    await screen.findByText('This reference is no longer available.')
    expect(screen.queryByText('Retraction notice')).toBeNull()
    await act(async () => pending.resolve(result({ snapshot })))
    expect(screen.queryByText('Retraction notice')).toBeNull()
    publicationCheck.mockResolvedValue(result({ snapshot: { ...snapshot, notices: [] } }))
    await act(async () => recovered?.())
    await screen.findByText('No related notices found.')
    expect(
      publicationCheck.mock.calls.filter(([request]) => request.mode === 'check')
    ).toHaveLength(1)
  })

  it('restores the new snapshot when its save event arrives before the check response', async () => {
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('No saved publication check. Run a check to look for related notices.')
    const pending = deferred<LiteraturePublicationCheckResult>()
    publicationCheck.mockReturnValueOnce(pending.promise)
    fireEvent.click(checkButton())
    publicationCheck.mockResolvedValue(result({ snapshot }))
    await act(async () => changed?.({ revision: 2, itemIds: [item.id] }))
    await screen.findByText('Retraction notice')
    expect(checkButton()).toHaveProperty('disabled', true)
    fireEvent.click(checkButton())
    expect(
      publicationCheck.mock.calls.filter(([request]) => request.mode === 'check')
    ).toHaveLength(1)
    await act(async () => pending.resolve(result({ snapshot })))
    expect(screen.getByText('Retraction notice')).toBeTruthy()
    expect(checkButton()).toHaveProperty('disabled', false)
    expect(publicationCheck.mock.calls.map(([request]) => request.mode)).toEqual([
      'get',
      'check',
      'get'
    ])
  })

  it.each([
    ['focus', 'timeout', 'The publication check timed out. Try again.'],
    ['change', 'rate-limited', 'Crossref is receiving too many requests. Try again later.']
  ] as const)(
    'preserves the manual %s check failure and retry after a same-identity saved read',
    async (event, issue, message) => {
      publicationCheck.mockResolvedValue(result({ snapshot }))
      render(<LiteraturePublicationCheck item={item} />)
      await screen.findByText('Retraction notice')
      const pending = deferred<LiteraturePublicationCheckResult>()
      publicationCheck.mockReturnValueOnce(pending.promise)
      fireEvent.click(checkButton())
      await act(async () => {
        if (event === 'focus') window.dispatchEvent(new Event('focus'))
        else changed?.({ revision: 2, itemIds: ['unrelated-reference'] })
      })
      await waitFor(() => expect(publicationCheck).toHaveBeenCalledTimes(3))
      await act(async () => pending.resolve(result({ issue })))
      expect(screen.getByText('Retraction notice')).toBeTruthy()
      expect(screen.queryByText(message)).toBeTruthy()
      // Later recovery reads must also retain the failed command's retry mode.
      await act(async () => recovered?.())
      expect(screen.queryByText(message)).toBeTruthy()
      publicationCheck.mockResolvedValue(result({ snapshot: { ...snapshot, notices: [] } }))
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await screen.findByText('No related notices found.')
      expect(publicationCheck).toHaveBeenLastCalledWith({
        mode: 'check',
        itemId: item.id,
        expectedMetadataRevision: item.metadataRevision
      })
      expect(screen.queryByRole('alert')).toBeNull()
    }
  )

  it.each(['empty', 'older'] as const)(
    'does not replace a completed manual check with a saved read that returns later: %s',
    async (kind) => {
      publicationCheck.mockResolvedValue(result(kind === 'empty' ? {} : { snapshot }))
      render(<LiteraturePublicationCheck item={item} />)
      await screen.findByText(
        kind === 'empty'
          ? 'No saved publication check. Run a check to look for related notices.'
          : 'Retraction notice'
      )
      const check = deferred<LiteraturePublicationCheckResult>()
      publicationCheck.mockReturnValueOnce(check.promise)
      fireEvent.click(checkButton())
      const read = deferred<LiteraturePublicationCheckResult>()
      publicationCheck.mockReturnValueOnce(read.promise)
      await act(async () => recovered?.())
      await waitFor(() => expect(publicationCheck).toHaveBeenCalledTimes(3))
      await act(async () =>
        check.resolve(
          result({ snapshot: { ...snapshot, checkedAt: snapshot.checkedAt + 1, notices: [] } })
        )
      )
      expect(screen.queryByText('No related notices found.')).toBeTruthy()
      await act(async () => read.resolve(result(kind === 'empty' ? {} : { snapshot })))
      expect(screen.queryByText('No related notices found.')).toBeTruthy()
      expect(screen.queryByText('Retraction notice')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(checkButton()).toHaveProperty('disabled', false)
    }
  )

  it.each([
    ['reference-changed', 'This reference changed. Reload its details before checking again.'],
    ['doi-required', 'Add one valid DOI to check this reference.']
  ] as const)(
    'invalidates an active manual check when a saved read reports %s',
    async (issue, message) => {
      publicationCheck.mockResolvedValue(result({ snapshot }))
      render(<LiteraturePublicationCheck item={item} />)
      await screen.findByText('Retraction notice')
      const pending = deferred<LiteraturePublicationCheckResult>()
      publicationCheck.mockReturnValueOnce(pending.promise)
      fireEvent.click(checkButton())
      publicationCheck.mockResolvedValue(result({ issue }))
      await act(async () => changed?.({ revision: 2, itemIds: [item.id] }))
      await screen.findByText(message)
      await act(async () => pending.resolve(result({ snapshot })))
      expect(screen.queryByText(message)).toBeTruthy()
      expect(screen.queryByText('Retraction notice')).toBeNull()
      expect(checkButton()).toHaveProperty('disabled', false)
    }
  )

  it.each(['returned', 'rejected'] as const)(
    'reports a later saved-read failure after a completed successful check: %s',
    async (failure) => {
      publicationCheck.mockResolvedValue(result({ snapshot }))
      render(<LiteraturePublicationCheck item={item} />)
      await screen.findByText('Retraction notice')
      publicationCheck.mockResolvedValueOnce(
        result({ snapshot: { ...snapshot, checkedAt: snapshot.checkedAt + 1, notices: [] } })
      )
      fireEvent.click(checkButton())
      await screen.findByText('No related notices found.')
      expect(checkButton()).toHaveProperty('disabled', false)
      if (failure === 'returned')
        publicationCheck.mockResolvedValueOnce(result({ issue: 'unavailable' }))
      else publicationCheck.mockRejectedValueOnce(new Error('saved-read failed'))
      await act(async () => recovered?.())
      expect(screen.queryByRole('alert')).not.toBeNull()
      expect(screen.queryByText('No related notices found.')).toBeTruthy()
      publicationCheck.mockResolvedValue(
        result({ snapshot: { ...snapshot, checkedAt: snapshot.checkedAt + 2 } })
      )
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await screen.findByText('Retraction notice')
      expect(publicationCheck).toHaveBeenLastCalledWith({
        mode: 'get',
        itemId: item.id,
        expectedMetadataRevision: item.metadataRevision
      })
    }
  )

  it('keeps a newer saved observation when an earlier manual check response arrives later', async () => {
    publicationCheck.mockResolvedValue(result({ snapshot }))
    render(<LiteraturePublicationCheck item={item} />)
    await screen.findByText('Retraction notice')
    const pending = deferred<LiteraturePublicationCheckResult>()
    publicationCheck.mockReturnValueOnce(pending.promise)
    fireEvent.click(checkButton())
    const newer = {
      ...snapshot,
      checkedAt: snapshot.checkedAt + 2,
      notices: [{ doi: '10.1234/new-notice', type: 'correction', source: 'publisher' as const }]
    }
    publicationCheck.mockResolvedValue(result({ snapshot: newer }))
    await act(async () => changed?.({ revision: 2, itemIds: [item.id] }))
    await screen.findByText('Correction notice')
    await act(async () =>
      pending.resolve(
        result({ snapshot: { ...snapshot, checkedAt: snapshot.checkedAt + 1, notices: [] } })
      )
    )
    expect(screen.queryByText('Correction notice')).toBeTruthy()
    expect(screen.queryByText('No related notices found.')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(checkButton()).toHaveProperty('disabled', false)
  })

  it('cleans up subscriptions and discards pending results after unmount', async () => {
    const pending = deferred<LiteraturePublicationCheckResult>()
    publicationCheck.mockReturnValue(pending.promise)
    const view = render(<LiteraturePublicationCheck item={item} />)
    await waitFor(() => expect(publicationCheck).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(changed).toBeUndefined()
    expect(recovered).toBeUndefined()
    await act(async () => pending.resolve(result({ snapshot })))
    expect(view.container.textContent).toBe('')
  })

  it('does not request results for deleted or merged items', async () => {
    const view = render(<LiteraturePublicationCheck item={{ ...item, deletedAt: 2 }} />)
    expect(checkButton()).toHaveProperty('disabled', true)
    view.rerender(<LiteraturePublicationCheck item={{ ...item, mergedIntoItemId: 'other' }} />)
    expect(checkButton()).toHaveProperty('disabled', true)
    expect(publicationCheck).not.toHaveBeenCalled()
  })
})
