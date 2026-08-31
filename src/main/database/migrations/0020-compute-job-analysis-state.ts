const computeJobAnalysisStateMigration = {
  id: '0020_compute_job_analysis_state',
  statements: [
    `ALTER TABLE "ComputeJob" ADD COLUMN "analysisMessageId" TEXT`,
    `ALTER TABLE "ComputeJob" ADD COLUMN "analysisUpdatedAt" DATETIME`,
    `ALTER TABLE "ComputeJob" ADD COLUMN "analysisState" TEXT`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'analysisMessageId' },
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'analysisUpdatedAt' },
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'analysisState' }
  ] as const
}

export { computeJobAnalysisStateMigration }
