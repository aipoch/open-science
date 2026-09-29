// Local replay state and writable Discussion ownership; no Session foreign keys.
const researchWorkspacesMigration = {
  id: '0047_research_workspaces',
  statements: [
    `CREATE TABLE IF NOT EXISTS "ResearchDraft" (
      "id" TEXT NOT NULL PRIMARY KEY, "projectId" TEXT NOT NULL,
      "sourceSessionId" TEXT NOT NULL, "editorId" TEXT NOT NULL,
      "revision" INTEGER NOT NULL, "state" TEXT NOT NULL DEFAULT 'active',
      "payloadJson" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "ResearchDraft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
    `CREATE INDEX IF NOT EXISTS "ResearchDraft_projectId_sourceSessionId_state_idx" ON "ResearchDraft"("projectId", "sourceSessionId", "state");`,
    `CREATE TABLE IF NOT EXISTS "ResearchSubmission" (
      "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "id" TEXT NOT NULL,
      "projectId" TEXT NOT NULL,
      "sourceSessionId" TEXT NOT NULL,
      "discussionSessionId" TEXT,
      "messageId" TEXT NOT NULL,
      "requestHash" TEXT NOT NULL,
      "payloadJson" TEXT NOT NULL,
      "state" TEXT NOT NULL DEFAULT 'queued',
      "claimToken" TEXT,
      "ownerEpoch" TEXT,
      "ownerClientId" TEXT,
      "error" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ResearchSubmission_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ResearchSubmission_id_key" ON "ResearchSubmission"("id");`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ResearchSubmission_messageId_key" ON "ResearchSubmission"("messageId");`,
    `CREATE INDEX IF NOT EXISTS "ResearchSubmission_projectId_sourceSessionId_sequence_idx" ON "ResearchSubmission"("projectId", "sourceSessionId", "sequence");`,
    `CREATE TABLE IF NOT EXISTS "ResearchWorkspace" (
    "projectId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "discussionSessionId" TEXT,
    "discussionState" TEXT NOT NULL DEFAULT 'none',
    "discussionTitle" TEXT,
    "discussionCreatedAt" DATETIME,
    "linkRevision" INTEGER NOT NULL DEFAULT 0,
    "viewJson" TEXT,
    "viewRevision" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("projectId", "sourceSessionId"),
    CONSTRAINT "ResearchWorkspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ResearchWorkspace_discussionSessionId_key" ON "ResearchWorkspace"("discussionSessionId");`,
    `CREATE TABLE IF NOT EXISTS "ReplayQuestionContext" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "contextJson" TEXT NOT NULL,
    CONSTRAINT "ReplayQuestionContext_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE INDEX IF NOT EXISTS "ReplayQuestionContext_projectId_sourceSessionId_idx" ON "ReplayQuestionContext"("projectId", "sourceSessionId");`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'ResearchDraft' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ResearchDraft',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    { kind: 'table-exists', version: 1, table: 'ResearchSubmission' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ResearchSubmission',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    { kind: 'table-exists', version: 1, table: 'ResearchWorkspace' },
    { kind: 'table-exists', version: 1, table: 'ReplayQuestionContext' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ReplayQuestionContext',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'ResearchWorkspace',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    }
  ] as const
}
export { researchWorkspacesMigration }
