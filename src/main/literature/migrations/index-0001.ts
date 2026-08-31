const LITERATURE_INDEX_SCHEMA_VERSION = 1

const literatureIndexSchemaStatements = [
  `CREATE TABLE "LiteratureIndexDocument" (
    "extractionId" TEXT NOT NULL PRIMARY KEY,
    "documentChecksum" TEXT NOT NULL,
    "extractorFingerprint" TEXT NOT NULL,
    "indexSchemaVersion" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "lastAccessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiteratureIndexDocument_checksum_check" CHECK (length("documentChecksum") = 64 AND "documentChecksum" NOT GLOB '*[^0-9a-f]*' AND length("extractorFingerprint") = 64 AND "extractorFingerprint" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "LiteratureIndexDocument_shape_check" CHECK ("indexSchemaVersion" >= 1 AND "chunkCount" >= 0)
  )`,
  `CREATE TABLE "LiteratureIndexChunk" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "extractionId" TEXT NOT NULL,
    "pageStart" INTEGER NOT NULL,
    "pageEnd" INTEGER NOT NULL,
    "textStart" INTEGER NOT NULL,
    "textEnd" INTEGER NOT NULL,
    "sectionTitle" TEXT,
    "content" TEXT NOT NULL,
    "contentChecksum" TEXT NOT NULL,
    CONSTRAINT "LiteratureIndexChunk_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "LiteratureIndexDocument" ("extractionId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LiteratureIndexChunk_shape_check" CHECK ("pageStart" >= 1 AND "pageEnd" >= "pageStart" AND "textStart" >= 0 AND "textEnd" >= "textStart" AND length("content") > 0),
    CONSTRAINT "LiteratureIndexChunk_checksum_check" CHECK (length("contentChecksum") = 64 AND "contentChecksum" NOT GLOB '*[^0-9a-f]*')
  )`,
  `CREATE INDEX "LiteratureIndexChunk_extractionId_pageStart_idx" ON "LiteratureIndexChunk"("extractionId", "pageStart")`,
  `CREATE VIRTUAL TABLE "LiteratureIndexChunkFts" USING fts5(
    "sectionTitle",
    "content",
    content='LiteratureIndexChunk',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  )`,
  `CREATE TRIGGER "LiteratureIndexChunk_after_insert" AFTER INSERT ON "LiteratureIndexChunk" BEGIN
    INSERT INTO "LiteratureIndexChunkFts"("rowid", "sectionTitle", "content")
    VALUES (new."id", new."sectionTitle", new."content");
  END`,
  `CREATE TRIGGER "LiteratureIndexChunk_after_delete" AFTER DELETE ON "LiteratureIndexChunk" BEGIN
    INSERT INTO "LiteratureIndexChunkFts"("LiteratureIndexChunkFts", "rowid", "sectionTitle", "content")
    VALUES ('delete', old."id", old."sectionTitle", old."content");
  END`,
  `CREATE TRIGGER "LiteratureIndexChunk_after_update" AFTER UPDATE ON "LiteratureIndexChunk" BEGIN
    INSERT INTO "LiteratureIndexChunkFts"("LiteratureIndexChunkFts", "rowid", "sectionTitle", "content")
    VALUES ('delete', old."id", old."sectionTitle", old."content");
    INSERT INTO "LiteratureIndexChunkFts"("rowid", "sectionTitle", "content")
    VALUES (new."id", new."sectionTitle", new."content");
  END`
] as const

const literatureIndexSchemaObjects = [
  'LiteratureIndexDocument',
  'LiteratureIndexChunk',
  'LiteratureIndexChunkFts',
  'LiteratureIndexChunk_after_insert',
  'LiteratureIndexChunk_after_delete',
  'LiteratureIndexChunk_after_update'
] as const

export {
  LITERATURE_INDEX_SCHEMA_VERSION,
  literatureIndexSchemaObjects,
  literatureIndexSchemaStatements
}
