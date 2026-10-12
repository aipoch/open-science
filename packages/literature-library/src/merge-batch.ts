import type { LiteratureCatalogCommand, LiteratureCatalogReceipt } from './contracts.js'
import { planLiteratureMerge } from './duplicate-metadata.js'
import type { LibraryTransaction } from './library.js'
export type MergeGroupResult = NonNullable<
  NonNullable<LiteratureCatalogReceipt['batch']>['groups']
>[number] & { tagsChanged: boolean }
/** Run each group in its own atomic transaction. Resolve only after committing; reject on rollback. */
export type RunMergeGroup = (
  ids: string[],
  work: (domain: LibraryTransaction) => Promise<MergeGroupResult | undefined>
) => Promise<MergeGroupResult | undefined>
export async function mergeLiteratureDuplicates(
  command: Extract<LiteratureCatalogCommand, { kind: 'merge-duplicates' }>,
  runGroup: RunMergeGroup
): Promise<LiteratureCatalogReceipt> {
  const strategy = command.strategy ?? 'conflict-free'
  if (strategy !== 'conflict-free' && command.mode === 'commit' && !command.expectedItems) {
    throw new Error('Preview the selected merge strategy before committing.')
  }
  const batch: NonNullable<LiteratureCatalogReceipt['batch']> = {
    eligible: 0,
    reduced: 0,
    review: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    groups: [],
    details: []
  }
  const seen = new Set<string>()
  for (const [groupIndex, ids] of command.groups.entries()) {
    const detail: NonNullable<typeof batch.details>[number] = { groupIndex, status: 'skipped' }
    batch.details!.push(detail)
    if (ids.length > 20 || ids.some((id) => seen.has(id)) || new Set(ids).size !== ids.length) {
      detail.reason = ids.length > 20 ? 'too-large' : 'overlapping'
      batch.skipped += 1
      batch.review += 1
      continue
    }
    ids.forEach((id) => seen.add(id))
    try {
      const merged = await runGroup(ids, async (domain) => {
        let tagsChanged = false
        const views = await domain.mergeViews(ids)
        if (views.length !== ids.length) {
          detail.reason = 'unavailable'
          return undefined
        }
        detail.title = views[0]?.item.title
        if (
          command.mode === 'commit' &&
          command.expectedItems &&
          views.some(
            (view) =>
              !command.expectedItems!.some(
                (expected) =>
                  expected.id === view.id &&
                  expected.metadataRevision === view.metadataRevision &&
                  expected.updatedAt === view.updatedAt
              )
          )
        ) {
          detail.reason = 'changed'
          return undefined
        }
        const plan = planLiteratureMerge(views, strategy)
        if (!plan) {
          detail.reason =
            strategy === 'conflict-free' && planLiteratureMerge(views, 'oldest')
              ? 'conflicts'
              : 'identity'
          return undefined
        }
        const items = views.map(({ id, metadataRevision, updatedAt }) => ({
          id,
          metadataRevision,
          updatedAt
        }))
        if (command.mode === 'commit') {
          const result = await domain.mergeItems({
            kind: 'merge-items',
            survivorId: plan.survivor.id,
            duplicateIds: views
              .filter((view) => view.id !== plan.survivor.id)
              .map((view) => view.id),
            expectedMetadataRevision: plan.survivor.metadataRevision,
            expectedItems: items,
            item: plan.item
          })
          tagsChanged = result.tagsChanged
        }
        return {
          survivorId: plan.survivor.id,
          survivorTitle: plan.survivor.item.title,
          conflicts: plan.conflicts,
          items,
          tagsChanged
        }
      })
      if (merged) {
        // Publish the result only after the transaction commits successfully.
        const group = {
          survivorId: merged.survivorId,
          survivorTitle: merged.survivorTitle,
          conflicts: merged.conflicts,
          items: merged.items
        }
        batch.groups!.push(group)
        detail.status = command.mode === 'commit' ? 'merged' : 'ready'
        batch.eligible += 1
        batch.reduced += ids.length - 1
        if (command.mode === 'commit') batch.succeeded += 1
      } else {
        batch.review += 1
        batch.skipped += 1
      }
    } catch {
      detail.status = 'failed'
      detail.reason = 'failed'
      batch.failed += 1
    }
  }
  return { kind: 'item', id: command.groups[0][0], batch }
}
