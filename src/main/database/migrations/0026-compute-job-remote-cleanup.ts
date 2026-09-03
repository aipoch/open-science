const computeJobRemoteCleanupMigration = {
  id: '0026_compute_job_remote_cleanup',
  statements: [
    `ALTER TABLE "ComputeJob" ADD COLUMN "remoteCleanupDisposition" TEXT NOT NULL DEFAULT 'pending'`
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'ComputeJob',
      column: 'remoteCleanupDisposition'
    }
  ] as const
}

export { computeJobRemoteCleanupMigration }
