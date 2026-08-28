const auxiliaryTurnUsageIndexes = [
  {
    name: 'SessionAuxiliaryTurnUsage_completedAtMs_idx',
    sql: `CREATE INDEX "SessionAuxiliaryTurnUsage_completedAtMs_idx" ON "SessionAuxiliaryTurnUsage"("completedAtMs")`
  }
] as const

const sessionAuxiliaryTurnUsageMigration = {
  id: '0018_session_auxiliary_turn_usage',
  statements: [
    `CREATE TABLE "SessionAuxiliaryTurnUsage" (
      "sessionId" TEXT NOT NULL,
      "eventId" TEXT NOT NULL,
      "source" TEXT NOT NULL,
      "frameworkId" TEXT NOT NULL,
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
      CONSTRAINT "SessionAuxiliaryTurnUsage_source_check" CHECK ("source" IN ('reviewer', 'side-chat', 'vision', 'session-details', 'host-llm', 'artifact-code-reconstruction', 'context-compaction')),
      CONSTRAINT "SessionAuxiliaryTurnUsage_nonnegative_check" CHECK ("completedAtMs" >= 0 AND "inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("modelCallCount" IS NULL OR "modelCallCount" > 0))
    )`,
    ...auxiliaryTurnUsageIndexes.map(({ sql }) => sql)
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'SessionAuxiliaryTurnUsage' },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'SessionAuxiliaryTurnUsage',
          constraints: [
            {
              name: 'SessionAuxiliaryTurnUsage_identity_check',
              expression: `length(trim("sessionId")) > 0 AND length(trim("eventId")) > 0 AND length(trim("frameworkId")) > 0 AND ("model" IS NULL OR length(trim("model")) > 0)`
            },
            {
              name: 'SessionAuxiliaryTurnUsage_source_check',
              expression: `"source" IN ('reviewer', 'side-chat', 'vision', 'session-details', 'host-llm', 'artifact-code-reconstruction', 'context-compaction')`
            },
            {
              name: 'SessionAuxiliaryTurnUsage_nonnegative_check',
              expression: `"completedAtMs" >= 0 AND "inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("modelCallCount" IS NULL OR "modelCallCount" > 0)`
            }
          ]
        }
      ]
    },
    { kind: 'indexes-exist', version: 1, indexes: auxiliaryTurnUsageIndexes }
  ] as const
}

export { sessionAuxiliaryTurnUsageMigration }
