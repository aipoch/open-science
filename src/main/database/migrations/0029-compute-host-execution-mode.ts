/* Immutable 0029 migration snapshot. Do not regenerate after release. */

const computeHostExecutionModeMigration = {
  id: '0029_compute_host_execution_mode',
  statements: [
    `ALTER TABLE "ComputeHost" ADD COLUMN "executionMode" TEXT NOT NULL DEFAULT 'direct_ssh'`,
    `ALTER TABLE "ComputeJob" ADD COLUMN "executionMode" TEXT NOT NULL DEFAULT 'direct_ssh'`
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'ComputeHost',
      column: 'executionMode'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'ComputeJob',
      column: 'executionMode'
    }
  ] as const
}

export { computeHostExecutionModeMigration }
