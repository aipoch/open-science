// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ArtifactLiteratureDetailDialog } from './ArtifactLiteratureDetailDialog'
import { literatureItemInputSchema } from '../../../../shared/literature'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('shows imported reference metadata without querying or warning about the local Library', () => {
  const get = vi.fn()
  vi.stubGlobal('api', { literature: { get } })
  render(
    <ArtifactLiteratureDetailDialog
      snapshotOnly
      reference={{
        itemId: 'imported-item',
        metadataRevision: 1,
        item: literatureItemInputSchema.parse({
          itemType: 'journalArticle',
          title: 'Saved paper',
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
  expect(get).not.toHaveBeenCalled()
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
