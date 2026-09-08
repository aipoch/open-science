const literatureInboxIntegrityIndexes = [
  {
    name: 'LiteratureCandidateDiscovery_projectId_sessionId_idx',
    sql: 'CREATE INDEX "LiteratureCandidateDiscovery_projectId_sessionId_idx" ON "LiteratureCandidateDiscovery"("projectId", "sessionId")'
  },
  {
    name: 'LiteratureCandidateDiscovery_candidateId_contextKey_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureCandidateDiscovery_candidateId_contextKey_key" ON "LiteratureCandidateDiscovery"("candidateId", "contextKey")'
  },
  {
    name: 'LiteratureSourceRecord_itemId_provider_externalId_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureSourceRecord_itemId_provider_externalId_key" ON "LiteratureSourceRecord"("itemId", "provider", "externalId")'
  },
  {
    name: 'LiteratureSourceRecord_inboxCandidateId_provider_externalId_key',
    sql: 'CREATE UNIQUE INDEX "LiteratureSourceRecord_inboxCandidateId_provider_externalId_key" ON "LiteratureSourceRecord"("inboxCandidateId", "provider", "externalId")'
  }
] as const

const literatureDiscoveryBackfillStatement = `INSERT OR IGNORE INTO "LiteratureCandidateDiscovery"
      ("id", "candidateId", "contextKey", "origin", "projectId", "sessionId", "createdAt")
      SELECT 'legacy:' || "id", "id", json_array("origin", "sourceProjectId", "sourceSessionId"),
        "origin", "sourceProjectId", "sourceSessionId", "createdAt"
      FROM "LiteratureInboxCandidate"`

const literatureInboxIntegrityMigration = {
  id: '0037_literature_inbox_integrity',
  statements: [
    `DROP INDEX IF EXISTS "LiteratureSourceRecord_provider_externalId_key"`,
    `CREATE TABLE IF NOT EXISTS "LiteratureCandidateDiscovery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "contextKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "projectId" TEXT,
    "sessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiteratureCandidateDiscovery_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "LiteratureInboxCandidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
    `CREATE INDEX IF NOT EXISTS "LiteratureCandidateDiscovery_projectId_sessionId_idx" ON "LiteratureCandidateDiscovery"("projectId", "sessionId");`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "LiteratureCandidateDiscovery_candidateId_contextKey_key" ON "LiteratureCandidateDiscovery"("candidateId", "contextKey");`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "LiteratureSourceRecord_itemId_provider_externalId_key" ON "LiteratureSourceRecord"("itemId", "provider", "externalId");`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "LiteratureSourceRecord_inboxCandidateId_provider_externalId_key" ON "LiteratureSourceRecord"("inboxCandidateId", "provider", "externalId");`,
    literatureDiscoveryBackfillStatement
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'LiteratureCandidateDiscovery' },
    { kind: 'indexes-exist', version: 1, indexes: literatureInboxIntegrityIndexes },
    {
      kind: 'indexes-absent',
      version: 1,
      names: ['LiteratureSourceRecord_provider_externalId_key']
    },
    { kind: 'foreign-key-integrity', version: 1 }
  ] as const
}

export { literatureInboxIntegrityMigration, literatureDiscoveryBackfillStatement }
