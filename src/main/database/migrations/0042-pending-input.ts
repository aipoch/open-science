/* Immutable durable user input migration. */
const pendingInputMigration = {
  id: '0042_pending_input',
  statements: [
    `CREATE TABLE IF NOT EXISTS "PendingInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "phase" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "error" TEXT,
    CONSTRAINT "PendingInput_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE INDEX IF NOT EXISTS "PendingInput_sessionId_position_id_idx" ON "PendingInput"("sessionId", "position", "id");`,
    `CREATE INDEX IF NOT EXISTS "PendingInput_projectId_idx" ON "PendingInput"("projectId");`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'PendingInput', column: 'content' }
  ] as const
}

export { pendingInputMigration }
