import {
  LibraryTransaction,
  normalizedIdentifiers,
  mergeLiteratureDuplicates
} from '../src/index.js'
import { literatureItemInputSchema } from '../src/contracts.js'
import { expect, it } from 'vitest'
import { memoryLibrary as createMemoryLibrary } from './memory-store.js'
const memoryLibrary = (): ReturnType<typeof createMemoryLibrary> =>
  createMemoryLibrary({ LibraryTransaction, normalizedIdentifiers, literatureItemInputSchema })
const paper = literatureItemInputSchema.parse({
  itemType: 'journalArticle',
  title: 'Paper',
  identifiers: [{ scheme: 'doi', value: '10.1234/same' }]
})
it('previews without writes, rejects changed snapshots, and counts only committed groups', async () => {
  const db = memoryLibrary(),
    ids = (await db.run((tx) => tx.importItems([paper, paper], undefined, 'separate'))).itemIds
  const preview = await mergeLiteratureDuplicates(
    { kind: 'merge-duplicates', mode: 'preview', strategy: 'oldest', groups: [ids] },
    (_ids, work) => db.run(work)
  )
  expect(preview.batch).toMatchObject({ eligible: 1, reduced: 1, succeeded: 0 })
  expect(db.state.items.size).toBe(2)
  db.state.items.get(ids[0])!.metadataRevision++
  const changed = await mergeLiteratureDuplicates(
    {
      kind: 'merge-duplicates',
      mode: 'commit',
      strategy: 'oldest',
      groups: [ids],
      expectedItems: preview.batch!.groups!.flatMap((g) => g.items)
    },
    (_ids, work) => db.run(work)
  )
  expect(changed.batch?.details?.[0].reason).toBe('changed')
  expect(changed.batch?.succeeded).toBe(0)
  const failed = await mergeLiteratureDuplicates(
    { kind: 'merge-duplicates', mode: 'commit', groups: [ids] },
    async (_ids, work) =>
      db.run(async (tx) => {
        await work(tx)
        throw Error('commit failed')
      })
  )
  expect(failed.batch).toMatchObject({ failed: 1, succeeded: 0, groups: [] })
  expect(db.state.items.get(ids[1])?.mergedIntoItemId).toBeUndefined()
})
it('guards overlapping and oversized groups before running any transaction', async () => {
  let calls = 0
  const result = await mergeLiteratureDuplicates(
    {
      kind: 'merge-duplicates',
      mode: 'preview',
      groups: [['a', 'a'], Array.from({ length: 21 }, (_, i) => String(i))]
    },
    async () => {
      calls++
      return undefined
    }
  )
  expect(calls).toBe(0)
  expect(result.batch).toMatchObject({ skipped: 2, review: 2 })
})
