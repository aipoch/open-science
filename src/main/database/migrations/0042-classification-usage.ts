/* Immutable migration: extend classifier usage sources without rewriting historical measurements. */
const classificationUsageMigration = {
  id: '0042_classification_usage',
  statements: [
    `CREATE TABLE "new_SessionAuxiliaryTurnUsage" (
    "sessionId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "providerId" TEXT,
    "model" TEXT,
    "completedAtMs" BIGINT NOT NULL,
    "inputTokens" BIGINT NOT NULL,
    "cacheTokens" BIGINT NOT NULL,
    "cachedReadTokens" BIGINT,
    "cachedWriteTokens" BIGINT,
    "outputTokens" BIGINT NOT NULL,
    "modelCallCount" INTEGER,

    PRIMARY KEY ("sessionId", "eventId"),
    CONSTRAINT "SessionAuxiliaryTurnUsage_identity_check" CHECK (length(trim("sessionId")) > 0 AND length(trim("eventId")) > 0 AND length(trim("frameworkId")) > 0 AND ("model" IS NULL OR length(trim("model")) > 0)),
    CONSTRAINT "SessionAuxiliaryTurnUsage_source_check" CHECK ("source" IN ('reviewer', 'side-chat', 'vision', 'session-details', 'host-llm', 'artifact-code-reconstruction', 'context-compaction', 'classification')),
    CONSTRAINT "SessionAuxiliaryTurnUsage_nonnegative_check" CHECK ("completedAtMs" >= 0 AND "inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" IS NOT NULL AND "cachedWriteTokens" IS NOT NULL AND "cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("modelCallCount" IS NULL OR "modelCallCount" > 0))
);`,
    'INSERT INTO "new_SessionAuxiliaryTurnUsage" SELECT * FROM "SessionAuxiliaryTurnUsage"',
    'DROP TABLE "SessionAuxiliaryTurnUsage"',
    'ALTER TABLE "new_SessionAuxiliaryTurnUsage" RENAME TO "SessionAuxiliaryTurnUsage"',
    'CREATE INDEX "SessionAuxiliaryTurnUsage_completedAtMs_idx" ON "SessionAuxiliaryTurnUsage"("completedAtMs")'
  ],
  operations: [],
  verifiers: [
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'SessionAuxiliaryTurnUsage',
          constraints: [
            {
              name: 'SessionAuxiliaryTurnUsage_source_check',
              expression: `"source" IN ('reviewer', 'side-chat', 'vision', 'session-details', 'host-llm', 'artifact-code-reconstruction', 'context-compaction', 'classification')`
            }
          ]
        }
      ]
    }
  ]
} as const

export { classificationUsageMigration }
