// One unreleased migration owns translation editions, usage, and layouts.
const literatureTranslationMigration = {
  id: '0050_literature_translation',
  statements: [
    `CREATE TABLE IF NOT EXISTS "PdfTranslationUsage" (
    "eventId" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attachmentVersionId" TEXT,
    "sourceIndex" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "status" TEXT NOT NULL,
    "inputTokens" BIGINT,
    "cacheTokens" BIGINT,
    "cachedReadTokens" BIGINT,
    "cachedWriteTokens" BIGINT,
    "outputTokens" BIGINT,
    "usageIncomplete" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "PdfTranslationUsage_values_check" CHECK (length(trim("eventId")) > 0 AND length(trim("runId")) > 0 AND "sourceIndex" >= 0 AND length(trim("providerId")) > 0 AND length(trim("frameworkId")) > 0 AND length(trim("model")) > 0 AND "status" IN ('started', 'completed', 'failed', 'interrupted') AND (("inputTokens" IS NULL AND "cacheTokens" IS NULL AND "outputTokens" IS NULL AND "cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL AND "usageIncomplete" = true) OR ("inputTokens" IS NOT NULL AND "cacheTokens" IS NOT NULL AND "outputTokens" IS NOT NULL AND "inputTokens" >= 0 AND "cacheTokens" >= 0 AND "outputTokens" >= 0 AND "usageIncomplete" = false AND (("cachedReadTokens" IS NULL AND "cachedWriteTokens" IS NULL) OR ("cachedReadTokens" IS NOT NULL AND "cachedWriteTokens" IS NOT NULL AND "cachedReadTokens" >= 0 AND "cachedWriteTokens" >= 0 AND "cachedReadTokens" + "cachedWriteTokens" = "cacheTokens")))))
);`,
    `CREATE TABLE IF NOT EXISTS "PdfTranslation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pdfDocumentId" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "revision" INTEGER NOT NULL,
    "layoutSnapshotJson" TEXT,
    "payloadJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PdfTranslation_pdfDocumentId_fkey" FOREIGN KEY ("pdfDocumentId") REFERENCES "PdfDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PdfTranslation_identity_check" CHECK (length(trim("id")) > 0 AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*' AND "sizeBytes" >= 0 AND "revision" > 0),
    CONSTRAINT "PdfTranslation_payload_check" CHECK (json_valid("payloadJson") AND json_type("payloadJson") = 'object' AND length("payloadJson") <= 8388608)
);`,
    `CREATE TABLE IF NOT EXISTS "PdfTranslationBlock" (
    "translationId" TEXT NOT NULL,
    "sourceIndex" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "translation" TEXT,

    PRIMARY KEY ("translationId", "sourceIndex"),
    CONSTRAINT "PdfTranslationBlock_translationId_fkey" FOREIGN KEY ("translationId") REFERENCES "PdfTranslation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PdfTranslationBlock_values_check" CHECK ("sourceIndex" >= -1 AND "sourceIndex" < 10000 AND "revision" > 0 AND (("sourceIndex" = -1 AND "translation" IS NULL) OR ("sourceIndex" >= 0 AND ("translation" IS NULL OR (length(trim("translation")) > 0 AND length("translation") <= 100000)))))
);`,
    `CREATE INDEX IF NOT EXISTS "PdfTranslationUsage_occurredAt_idx" ON "PdfTranslationUsage"("occurredAt");`,
    `CREATE INDEX IF NOT EXISTS "PdfTranslationUsage_runId_idx" ON "PdfTranslationUsage"("runId");`,
    `CREATE INDEX IF NOT EXISTS "PdfTranslationUsage_attachmentVersionId_idx" ON "PdfTranslationUsage"("attachmentVersionId");`,
    `CREATE INDEX IF NOT EXISTS "PdfTranslation_pdfDocumentId_createdAt_id_idx" ON "PdfTranslation"("pdfDocumentId", "createdAt", "id");`
  ],
  operations: [],
  verifiers: [
    { kind: 'column-exists', version: 1, table: 'PdfTranslation', column: 'layoutSnapshotJson' },
    { kind: 'table-exists', version: 1, table: 'PdfTranslationBlock' },
    { kind: 'table-exists', version: 1, table: 'PdfTranslationUsage' },
    { kind: 'column-exists', version: 1, table: 'PdfTranslation', column: 'pdfDocumentId' },
    { kind: 'column-exists', version: 1, table: 'PdfTranslation', column: 'createdAt' }
  ]
} as const

export { literatureTranslationMigration }
