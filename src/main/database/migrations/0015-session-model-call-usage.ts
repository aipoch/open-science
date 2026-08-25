const modelCallUsageIndexes = [
  {
    name: 'SessionModelCallUsage_sessionId_messageId_callIndex_key',
    sql: `CREATE UNIQUE INDEX "SessionModelCallUsage_sessionId_messageId_callIndex_key" ON "SessionModelCallUsage"("sessionId", "messageId", "callIndex")`
  }
] as const

const sessionModelCallUsageMigration = {
  id: '0015_session_model_call_usage',
  statements: [
    `ALTER TABLE "SessionTurnUsage" ADD COLUMN "cachedReadTokens" BIGINT`,
    `ALTER TABLE "SessionTurnUsage" ADD COLUMN "cachedWriteTokens" BIGINT`,
    `ALTER TABLE "SessionTurnUsage" ADD COLUMN "modelCallCount" INTEGER`,
    `CREATE TABLE "SessionModelCallUsage" (
      "sessionId" TEXT NOT NULL,
      "messageId" TEXT NOT NULL,
      "callId" TEXT NOT NULL,
      "callIndex" INTEGER NOT NULL,
      "sourceInvocationId" TEXT,
      "frameworkId" TEXT,
      "backendId" TEXT,
      "model" TEXT,
      "inputTokens" BIGINT NOT NULL,
      "cacheTokens" BIGINT NOT NULL,
      "cachedReadTokens" BIGINT,
      "cachedWriteTokens" BIGINT,
      "outputTokens" BIGINT NOT NULL,
      "contextUsedTokens" BIGINT,
      "contextWindowSize" BIGINT,
      PRIMARY KEY ("sessionId", "callId"),
      CONSTRAINT "SessionModelCallUsage_sessionId_messageId_fkey" FOREIGN KEY ("sessionId", "messageId") REFERENCES "SessionTurnUsage" ("sessionId", "messageId") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "SessionModelCallUsage_identity_check" CHECK (length(trim("messageId")) > 0 AND length(trim("callId")) > 0 AND "callIndex" >= 0 AND ("sourceInvocationId" IS NULL OR length(trim("sourceInvocationId")) > 0) AND ("frameworkId" IS NULL OR length(trim("frameworkId")) > 0) AND ("backendId" IS NULL OR length(trim("backendId")) > 0) AND ("model" IS NULL OR length(trim("model")) > 0)),
      CONSTRAINT "SessionModelCallUsage_nonnegative_check" CHECK ("inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("contextUsedTokens" IS NULL OR "contextUsedTokens" >= 0) AND ("contextWindowSize" IS NULL OR "contextWindowSize" > 0))
    )`,
    ...modelCallUsageIndexes.map(({ sql }) => sql)
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'column-exists',
      version: 1,
      table: 'SessionTurnUsage',
      column: 'cachedReadTokens'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'SessionTurnUsage',
      column: 'cachedWriteTokens'
    },
    {
      kind: 'column-exists',
      version: 1,
      table: 'SessionTurnUsage',
      column: 'modelCallCount'
    },
    { kind: 'table-exists', version: 1, table: 'SessionModelCallUsage' },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'SessionModelCallUsage',
          constraints: [
            {
              name: 'SessionModelCallUsage_identity_check',
              expression: `length(trim("messageId")) > 0 AND length(trim("callId")) > 0 AND "callIndex" >= 0 AND ("sourceInvocationId" IS NULL OR length(trim("sourceInvocationId")) > 0) AND ("frameworkId" IS NULL OR length(trim("frameworkId")) > 0) AND ("backendId" IS NULL OR length(trim("backendId")) > 0) AND ("model" IS NULL OR length(trim("model")) > 0)`
            },
            {
              name: 'SessionModelCallUsage_nonnegative_check',
              expression: `"inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0)) AND ("contextUsedTokens" IS NULL OR "contextUsedTokens" >= 0) AND ("contextWindowSize" IS NULL OR "contextWindowSize" > 0)`
            }
          ]
        }
      ]
    },
    { kind: 'indexes-exist', version: 1, indexes: modelCallUsageIndexes }
  ] as const
}

export { sessionModelCallUsageMigration }
