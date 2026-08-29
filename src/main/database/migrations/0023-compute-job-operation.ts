const kindExpression = `"kind" = 'cancel'`
const phaseExpression = `"phase" IN ('active', 'settled')`
const lifecycleExpression = `("phase" = 'active' AND "outcome" IS NULL AND "settledAt" IS NULL) OR ("phase" = 'settled' AND "outcome" IN ('fulfilled', 'superseded') AND "settledAt" IS NOT NULL)`
const claimExpression = `("claimToken" IS NULL AND "claimExpiresAt" IS NULL) OR ("phase" = 'active' AND "claimToken" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)`
const settledImplementationExpression = `"phase" = 'active' OR ("eligibleAt" IS NULL AND "claimToken" IS NULL AND "claimExpiresAt" IS NULL)`
const revisionExpression = `"revision" >= 1`
const attemptCountExpression = `"attemptCount" >= 0`

const operationDdl = `CREATE TABLE IF NOT EXISTS "ComputeJobOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'active',
    "outcome" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleAt" DATETIME,
    "claimToken" TEXT,
    "claimExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ComputeJobOperation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ComputeJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ComputeJobOperation_kind_check" CHECK (${kindExpression}),
    CONSTRAINT "ComputeJobOperation_phase_check" CHECK (${phaseExpression}),
    CONSTRAINT "ComputeJobOperation_lifecycle_check" CHECK (${lifecycleExpression}),
    CONSTRAINT "ComputeJobOperation_claim_check" CHECK (${claimExpression}),
    CONSTRAINT "ComputeJobOperation_settled_implementation_check" CHECK (${settledImplementationExpression}),
    CONSTRAINT "ComputeJobOperation_revision_check" CHECK (${revisionExpression}),
    CONSTRAINT "ComputeJobOperation_attemptCount_check" CHECK (${attemptCountExpression})
)`

const indexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeJobOperation_jobId_kind_key" ON "ComputeJobOperation"("jobId", "kind")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJobOperation_kind_phase_eligibleAt_createdAt_idx" ON "ComputeJobOperation"("kind", "phase", "eligibleAt", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ComputeJobOperation_kind_phase_claimExpiresAt_idx" ON "ComputeJobOperation"("kind", "phase", "claimExpiresAt")`
] as const

const computeJobOperationMigration = {
  id: '0023_compute_job_operation',
  statements: [operationDdl, ...indexes] as const,
  operations: [
    {
      kind: 'rebuild-table-set',
      version: 1,
      tables: [
        {
          tableName: 'ComputeJobOperation',
          canonicalTableDdl: operationDdl,
          columns: [
            'id',
            'jobId',
            'kind',
            'phase',
            'outcome',
            'revision',
            'attemptCount',
            'eligibleAt',
            'claimToken',
            'claimExpiresAt',
            'createdAt',
            'settledAt',
            'updatedAt'
          ]
        }
      ],
      dropOrder: ['ComputeJobOperation'],
      indexes
    }
  ] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'ComputeJobOperation' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ComputeJobOperation',
      column: 'jobId',
      referencedTable: 'ComputeJob',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'ComputeJobOperation',
          constraints: [
            { name: 'ComputeJobOperation_kind_check', expression: kindExpression },
            { name: 'ComputeJobOperation_phase_check', expression: phaseExpression },
            { name: 'ComputeJobOperation_lifecycle_check', expression: lifecycleExpression },
            { name: 'ComputeJobOperation_claim_check', expression: claimExpression },
            {
              name: 'ComputeJobOperation_settled_implementation_check',
              expression: settledImplementationExpression
            },
            { name: 'ComputeJobOperation_revision_check', expression: revisionExpression },
            {
              name: 'ComputeJobOperation_attemptCount_check',
              expression: attemptCountExpression
            }
          ]
        }
      ]
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: indexes.map((sql) => ({
        name: sql.match(/"(ComputeJobOperation_[^"]+)"/)![1],
        sql
      }))
    }
  ] as const
}

export { computeJobOperationMigration }
