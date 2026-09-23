// Additive operation diagnostics; existing jobs and operation claims remain intact.
const computeCancellationFeedbackMigration = {
  id: '0045_compute_cancellation_feedback',
  statements: [
    'ALTER TABLE "ComputeJobOperation" ADD COLUMN "failureCode" TEXT',
    'ALTER TABLE "ComputeJobOperation" ADD COLUMN "requestedAt" DATETIME',
    'ALTER TABLE "ComputeJobOperation" ADD COLUMN "forceRequested" BOOLEAN NOT NULL DEFAULT false'
  ],
  operations: [],
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ComputeJobOperation', column: 'failureCode' },
    { kind: 'column-exists', version: 1, table: 'ComputeJobOperation', column: 'requestedAt' },
    { kind: 'column-exists', version: 1, table: 'ComputeJobOperation', column: 'forceRequested' }
  ]
} as const

export { computeCancellationFeedbackMigration }
