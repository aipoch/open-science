const sessionUsageAttributionMigration = {
  id: '0019_session_usage_attribution',
  statements: [
    `ALTER TABLE "SessionTurnUsage" ADD COLUMN "frameworkId" TEXT`,
    `ALTER TABLE "SessionTurnUsage" ADD COLUMN "providerId" TEXT`,
    `ALTER TABLE "SessionTurnUsage" ADD COLUMN "model" TEXT`,
    `ALTER TABLE "SessionModelCallUsage" ADD COLUMN "providerId" TEXT`,
    `ALTER TABLE "SessionAuxiliaryTurnUsage" ADD COLUMN "providerId" TEXT`
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'SessionTurnUsage',
      column: 'frameworkId'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'SessionTurnUsage',
      column: 'providerId'
    },
    { kind: 'column-exists', version: 1, table: 'SessionTurnUsage', column: 'model' },
    {
      kind: 'column-exists',
      version: 1,
      table: 'SessionModelCallUsage',
      column: 'providerId'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'SessionAuxiliaryTurnUsage',
      column: 'providerId'
    }
  ] as const
}

export { sessionUsageAttributionMigration }
