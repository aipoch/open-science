// Frozen fork migrations; used only to recognize and upgrade their exact released ledgers.
// Derived display history; existing authoritative Session files are unchanged.
// Append after the upstream migrations; never reuse a released upstream number.
const sessionHistoryMigration = {
  id: '0059_session_history',
  statements: [
    `CREATE TABLE IF NOT EXISTS "SessionHistoryIndex" (
    "sessionId" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "headerJson" TEXT NOT NULL,
    "totalItems" INTEGER NOT NULL
);`,
    `CREATE TABLE IF NOT EXISTS "SessionHistoryItem" (
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "ordinal" INTEGER,
    "promptMessageId" TEXT,
    "groupId" TEXT,
    "payloadJson" TEXT NOT NULL,

    PRIMARY KEY ("sessionId", "kind", "itemId"),
    CONSTRAINT "SessionHistoryItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "SessionHistoryIndex" ("sessionId") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE INDEX IF NOT EXISTS "SessionHistoryIndex_projectId_idx" ON "SessionHistoryIndex"("projectId");`,
    `CREATE INDEX IF NOT EXISTS "SessionHistoryItem_sessionId_ordinal_idx" ON "SessionHistoryItem"("sessionId", "ordinal");`
  ],
  operations: [],
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'SessionHistoryIndex' },
    { kind: 'table-exists', version: 1, table: 'SessionHistoryItem' },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'SessionHistoryItem_sessionId_ordinal_idx',
          sql: 'CREATE INDEX "SessionHistoryItem_sessionId_ordinal_idx" ON "SessionHistoryItem"("sessionId", "ordinal")'
        }
      ]
    }
  ]
} as const

// The personal fork shipped history as 0051 before upstream assigned that number. Only an exact,
// complete released ledger is bridged, and the DDL/verifier bytes below stay frozen.
const legacySessionHistoryMigration = {
  ...sessionHistoryMigration,
  id: '0051_session_history'
} as const

// An intermediate local build briefly used history as 0058 before upstream assigned that number to
// schedules. Only an exact, complete released local ledger is bridged; its DDL bytes stay frozen.
const jsonlSessionHistory0058Migration = {
  ...sessionHistoryMigration,
  id: '0058_session_history'
} as const

// Frozen intermediate fork release. Upstream later assigned 0055 to a different migration, so the
// current history migration moved to 0059 and this exact released row is bridged before upgrade.
const jsonlSessionHistory0055Migration = {
  ...sessionHistoryMigration,
  id: '0055_session_history'
} as const

export {
  jsonlSessionHistory0055Migration,
  jsonlSessionHistory0058Migration,
  legacySessionHistoryMigration,
  sessionHistoryMigration
}
