/* Immutable migration snapshot. */
const contentVerificationObservationMigration = {
  id: '0036_content_verification_observation',
  statements: [
    `ALTER TABLE "ContentBlob" ADD COLUMN "lastVerificationFailure" TEXT`,
    `ALTER TABLE "ContentBlob" ADD COLUMN "lastVerificationAttemptAt" DATETIME`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ContentBlob', column: 'lastVerificationFailure' },
    { kind: 'column-exists', version: 1, table: 'ContentBlob', column: 'lastVerificationAttemptAt' }
  ] as const
}
export { contentVerificationObservationMigration }
