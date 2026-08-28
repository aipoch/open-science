const computeJobSensitiveDataEncryptionMigration = {
  id: '0016_compute_job_sensitive_data_encryption',
  statements: [`ALTER TABLE "ComputeJob" ADD COLUMN "sensitiveDataEncrypted" BOOLEAN`],
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'ComputeJob',
      column: 'sensitiveDataEncrypted'
    }
  ] as const
}

export { computeJobSensitiveDataEncryptionMigration }
