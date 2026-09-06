/* Immutable 0031 migration snapshot. Do not regenerate after release. */
const sessionRunCoverageMigration = {
  id: '0031_session_run_coverage',
  statements: [`ALTER TABLE "SessionRun" ADD COLUMN "reportedAtMs" BIGINT`] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'SessionRun', column: 'reportedAtMs' }
  ] as const
}

export { sessionRunCoverageMigration }
