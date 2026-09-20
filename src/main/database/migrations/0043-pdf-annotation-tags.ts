// The maintainer confirmed pre-release PDF tag names are test data: no name backfill.
const pdfAnnotationTagsMigration = {
  id: '0043_pdf_annotation_tags',
  statements: [
    `CREATE TABLE "pdf_annotations_next" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "projectId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "sourceSessionId" TEXT,
      "sourceKind" TEXT NOT NULL,
      "sourceFileId" TEXT NOT NULL,
      "versionId" TEXT NOT NULL,
      "checksum" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "selectorJson" TEXT NOT NULL,
      "color" TEXT,
      "note" TEXT NOT NULL DEFAULT '',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL,
      CONSTRAINT "pdf_annotations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "PdfAnnotation_identity_check" CHECK (length(trim("id")) > 0 AND length(trim("projectId")) > 0 AND length(trim("sourceFileId")) > 0 AND length(trim("versionId")) > 0 AND length(trim("name")) > 0 AND length(trim("path")) > 0 AND length(trim("sessionId")) > 0),
      CONSTRAINT "PdfAnnotation_source_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version', 'literature-attachment-version') AND length("checksum") = 64 AND "checksum" NOT GLOB '*[^0-9a-f]*'),
      CONSTRAINT "PdfAnnotation_kind_check" CHECK ("kind" IN ('highlight', 'underline', 'squiggly', 'strikethrough', 'area', 'page-note', 'document-note') AND ("color" IS NULL OR "color" IN ('yellow', 'blue', 'green', 'pink', 'purple'))),
      CONSTRAINT "PdfAnnotation_json_check" CHECK (json_valid("selectorJson") AND json_type("selectorJson") = 'object' AND length("selectorJson") <= 65536),
      CONSTRAINT "PdfAnnotation_content_check" CHECK (length("note") <= 20000)
    )`,
    `INSERT INTO "pdf_annotations_next" ("id", "projectId", "sessionId", "sourceSessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "name", "path", "kind", "selectorJson", "color", "note", "createdAt", "updatedAt") SELECT "id", "projectId", "sessionId", "sourceSessionId", "sourceKind", "sourceFileId", "versionId", "checksum", "name", "path", "kind", "selectorJson", "color", "note", "createdAt", "updatedAt" FROM "pdf_annotations"`,
    `DROP TABLE "pdf_annotations"`,
    `ALTER TABLE "pdf_annotations_next" RENAME TO "pdf_annotations"`,
    `CREATE INDEX "pdf_annotations_projectId_sessionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sessionId", "createdAt", "id")`,
    `CREATE INDEX "pdf_annotations_projectId_sourceKind_sourceFileId_versionId_createdAt_id_idx" ON "pdf_annotations"("projectId", "sourceKind", "sourceFileId", "versionId", "createdAt", "id")`
  ] as const,
  operations: [] as const,
  verifiers: [
    {
      kind: 'check-constraints-exist',
      version: 1,
      tables: [
        {
          table: 'pdf_annotations',
          constraints: [
            {
              name: 'PdfAnnotation_json_check',
              expression: `json_valid("selectorJson") AND json_type("selectorJson") = 'object' AND length("selectorJson") <= 65536`
            }
          ]
        }
      ]
    }
  ] as const
} as const
export { pdfAnnotationTagsMigration }
