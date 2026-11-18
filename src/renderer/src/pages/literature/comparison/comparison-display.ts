export { comparisonCellView } from '../../../../../shared/literature-comparison'

export type ComparisonEvidenceTarget =
  | { kind: 'reference'; itemId: string }
  | { kind: 'document'; itemId: string; attachmentVersionId: string; page?: number }

export function comparisonStorageMessage(
  issue: string | undefined,
  t: (key: string) => string
): string | undefined {
  if (issue?.includes('comparison-storage-limit') || issue?.includes('comparison-table-limit'))
    return t('Comparison storage is full. Export a table before deleting it to free space.')
  if (issue?.includes('comparison-storage-unavailable') || issue === 'checkpoint-failed')
    return t('File storage is unavailable. Check the storage location and try again.')
  return undefined
}
