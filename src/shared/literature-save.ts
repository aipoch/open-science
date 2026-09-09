import type { LiteratureCatalogReceipt } from './literature'

export type LiteratureLibrarySaveResult = Readonly<{
  // Receipts correspond to the completed input prefix, including reused records.
  results: readonly LiteratureCatalogReceipt[]
  failure?: Readonly<{ inputIndex: number; code: string; message: string }>
  cancelled?: boolean
}>

export const summarizeLiteratureSaveReceipts = (
  results: readonly LiteratureCatalogReceipt[]
): {
  pendingCount: number
  existingItemIds: string[]
  duplicateCount: number
  otherCount: number
} => {
  const unique = [
    ...new Map(results.map((receipt) => [`${receipt.kind}:${receipt.id}`, receipt])).values()
  ]
  const pendingCount = unique.filter(
    ({ kind, state }) => kind === 'candidate' && state === 'pending'
  ).length
  const existingItemIds = unique
    .filter(({ kind, state }) => kind === 'item' && state === 'present')
    .map(({ id }) => id)
  return {
    pendingCount,
    existingItemIds,
    duplicateCount: results.length - unique.length,
    otherCount: unique.length - pendingCount - existingItemIds.length
  }
}
