/* Immutable private Bookmark persistence migration. */
const bookmarksMigration = {
  id: '0041_bookmarks',
  statements: [
    `CREATE TABLE "bookmarks" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "sourceKind" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      "sourceJson" TEXT NOT NULL,
      "selectorJson" TEXT NOT NULL,
      "quote" TEXT,
      "note" TEXT NOT NULL DEFAULT '',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "bookmarks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "bookmarks_identity_check" CHECK (length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sessionId")) > 0 AND length(trim("sourceId")) > 0),
      CONSTRAINT "bookmarks_kind_check" CHECK ("kind" IN ('text', 'pdf-text', 'pdf-region') AND "sourceKind" IN ('agent-message', 'session-item', 'project-file', 'artifact-version', 'upload-version', 'literature-attachment-version')),
      CONSTRAINT "bookmarks_json_check" CHECK (json_valid("sourceJson") AND json_type("sourceJson") = 'object' AND json_valid("selectorJson") AND json_type("selectorJson") = 'object' AND length("sourceJson") <= 65536 AND length("selectorJson") <= 65536),
      CONSTRAINT "bookmarks_content_check" CHECK (length("note") <= 2000 AND ("quote" IS NULL OR length("quote") BETWEEN 1 AND 4000) AND ("kind" != 'text' OR "quote" IS NOT NULL))
    )`,
    `CREATE INDEX "bookmarks_projectId_sessionId_createdAt_id_idx" ON "bookmarks"("projectId", "sessionId", "createdAt", "id")`,
    `CREATE INDEX "bookmarks_projectId_sessionId_sourceKind_sourceId_idx" ON "bookmarks"("projectId", "sessionId", "sourceKind", "sourceId")`
  ] as const,
  operations: [] as const,
  verifiers: [
    { kind: 'table-exists', version: 1, table: 'bookmarks' },
    {
      kind: 'foreign-key-exists',
      version: 2,
      table: 'bookmarks',
      column: 'projectId',
      referencedTable: 'Project',
      referencedColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    },
    {
      kind: 'indexes-exist',
      version: 1,
      indexes: [
        {
          name: 'bookmarks_projectId_sessionId_createdAt_id_idx',
          sql: 'CREATE INDEX "bookmarks_projectId_sessionId_createdAt_id_idx" ON "bookmarks"("projectId", "sessionId", "createdAt", "id")'
        },
        {
          name: 'bookmarks_projectId_sessionId_sourceKind_sourceId_idx',
          sql: 'CREATE INDEX "bookmarks_projectId_sessionId_sourceKind_sourceId_idx" ON "bookmarks"("projectId", "sessionId", "sourceKind", "sourceId")'
        }
      ]
    },
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'bookmarks',
          constraints: [
            {
              name: 'bookmarks_identity_check',
              expression:
                'length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sessionId")) > 0 AND length(trim("sourceId")) > 0'
            },
            {
              name: 'bookmarks_kind_check',
              expression:
                "\"kind\" IN ('text', 'pdf-text', 'pdf-region') AND \"sourceKind\" IN ('agent-message', 'session-item', 'project-file', 'artifact-version', 'upload-version', 'literature-attachment-version')"
            },
            {
              name: 'bookmarks_json_check',
              expression:
                'json_valid("sourceJson") AND json_type("sourceJson") = \'object\' AND json_valid("selectorJson") AND json_type("selectorJson") = \'object\' AND length("sourceJson") <= 65536 AND length("selectorJson") <= 65536'
            },
            {
              name: 'bookmarks_content_check',
              expression:
                'length("note") <= 2000 AND ("quote" IS NULL OR length("quote") BETWEEN 1 AND 4000) AND ("kind" != \'text\' OR "quote" IS NOT NULL)'
            }
          ]
        }
      ]
    }
  ] as const
}

export { bookmarksMigration }
