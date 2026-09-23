/* Immutable smart-collection storage; ordinary collections are unchanged. */
const literatureSmartCollectionsMigration = {
  id: '0044_literature_smart_collections',
  statements: [
    `CREATE TABLE "LiteratureSmartCollection" (
    "collectionId" TEXT NOT NULL PRIMARY KEY,
    "scopeKind" TEXT NOT NULL,
    "scopeId" TEXT,
    "ruleRevision" INTEGER NOT NULL DEFAULT 1,
    "evidenceMode" TEXT NOT NULL DEFAULT 'abstract',
    "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
    "automaticPauseReason" TEXT,
    CONSTRAINT "LiteratureSmartCollection_pause_check" CHECK ("automaticPauseReason" IS NULL OR "automaticPauseReason" IN ('run-limit', 'daily-limit', 'storage-error', 'interrupted')),
    CONSTRAINT "LiteratureSmartCollection_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "LiteratureCollection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartCollection_scope_check" CHECK ("scopeKind" IN ('library', 'project', 'collection') AND (("scopeKind" = 'library' AND "scopeId" IS NULL) OR ("scopeKind" != 'library' AND "scopeId" IS NOT NULL AND length(trim("scopeId")) > 0)) AND "ruleRevision" > 0)
);`,
    `CREATE TABLE "LiteratureSmartAssessment" (
    "collectionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "ruleRevision" INTEGER NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "probabilitiesJson" TEXT NOT NULL DEFAULT '{}',
    "evidenceJson" TEXT,
    "model" TEXT NOT NULL,
    "evaluatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("collectionId", "itemId"),
    CONSTRAINT "LiteratureSmartAssessment_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "LiteratureSmartCollection" ("collectionId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartAssessment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartAssessment_decision_check" CHECK ("verdict" IN ('match', 'no-match', 'uncertain') AND "ruleRevision" > 0 AND json_valid("probabilitiesJson") AND json_type("probabilitiesJson") = 'object')
);`,
    `CREATE TABLE "LiteratureSmartOverride" (
    "collectionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("collectionId", "itemId"),
    CONSTRAINT "LiteratureSmartOverride_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "LiteratureSmartCollection" ("collectionId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartOverride_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "LiteratureItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartOverride_decision_check" CHECK ("decision" IN ('include', 'exclude'))
);`,
    `CREATE TABLE "LiteratureSmartRuleRevision" (
    "collectionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "inclusionCriteria" TEXT NOT NULL,
    "exclusionCriteria" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeId" TEXT,
    "evidenceMode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("collectionId", "revision"),
    CONSTRAINT "LiteratureSmartRuleRevision_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "LiteratureSmartCollection" ("collectionId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartRuleRevision_values_check" CHECK ("revision" > 0 AND length(trim("inclusionCriteria")) > 0 AND "evidenceMode" IN ('abstract', 'full-text') AND "scopeKind" IN ('library', 'project', 'collection') AND (("scopeKind" = 'library' AND "scopeId" IS NULL) OR ("scopeKind" != 'library' AND "scopeId" IS NOT NULL)))
);`,
    `CREATE TABLE "LiteratureSmartRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "ruleRevision" INTEGER NOT NULL,
    "policyKey" TEXT NOT NULL,
    "snapshotJson" TEXT,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LiteratureSmartRun_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "LiteratureSmartCollection" ("collectionId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartRun_collectionId_ruleRevision_fkey" FOREIGN KEY ("collectionId", "ruleRevision") REFERENCES "LiteratureSmartRuleRevision" ("collectionId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartRun_state_check" CHECK ("kind" IN ('preview', 'refresh') AND "state" IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted') AND "ruleRevision" > 0)
);`,
    `CREATE TABLE "LiteratureSmartRunItem" (
    "runId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "failure" TEXT,
    "deferred" BOOLEAN NOT NULL DEFAULT false,
    "resultJson" TEXT,
    "evaluatedAt" DATETIME,
    PRIMARY KEY ("runId", "itemId"),
    CONSTRAINT "LiteratureSmartRunItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "LiteratureSmartRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureSmartRunItem_values_check" CHECK ("state" IN ('pending', 'done', 'error') AND ("failure" IS NULL OR "failure" IN ('auth', 'rate-limit', 'timeout', 'network', 'invalid-response', 'configuration', 'service', 'unknown')) AND ("resultJson" IS NULL OR (json_valid("resultJson") AND json_type("resultJson") = 'object')))
);`,
    `CREATE INDEX "LiteratureSmartRunItem_itemId_evaluatedAt_idx" ON "LiteratureSmartRunItem"("itemId", "evaluatedAt");`,
    `CREATE INDEX "LiteratureSmartRunItem_runId_state_idx" ON "LiteratureSmartRunItem"("runId", "state");`,
    `CREATE TABLE "ClassificationUsage" (
    "eventId" TEXT NOT NULL PRIMARY KEY,
    "collectionId" TEXT,
    "runId" TEXT,
    "scenario" TEXT NOT NULL,
    "projectId" TEXT,
    "sessionId" TEXT,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "inputTokens" BIGINT,
    "outputTokens" BIGINT,
    "usageIncomplete" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ClassificationUsage_values_check" CHECK (
      length(trim("eventId")) > 0 AND length(trim("providerId")) > 0 AND length(trim("model")) > 0
      AND "scenario" IN ('save-validation', 'probe', 'capability-selection', 'reading-route', 'literature-live-preview', 'literature-trial', 'literature-update', 'literature-reevaluate', 'literature-automatic', 'legacy-classification')
      AND "status" IN ('started', 'completed', 'failed', 'interrupted')
      AND (("inputTokens" IS NULL AND "outputTokens" IS NULL AND "usageIncomplete" = true)
        OR ("inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL AND "inputTokens" >= 0 AND "outputTokens" >= 0 AND "usageIncomplete" = false))
    )
);`,
    // Prisma's SQLite DateTime storage uses epoch milliseconds; preserve the source precision.
    `INSERT INTO "ClassificationUsage" ("eventId", "sessionId", "scenario", "providerId", "model", "occurredAt", "status", "inputTokens", "outputTokens", "usageIncomplete")
     SELECT 'legacy:' || length("sessionId") || ':' || "sessionId" || "eventId", "sessionId", 'legacy-classification', COALESCE("providerId", 'unknown'), COALESCE("model", 'unknown'), "completedAtMs", 'completed', "inputTokens" + "cacheTokens", "outputTokens", false
     FROM "SessionAuxiliaryTurnUsage" WHERE "source" = 'classification';`,
    `DELETE FROM "SessionAuxiliaryTurnUsage" WHERE "source" = 'classification';`,
    `CREATE INDEX "ClassificationUsage_sessionId_idx" ON "ClassificationUsage"("sessionId");`,
    `CREATE INDEX "ClassificationUsage_occurredAt_idx" ON "ClassificationUsage"("occurredAt");`,
    `CREATE INDEX "ClassificationUsage_collectionId_idx" ON "ClassificationUsage"("collectionId");`,
    `CREATE INDEX "ClassificationUsage_runId_idx" ON "ClassificationUsage"("runId");`,
    `CREATE INDEX "LiteratureSmartAssessment_itemId_idx" ON "LiteratureSmartAssessment"("itemId");`,
    `CREATE INDEX "LiteratureSmartOverride_itemId_idx" ON "LiteratureSmartOverride"("itemId");`,
    `CREATE INDEX "LiteratureSmartRun_collectionId_createdAt_idx" ON "LiteratureSmartRun"("collectionId", "createdAt");`
  ],
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'LiteratureSmartRunItem' },
    { kind: 'table-exists', version: 1, table: 'LiteratureSmartRuleRevision' },
    { kind: 'table-exists', version: 1, table: 'ClassificationUsage' },
    { kind: 'table-exists', version: 1, table: 'LiteratureSmartCollection' },
    { kind: 'table-exists', version: 1, table: 'LiteratureSmartAssessment' },
    { kind: 'table-exists', version: 1, table: 'LiteratureSmartOverride' },
    { kind: 'table-exists', version: 1, table: 'LiteratureSmartRun' },
    {
      kind: 'column-exists',
      version: 1,
      table: 'LiteratureSmartCollection',
      column: 'evidenceMode'
    },
    { kind: 'column-exists', version: 1, table: 'LiteratureSmartCollection', column: 'autoUpdate' },
    {
      kind: 'column-exists',
      version: 1,
      table: 'LiteratureSmartAssessment',
      column: 'evidenceJson'
    },
    { kind: 'column-exists', version: 1, table: 'LiteratureSmartRun', column: 'snapshotJson' }
  ],
  operations: []
} as const

export { literatureSmartCollectionsMigration }
