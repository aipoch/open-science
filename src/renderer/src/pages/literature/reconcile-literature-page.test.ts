import { expect, it } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemView } from '../../../../shared/literature'
import { reconcileLiteraturePage } from './reconcile-literature-page'

const entries: LiteratureItemView[] = Array.from({ length: 100 }, (_, i) => ({
  id: String(i),
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: `Reference ${i}`,
    abstract: 'Evidence. '.repeat(200)
  }),
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  smartDecision: { id: String(i), title: `Reference ${i}`, verdict: 'match' }
}))

it('shares cloned visible rows in a 1,029-reference result and retains fresh counts/order', () => {
  const before = { entries, totalCount: 1029, nextOffset: 100 }
  const unchanged = reconcileLiteraturePage(before, structuredClone(before))
  expect(unchanged.entries).toBe(entries)
  const next = structuredClone(before)
  next.entries[3].smartDecision!.override = 'exclude'
  next.entries.reverse()
  next.totalCount = 1028
  const after = reconcileLiteraturePage(before, next)
  expect(after.totalCount).toBe(1028)
  expect(
    after.entries.filter((entry) => entries.some((original) => original === entry))
  ).toHaveLength(99)
  const changed = after.entries.find(
    (entry) => 'id' in entry && entry.id === '3'
  )! as LiteratureItemView
  expect(changed.item).toBe(entries[3].item)
  expect(changed.smartDecision?.override).toBe('exclude')
  const removed = reconcileLiteraturePage(after, {
    entries: next.entries.slice(1),
    totalCount: 1027
  })
  expect(removed.entries).toHaveLength(99)
  expect(removed.nextOffset).toBeUndefined()
})

it('detects nested changes and removed fields even when metadata revision is unchanged', () => {
  const before = { entries: [entries[0]], totalCount: 1 }
  const next = structuredClone(before)
  delete next.entries[0].smartDecision
  next.entries[0].collectionIds.push('collection-2')
  const after = reconcileLiteraturePage(before, next)
  expect(after.entries[0]).not.toBe(before.entries[0])
  expect(after.entries[0]).toEqual(next.entries[0])
})
