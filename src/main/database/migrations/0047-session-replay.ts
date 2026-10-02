// Session viewing state and immutable selections; Session history remains in its existing store.
// Project ownership provides cleanup without tying these rows to the rebuildable Session index.
export const sessionReplayMigration = {
  id: '0047_session_replay',
  statements: [
    `CREATE TABLE "SessionReplayProgress" (
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "stateJson" TEXT,
      "revision" INTEGER NOT NULL DEFAULT 0,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("projectId", "sessionId"),
      CONSTRAINT "SessionReplayProgress_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
    `CREATE TABLE "SessionDiscussionSnapshot" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "sourceProjectId" TEXT NOT NULL,
      "sourceSessionId" TEXT NOT NULL,
      "contextJson" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SessionDiscussionSnapshot_sourceProjectId_fkey" FOREIGN KEY ("sourceProjectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
    `CREATE INDEX "SessionDiscussionSnapshot_sourceProjectId_sourceSessionId_idx" ON "SessionDiscussionSnapshot"("sourceProjectId", "sourceSessionId");`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'SessionReplayProgress' },
    { kind: 'table-exists', version: 1, table: 'SessionDiscussionSnapshot' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'SessionReplayProgress',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'SessionDiscussionSnapshot',
      column: 'sourceProjectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    }
  ] as const
}
