const computeJobFileEvidenceMigration = {
  id: '0024_compute_job_file_evidence',
  statements: [
    `ALTER TABLE "ComputeJob" ADD COLUMN "producerRunId" TEXT`,
    `ALTER TABLE "ComputeJob" ADD COLUMN "fileEvidence" TEXT`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'producerRunId' },
    { kind: 'column-exists', version: 1, table: 'ComputeJob', column: 'fileEvidence' }
  ] as const
}

export { computeJobFileEvidenceMigration }
