export { comparisonCellView } from '../../../../../shared/literature-comparison'

export type ComparisonEvidenceTarget =
  | { kind: 'reference'; itemId: string }
  | { kind: 'document'; itemId: string; attachmentVersionId: string; page?: number }
