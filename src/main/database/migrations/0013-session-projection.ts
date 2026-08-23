const sessionProjectionMigration = {
  id: '0013_session_projection',
  statements: [
    `CREATE TABLE "Session" (
      "number" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "id" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "presentedStatus" TEXT NOT NULL,
      "pinned" BOOLEAN NOT NULL DEFAULT false,
      "archivedAtMs" BIGINT,
      "revision" BIGINT NOT NULL DEFAULT 0,
      "activeMessageCount" INTEGER NOT NULL DEFAULT 0,
      "artifactCount" INTEGER NOT NULL DEFAULT 0,
      "filesRevision" INTEGER NOT NULL DEFAULT 0,
      "createdAtMs" BIGINT NOT NULL,
      "updatedAtMs" BIGINT NOT NULL,
      "presentedActivityAtMs" BIGINT,
      "needsStartupRecovery" BOOLEAN NOT NULL DEFAULT false,
      "sourceByteLength" BIGINT,
      "sourceMtimeMs" BIGINT,
      CONSTRAINT "Session_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "Session_identity_check" CHECK ("number" >= 1 AND length(trim("id")) > 0 AND length(trim("projectId")) > 0),
      CONSTRAINT "Session_status_check" CHECK ("status" IN ('idle', 'running', 'waiting-for-user', 'waiting-permission', 'waiting-plan-approval', 'error') AND "presentedStatus" IN ('idle', 'running', 'waiting-for-user', 'waiting-permission', 'waiting-plan-approval', 'error')),
      CONSTRAINT "Session_nonnegative_check" CHECK ("revision" >= 0 AND "activeMessageCount" >= 0 AND "artifactCount" >= 0 AND "filesRevision" >= 0 AND "createdAtMs" >= 0 AND "updatedAtMs" >= 0 AND ("archivedAtMs" IS NULL OR "archivedAtMs" >= 0) AND ("presentedActivityAtMs" IS NULL OR "presentedActivityAtMs" >= 0) AND ("sourceByteLength" IS NULL OR "sourceByteLength" >= 0) AND ("sourceMtimeMs" IS NULL OR "sourceMtimeMs" >= 0))
    )`,
    `CREATE TABLE "SessionProjectionState" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectionVersion" INTEGER NOT NULL,
      "completedAt" DATETIME NOT NULL,
      CONSTRAINT "SessionProjectionState_identity_check" CHECK ("id" = 'session-projection' AND "projectionVersion" >= 1)
    )`,
    `CREATE TABLE "PendingSessionReconciliation" (
      "sessionId" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "markedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PendingSessionReconciliation_identity_check" CHECK (length(trim("sessionId")) > 0 AND length(trim("projectId")) > 0)
    )`,
    `CREATE TABLE "SessionTurnUsage" (
      "sessionId" TEXT NOT NULL,
      "messageId" TEXT NOT NULL,
      "completedAtMs" BIGINT NOT NULL,
      "inputTokens" BIGINT NOT NULL,
      "cacheTokens" BIGINT NOT NULL,
      "outputTokens" BIGINT NOT NULL,
      "isRootFrame" BOOLEAN NOT NULL,
      PRIMARY KEY ("sessionId", "messageId"),
      CONSTRAINT "SessionTurnUsage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "SessionTurnUsage_nonnegative_check" CHECK (length(trim("messageId")) > 0 AND "completedAtMs" >= 0 AND "inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0)
    )`,
    `CREATE TABLE "SessionRun" (
      "sessionId" TEXT NOT NULL,
      "messageId" TEXT NOT NULL,
      "createdAtMs" BIGINT NOT NULL,
      PRIMARY KEY ("sessionId", "messageId"),
      CONSTRAINT "SessionRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "SessionRun_nonnegative_check" CHECK (length(trim("messageId")) > 0 AND "createdAtMs" >= 0)
    )`,
    `CREATE TABLE "SessionArtifactRef" (
      "sessionId" TEXT NOT NULL,
      "artifactId" TEXT NOT NULL,
      "artifactCreatedAtMs" BIGINT,
      PRIMARY KEY ("sessionId", "artifactId"),
      CONSTRAINT "SessionArtifactRef_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "SessionArtifactRef_identity_check" CHECK (length(trim("artifactId")) > 0 AND ("artifactCreatedAtMs" IS NULL OR "artifactCreatedAtMs" >= 0))
    )`,
    `CREATE UNIQUE INDEX "Session_id_key" ON "Session"("id")`,
    `CREATE INDEX "Session_projectId_archivedAtMs_updatedAtMs_id_idx" ON "Session"("projectId", "archivedAtMs", "updatedAtMs", "id")`,
    `CREATE INDEX "Session_archivedAtMs_updatedAtMs_id_idx" ON "Session"("archivedAtMs", "updatedAtMs", "id")`,
    `CREATE INDEX "Session_createdAtMs_idx" ON "Session"("createdAtMs")`,
    `CREATE INDEX "PendingSessionReconciliation_projectId_idx" ON "PendingSessionReconciliation"("projectId")`,
    `CREATE INDEX "SessionTurnUsage_completedAtMs_idx" ON "SessionTurnUsage"("completedAtMs")`,
    `CREATE INDEX "SessionRun_createdAtMs_idx" ON "SessionRun"("createdAtMs")`,
    `CREATE INDEX "SessionArtifactRef_artifactId_artifactCreatedAtMs_idx" ON "SessionArtifactRef"("artifactId", "artifactCreatedAtMs")`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'Session' },
    { kind: 'table-exists', version: 1, table: 'SessionProjectionState' },
    { kind: 'table-exists', version: 1, table: 'PendingSessionReconciliation' },
    { kind: 'table-exists', version: 1, table: 'SessionTurnUsage' },
    { kind: 'table-exists', version: 1, table: 'SessionRun' },
    { kind: 'table-exists', version: 1, table: 'SessionArtifactRef' }
  ] as const
}

export { sessionProjectionMigration }
