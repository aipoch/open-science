// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { ArtifactLiteratureDetailDialog } from './ArtifactLiteratureDetailDialog'
import { literatureItemInputSchema } from '../../../../shared/literature'
import type { JournalRequest } from '../../../../shared/journal-attributes'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('shows imported reference metadata without querying or warning about the local Library', async () => {
  const get = vi.fn()
  const journals = vi.fn().mockResolvedValue({ datasets: [], matches: [] })
  vi.stubGlobal('api', { literature: { get, journals } })
  render(
    <ArtifactLiteratureDetailDialog
      snapshotOnly
      reference={{
        itemId: 'imported-item',
        metadataRevision: 1,
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Saved paper',
          containerTitle: 'Saved fictional journal',
          abstract: 'Saved abstract'
        })
      }}
      onOpenChange={() => {}}
    />
  )
  expect(screen.getByText('Saved paper')).toBeTruthy()
  expect(screen.getByText('Saved abstract')).toBeTruthy()
  expect(screen.getByText('Saved reference metadata from the Session package.')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => {})
  expect(get).not.toHaveBeenCalled()
  expect(journals).not.toHaveBeenCalled()
})

it('uses the live reference identity for confirmed journal attributes only in live metadata', async () => {
  const reference = {
    itemId: 'manually-confirmed-paper',
    metadataRevision: 1,
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Saved fictional paper',
      containerTitle: 'Unknown fictional journal'
    })
  }
  const get = vi.fn().mockResolvedValue({
    id: reference.itemId,
    metadataRevision: 2,
    item: { ...reference.item, title: 'Current fictional paper' },
    attachments: []
  })
  const journals = vi.fn(async (request: JournalRequest) =>
    request.action === 'resolve'
      ? {
          matches: request.identities.map((identity) => ({
            status: identity.itemId === reference.itemId ? 'matched' : 'missing',
            attributes:
              identity.itemId === reference.itemId
                ? [
                    {
                      key: 'fictional:band',
                      label: 'Editorial band',
                      kind: 'singleSelect',
                      value: 'Confirmed band',
                      source: 'Fictional source',
                      year: 2031,
                      colors: {}
                    }
                  ]
                : []
          }))
        }
      : { datasets: [] }
  )
  vi.stubGlobal('api', { literature: { get, journals } })
  const { rerender } = render(
    <ArtifactLiteratureDetailDialog liveMetadata reference={reference} onOpenChange={() => {}} />
  )
  expect(await screen.findByText('Confirmed band')).toBeTruthy()
  expect(journals).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'resolve',
      identities: [expect.objectContaining({ itemId: reference.itemId })]
    })
  )
  rerender(<ArtifactLiteratureDetailDialog reference={reference} onOpenChange={() => {}} />)
  expect(screen.queryByText('Confirmed band')).toBeNull()
  expect(screen.getByRole('heading', { name: 'Saved fictional paper' })).toBeTruthy()
})

it('shows current metadata only when explicitly requested by Library', async () => {
  const reference = {
    itemId: 'paper',
    metadataRevision: 1,
    item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Snapshot title' })
  }
  const get = vi.fn().mockResolvedValue({
    id: 'paper',
    metadataRevision: 2,
    item: { ...reference.item, title: 'Updated title' },
    attachments: []
  })
  vi.stubGlobal('api', { literature: { get } })
  const { rerender } = render(
    <ArtifactLiteratureDetailDialog reference={reference} onOpenChange={() => {}} />
  )
  await waitFor(() => expect(get).toHaveBeenCalled())
  expect(screen.getByRole('heading', { name: 'Snapshot title' })).toBeTruthy()
  rerender(
    <ArtifactLiteratureDetailDialog liveMetadata reference={reference} onOpenChange={() => {}} />
  )
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Updated title' })).toBeTruthy())
  expect(screen.getByText('Current Library entry.')).toBeTruthy()
})
