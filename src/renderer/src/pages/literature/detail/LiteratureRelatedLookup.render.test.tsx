// @vitest-environment jsdom
import { FileTypeIcon } from '@/pages/workspace/file-type-icon'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type {
  LiteratureRelatedRecord,
  LiteratureRelatedRequest,
  LiteratureRelatedResult
} from '@aipoch/literature-discovery/contracts'
import { LiteratureRelatedLookup } from './LiteratureRelatedLookup'

const { render } = createLiteratureTestRenderer({
  FileTypeIcon,
  get api() {
    return window.api
  }
})
const related = vi.fn<(request: LiteratureRelatedRequest) => Promise<LiteratureRelatedResult>>()
const transact = vi.fn()
const item: LiteratureItemView = {
  id: 'local',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Seed' })
}
const record = (letter: string): LiteratureRelatedRecord => ({
  paperId: letter.repeat(40),
  item: literatureItemInputSchema.parse({
    itemType: 'document',
    title: `Paper ${letter}`,
    url: `https://www.semanticscholar.org/paper/${letter.repeat(40)}`
  })
})
const result = (extra: Partial<LiteratureRelatedResult> = {}): LiteratureRelatedResult => ({
  itemId: 'local',
  metadataRevision: 1,
  direction: 'references',
  state: 'ready',
  seed: record('a'),
  records: [record('b'), record('c')],
  resolutionToken: '00000000-0000-4000-8000-000000000000',
  ...extra
})
beforeEach(() => {
  related
    .mockReset()
    .mockImplementation(async (request) => result({ direction: request.direction }))
  transact.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { related, transact } }
  })
})
afterEach(cleanup)
it('starts from one paper, switches relationship direction and stages only explicit selections', async () => {
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  expect(transact).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Cited by' }))
  await waitFor(() =>
    expect(related).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: 'local', direction: 'citations', offset: 0 })
    )
  )
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  transact.mockResolvedValue({ kind: 'candidate', id: 'candidate', state: 'pending' })
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact).toHaveBeenCalledTimes(1)
  expect(transact).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'stage-candidate',
      candidate: expect.objectContaining({
        source: expect.objectContaining({
          provider: 'semantic-scholar',
          externalId: 'b'.repeat(40)
        }),
        origin: { kind: 'manual-discovery' }
      })
    })
  )
})
it('confirms the matched seed before loading references', async () => {
  related.mockResolvedValueOnce(result({ state: 'match-required', records: [] }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Is this the same paper?')
  expect(related).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Same paper, show relationships' }))
  await screen.findByText('Paper b')
  expect(related).toHaveBeenLastCalledWith(
    expect.objectContaining({ resolutionToken: result().resolutionToken })
  )
})
it('reports duplicates, dismissed candidates and partial failures without auto-restoring', async () => {
  related.mockResolvedValue(result({ records: [record('b'), record('c'), record('d')] }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  for (const label of ['b', 'c', 'd'])
    fireEvent.click(screen.getByRole('checkbox', { name: `Select Paper ${label}` }))
  transact
    .mockResolvedValueOnce({ kind: 'item', id: 'saved', state: 'present' })
    .mockResolvedValueOnce({ kind: 'candidate', id: 'dismissed', state: 'dismissed' })
    .mockRejectedValueOnce(new Error('failed'))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('Could not add this reference. Try again.')
  expect(screen.getByText('Already in Library')).toBeTruthy()
  expect(screen.getByText('Previously dismissed; review it in Inbox.')).toBeTruthy()
  expect(transact.mock.calls.every(([command]) => command.kind === 'stage-candidate')).toBe(true)
  transact.mockResolvedValueOnce({ kind: 'candidate', id: 'retry', state: 'pending' })
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact).toHaveBeenCalledTimes(4)
})
it('ignores stale requests after navigating away and paginates explicitly', async () => {
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ records: [record('d')] }))
  const view = render(
    <LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />
  )
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByText('Paper d')
  expect(related).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 }))
  let resolve!: (value: LiteratureRelatedResult) => void
  related.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
  view.unmount()
  resolve(result())
  expect(transact).not.toHaveBeenCalled()
})
