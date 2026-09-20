const backgroundResultDeliveryChecks = [
  {
    name: 'BackgroundResultDelivery_sourceKind_check',
    expression: `"sourceKind" IN ('local-run', 'compute-job')`
  },
  {
    name: 'BackgroundResultDelivery_state_check',
    expression: `"state" IN ('waiting-result', 'pending', 'claimed', 'dispatching', 'consumed', 'needs-attention')`
  },
  {
    name: 'BackgroundResultDelivery_identity_check',
    expression: `length(trim("id")) > 0 AND length(trim("sourceId")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sessionId")) > 0`
  },
  {
    name: 'BackgroundResultDelivery_attemptCount_check',
    expression: `"attemptCount" >= 0`
  },
  {
    name: 'BackgroundResultDelivery_claimLifecycle_check',
    expression: `(("state" IN ('claimed', 'dispatching') AND "claimToken" IS NOT NULL AND length(trim("claimToken")) > 0 AND "claimExpiresAt" IS NOT NULL) OR ("state" NOT IN ('claimed', 'dispatching') AND "claimToken" IS NULL AND "claimExpiresAt" IS NULL))`
  },
  {
    name: 'BackgroundResultDelivery_continuation_check',
    expression: `("continuationMessageId" IS NULL OR length(trim("continuationMessageId")) > 0) AND ("state" <> 'dispatching' OR "continuationMessageId" IS NOT NULL) AND ("state" <> 'waiting-result' OR "continuationMessageId" IS NULL)`
  }
] as const

const backgroundResultDeliveryIndexes = [
  {
    name: 'BackgroundResultDelivery_sessionId_state_createdAt_id_idx',
    sql: `CREATE INDEX "BackgroundResultDelivery_sessionId_state_createdAt_id_idx" ON "BackgroundResultDelivery"("sessionId", "state", "createdAt", "id")`
  },
  {
    name: 'BackgroundResultDelivery_sourceKind_state_createdAt_id_idx',
    sql: `CREATE INDEX "BackgroundResultDelivery_sourceKind_state_createdAt_id_idx" ON "BackgroundResultDelivery"("sourceKind", "state", "createdAt", "id")`
  },
  {
    name: 'BackgroundResultDelivery_sourceKind_sourceId_key',
    sql: `CREATE UNIQUE INDEX "BackgroundResultDelivery_sourceKind_sourceId_key" ON "BackgroundResultDelivery"("sourceKind", "sourceId")`
  },
  {
    name: 'BackgroundResultDelivery_project_visible_idx',
    sql: `CREATE INDEX "BackgroundResultDelivery_project_visible_idx" ON "BackgroundResultDelivery"("projectId", "updatedAt" DESC, "id") WHERE "state" IN ('waiting-result', 'pending', 'claimed', 'dispatching', 'needs-attention')`
  },
  {
    name: 'BackgroundResultDelivery_recoverable_claim_idx',
    sql: `CREATE INDEX "BackgroundResultDelivery_recoverable_claim_idx" ON "BackgroundResultDelivery"("claimExpiresAt", "id") WHERE "state" IN ('claimed', 'dispatching')`
  }
] as const

const backgroundResultDeliveryMigration = {
  id: '0034_background_result_delivery',
  statements: [
    `CREATE TABLE "BackgroundResultDelivery" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sourceKind" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "agentFrameId" TEXT,
      "state" TEXT NOT NULL,
      "attemptCount" INTEGER NOT NULL DEFAULT 0,
      "claimToken" TEXT,
      "claimExpiresAt" DATETIME,
      "continuationMessageId" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "BackgroundResultDelivery_sourceKind_check" CHECK ("sourceKind" IN ('local-run', 'compute-job')),
      CONSTRAINT "BackgroundResultDelivery_state_check" CHECK ("state" IN ('waiting-result', 'pending', 'claimed', 'dispatching', 'consumed', 'needs-attention')),
      CONSTRAINT "BackgroundResultDelivery_identity_check" CHECK (length(trim("id")) > 0 AND length(trim("sourceId")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sessionId")) > 0),
      CONSTRAINT "BackgroundResultDelivery_attemptCount_check" CHECK ("attemptCount" >= 0),
      CONSTRAINT "BackgroundResultDelivery_claimLifecycle_check" CHECK ((("state" IN ('claimed', 'dispatching') AND "claimToken" IS NOT NULL AND length(trim("claimToken")) > 0 AND "claimExpiresAt" IS NOT NULL) OR ("state" NOT IN ('claimed', 'dispatching') AND "claimToken" IS NULL AND "claimExpiresAt" IS NULL))),
      CONSTRAINT "BackgroundResultDelivery_continuation_check" CHECK (("continuationMessageId" IS NULL OR length(trim("continuationMessageId")) > 0) AND ("state" <> 'dispatching' OR "continuationMessageId" IS NOT NULL) AND ("state" <> 'waiting-result' OR "continuationMessageId" IS NULL))
    )`,
    ...backgroundResultDeliveryIndexes.map(({ sql }) => sql)
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'BackgroundResultDelivery' },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'BackgroundResultDelivery',
          constraints: backgroundResultDeliveryChecks
        }
      ]
    },
    { kind: 'indexes-exist', version: 1, indexes: backgroundResultDeliveryIndexes }
  ] as const
}

export {
  backgroundResultDeliveryChecks,
  backgroundResultDeliveryIndexes,
  backgroundResultDeliveryMigration
}
