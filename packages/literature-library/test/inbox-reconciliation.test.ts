import { createLiteratureClient, type LibraryClientApi } from '../src/client/index.js'
import { afterEach, expect, it, vi } from 'vitest'
let readMatchingCandidateIds: ReturnType<typeof createLiteratureClient>['readMatchingCandidateIds']

afterEach(() => vi.restoreAllMocks())
const candidate = (id: string): { id: string; candidate: object; state: string } => ({
  id,
  candidate: {},
  state: 'dismissed'
})
function searchMock(): ReturnType<typeof vi.fn> {
  const search = vi.fn()
  readMatchingCandidateIds = createLiteratureClient({
    search
  } as unknown as LibraryClientApi).readMatchingCandidateIds
  return search
}

it('reconciles only requested candidates against current authority across transport pages', async () => {
  const search = searchMock()
    .mockResolvedValueOnce({
      entries: [candidate('unrelated'), { id: 'accepted', item: {} }],
      nextOffset: 2
    })
    .mockResolvedValueOnce({ entries: [candidate('dismissed')], nextOffset: undefined })
  expect(await readMatchingCandidateIds(new Set(['dismissed', 'accepted']), 'dismissed')).toEqual(
    new Set(['dismissed'])
  )
  expect(search).toHaveBeenNthCalledWith(2, {
    scope: 'inbox',
    inboxState: 'dismissed',
    limit: 100,
    offset: 2
  })
})

it('stops when all requested candidates are found', async () => {
  const search = searchMock().mockResolvedValue({ entries: [candidate('a')], nextOffset: 1 })
  expect(await readMatchingCandidateIds(new Set(['a']), 'pending')).toEqual(new Set(['a']))
  expect(search).toHaveBeenCalledTimes(1)
})

it('rejects a nonadvancing cursor instead of hanging Undo reconciliation', async () => {
  searchMock().mockResolvedValue({ entries: [], nextOffset: 0 })
  await expect(readMatchingCandidateIds(new Set(['a']), 'dismissed')).rejects.toThrow(
    'did not advance'
  )
})

it('does not treat an abandoned scan as proof that a candidate disappeared', async () => {
  const search = searchMock().mockResolvedValue({ entries: [], nextOffset: 1 })
  await expect(
    readMatchingCandidateIds(new Set(['a']), 'dismissed', () => search.mock.calls.length === 0)
  ).rejects.toThrow('cancelled')
  expect(search).toHaveBeenCalledTimes(1)
})
