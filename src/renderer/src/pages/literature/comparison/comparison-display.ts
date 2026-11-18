export { comparisonCellView } from '../../../../../shared/literature-comparison'

export type ComparisonEvidenceTarget =
  | { kind: 'reference'; itemId: string }
  | { kind: 'document'; itemId: string; attachmentVersionId: string; page?: number }

export function comparisonStorageMessage(
  issue: string | undefined,
  t: (key: string) => string
): string | undefined {
  if (issue?.includes('comparison-storage-limit') || issue?.includes('comparison-table-limit'))
    return t(
      'Comparison storage is full. Back up literature/comparisons-v1.json from your data folder before deleting a table.'
    )
  if (issue?.includes('comparison-storage-unavailable'))
    return t(
      'Check literature/comparisons-v1.json in your data folder. Restore a valid backup if needed, then retry.'
    )
  if (issue === 'checkpoint-failed')
    return t('File storage is unavailable. Check the storage location and try again.')
  return undefined
}
