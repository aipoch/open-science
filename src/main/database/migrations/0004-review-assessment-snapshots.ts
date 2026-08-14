/* Immutable 0004 migration snapshot. Do not regenerate after release. */

// Tracked re-review checks remain dispositions on their original Finding identity. This nullable
// snapshot preserves the exact submitted Review Check content for new writes while legacy rows remain
// readable with an explicit unavailable-details projection.
const reviewAssessmentSnapshotsMigration = {
  id: '0004_review_assessment_snapshots',
  statements: [
    `ALTER TABLE "ReviewFindingDisposition" ADD COLUMN "assessmentSnapshot" TEXT`
  ] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'ReviewFindingDisposition',
      column: 'assessmentSnapshot'
    }
  ] as const
}

export { reviewAssessmentSnapshotsMigration }
